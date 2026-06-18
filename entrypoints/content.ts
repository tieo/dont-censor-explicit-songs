// Runs in the page's MAIN world. Two interceptors:
//
//   1) window.fetch wrap → catch /youtubei/v1/next responses. Walk the queue,
//      extract {videoId, title, artist, duration, explicit} for each item, and
//      pre-resolve explicit swaps (search + pickExplicitSwap) in the background.
//
//   2) XMLHttpRequest.prototype.send wrap → catch /youtubei/v1/player requests.
//      The request body contains the requested videoId. Look it up in the
//      pre-resolved swap cache and rewrite to the explicit videoId before
//      forwarding. If no entry yet (cache miss), defer the send while we
//      resolve on the fly using the videoId alone (best-effort search).
//
// The /player call returns streaming URLs, so swapping its body's videoId means
// the player loads the explicit stream directly. No DOM scraping, no player-bar.

import {
  findExplicitSwap,
  buildSearchQuery,
  surfaceClass,
} from '../src/ytmusic/index.js';
import { DEFAULT_PREFS, PREFS_MESSAGE_SOURCE, type Prefs } from '../src/prefs';

export default defineContentScript({
  matches: ['*://music.youtube.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const log = (...a: unknown[]) => console.log('[uncensor]', ...a);
    log('interceptors installed (fetch + XHR)');

    // Preserve originals before anyone else can.
    const ORIG_FETCH: typeof fetch = window.fetch.bind(window);
    const ORIG_XHR_OPEN = XMLHttpRequest.prototype.open;
    const ORIG_XHR_SEND = XMLHttpRequest.prototype.send;

    // videoId → explicit videoId (or null = no swap)
    const swapCache = new Map<string, string | null>();
    // videoId → in-flight resolution promise (de-dupe)
    const pending = new Map<string, Promise<string | null>>();
    // Source videoIds whose swap drops video for audio (OMV/UGC → ATV). After
    // their /player swap we nudge the SPA into cover-art mode.
    const audioSwapForVideo = new Set<string>();

    // Live prefs, fed by the ISOLATED-world bridge over window.postMessage
    // (MAIN world can't read chrome.storage directly). Defaults until the
    // first message lands.
    let prefs: Prefs = { ...DEFAULT_PREFS };
    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      const data = e.data as { source?: string; prefs?: Prefs } | undefined;
      if (data?.source === PREFS_MESSAGE_SOURCE && data.prefs) {
        prefs = data.prefs;
        log('prefs updated', prefs);
      }
    });
    // Ask the bridge to (re)broadcast in case it posted before this listener
    // was wired.
    window.postMessage({ source: PREFS_MESSAGE_SOURCE + ':request' }, '*');

    interface TrackMeta {
      videoId: string;
      title: string;
      artist: string;
      durationSec?: number;
      explicit: boolean;
      musicVideoType?: string;
    }

    // ---- Helpers ----------------------------------------------------------

    function parseDuration(s: string | undefined): number | undefined {
      if (!s) return undefined;
      const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
      if (!m) return undefined;
      return (m[1] ? Number(m[1]) : 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    }

    function textRuns(node: unknown): string {
      const n = node as { runs?: { text?: string }[] } | undefined;
      return n?.runs?.map((r) => r.text ?? '').join('') ?? '';
    }

    // Pull the YT Music content type (ATV/OMV/UGC) from a /next queue item's
    // navigationEndpoint. Drives playback-compatible swap selection.
    function musicVideoTypeFromRenderer(r: Record<string, unknown>): string | undefined {
      const nav = r.navigationEndpoint as
        | { watchEndpoint?: { watchEndpointMusicSupportedConfigs?: { watchEndpointMusicConfig?: { musicVideoType?: string } } } }
        | undefined;
      return nav?.watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig
        ?.musicVideoType;
    }

    // Walk /next response. Items are playlistPanelVideoRenderer.
    function extractQueueMetas(json: unknown): TrackMeta[] {
      const out: TrackMeta[] = [];
      function visit(n: unknown) {
        if (!n || typeof n !== 'object') return;
        const node = n as Record<string, unknown>;
        const r = node.playlistPanelVideoRenderer as Record<string, unknown> | undefined;
        if (r && typeof r === 'object') {
          const videoId = r.videoId as string | undefined;
          const title = textRuns(r.title);
          const byline = textRuns(r.longBylineText);
          const length = textRuns(r.lengthText) || (r.lengthText as { simpleText?: string })?.simpleText;
          const durationSec = parseDuration(length as string | undefined);
          const artist = byline.split(' • ')[0]?.trim() ?? '';
          const badges =
            (r.badges as { musicInlineBadgeRenderer?: { icon?: { iconType?: string } } }[]) ?? [];
          const explicit = badges.some(
            (b) => b.musicInlineBadgeRenderer?.icon?.iconType === 'MUSIC_EXPLICIT_BADGE'
          );
          if (videoId && title && artist) {
            out.push({
              videoId,
              title,
              artist,
              durationSec,
              explicit,
              musicVideoType: musicVideoTypeFromRenderer(r),
            });
          }
        }
        for (const v of Object.values(node)) visit(v);
      }
      visit(json);
      return out;
    }

    async function resolveExplicit(meta: TrackMeta): Promise<string | null> {
      if (swapCache.has(meta.videoId)) return swapCache.get(meta.videoId)!;
      if (pending.has(meta.videoId)) return pending.get(meta.videoId)!;
      if (meta.explicit) {
        swapCache.set(meta.videoId, null);
        return null;
      }
      const p = (async () => {
        try {
          const swap = await findExplicitSwap(
            meta,
            buildSearchQuery(meta.title, meta.artist),
            { fetchImpl: ORIG_FETCH, timeoutMs: 4000 },
            { allowVideoToAudio: prefs.musicVideoAudioSwap },
          );
          const id = swap?.videoId ?? null;
          swapCache.set(meta.videoId, id);
          // A video source swapped to an audio-only (ATV) candidate must drop
          // the SPA into cover-art mode, else the player keeps the video
          // surface and shows a black frame for the audio stream.
          if (
            swap &&
            surfaceClass(meta.musicVideoType) === 'video' &&
            surfaceClass(swap.musicVideoType) === 'audio'
          ) {
            audioSwapForVideo.add(meta.videoId);
          }
          if (id) log(`prepared swap "${meta.title}" by ${meta.artist}: ${meta.videoId} → ${id}`);
          else log(`no explicit found for "${meta.title}" by ${meta.artist} (${meta.videoId})`);
          return id;
        } catch (err) {
          log('search failed', meta.videoId, err);
          swapCache.set(meta.videoId, null);
          return null;
        } finally {
          pending.delete(meta.videoId);
        }
      })();
      pending.set(meta.videoId, p);
      return p;
    }

    // When a video source was swapped to audio-only, the SPA still thinks it's
    // playing a music video and keeps the `video-mode` surface (black frame for
    // an audio stream). Strip that attribute to force cover-art mode. The SPA
    // re-asserts it as the (now audio) stream loads — and on slower machines
    // that can land several seconds later — so we watch for re-adds with a
    // MutationObserver and strip them for a bounded window, rather than betting
    // on a fixed delay being long enough.
    function forceAudioMode(): void {
      const strip = () => {
        for (const sel of ['ytmusic-player', 'ytmusic-player-page']) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            if (el.hasAttribute('video-mode')) el.removeAttribute('video-mode');
          }
        }
      };
      strip();
      const obs = new MutationObserver(strip);
      obs.observe(document.documentElement, {
        subtree: true,
        attributes: true,
        attributeFilter: ['video-mode'],
      });
      setTimeout(() => obs.disconnect(), 15000);
    }

    function isNextCall(url: string): boolean {
      return /\/youtubei\/v1\/next(\?|$)/.test(url);
    }
    function isPlayerCall(url: string): boolean {
      return /\/youtubei\/v1\/player(\?|$)/.test(url);
    }

    // ---- /next response mutation ------------------------------------------

    /**
     * Walks the /next JSON, finds each playlistPanelVideoRenderer with a known
     * swap, and stamps an explicit badge onto it. This makes the queue UI +
     * player bar #badges honest about the audio that will actually play.
     */
    function injectExplicitBadges(json: unknown): { mutated: boolean } {
      let mutated = false;
      const explicitBadge = {
        musicInlineBadgeRenderer: {
          icon: { iconType: 'MUSIC_EXPLICIT_BADGE' },
          accessibilityData: { accessibilityData: { label: 'Explicit' } },
        },
      };
      const visit = (n: unknown) => {
        if (!n || typeof n !== 'object') return;
        const node = n as Record<string, unknown>;
        const r = node.playlistPanelVideoRenderer as Record<string, unknown> | undefined;
        if (r && typeof r === 'object') {
          const videoId = r.videoId as string | undefined;
          if (videoId) {
            const swap = swapCache.get(videoId);
            if (swap && swap !== videoId) {
              // Already has explicit badge? Skip.
              const existing = (r.badges as { musicInlineBadgeRenderer?: { icon?: { iconType?: string } } }[]) ?? [];
              const hasExplicit = existing.some(
                (b) => b.musicInlineBadgeRenderer?.icon?.iconType === 'MUSIC_EXPLICIT_BADGE',
              );
              if (!hasExplicit) {
                r.badges = [...existing, explicitBadge];
                mutated = true;
              }
            }
          }
        }
        for (const v of Object.values(node)) visit(v);
      };
      visit(json);
      return { mutated };
    }

    // ---- fetch wrap (handles /next) ---------------------------------------

    const fetchWrap: typeof fetch = async function patchedFetch(input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const resp = await ORIG_FETCH(input as any, init);
      if (!isNextCall(url)) return resp;

      try {
        const cloned = resp.clone();
        const json = await cloned.json();
        const metas = extractQueueMetas(json);

        if (metas.length) {
          // Block /next on the first few items (covers what the user sees in
          // the upcoming-queue panel above the fold) and pre-warm a small
          // additional batch in the background. We deliberately do NOT fan
          // out to all 50 queue items — a swarm of concurrent searches both
          // saturates the browser's network pool (delaying the queue render
          // the SPA needs to draw) and trips Google's per-IP rate limit so
          // the few that matter get throttled. The cache-miss /player path
          // covers any item we didn't pre-resolve.
          const BLOCKING = 2;
          const BACKGROUND = 6;
          log(
            `/next: resolving ${Math.min(metas.length, BLOCKING)} blocking + ${Math.min(Math.max(metas.length - BLOCKING, 0), BACKGROUND)} background of ${metas.length} queue meta(s)...`,
          );
          const blocking = metas.slice(0, BLOCKING);
          const background = metas.slice(BLOCKING, BLOCKING + BACKGROUND);
          await Promise.all(blocking.map((m) => resolveExplicit(m).catch(() => null)));
          for (const m of background) void resolveExplicit(m).catch(() => null);
        }

        const { mutated } = injectExplicitBadges(json);
        if (mutated) {
          log(`/next: stamped explicit badges onto swapped items`);
          // Return a fresh Response so the SPA sees mutated JSON.
          return new Response(JSON.stringify(json), {
            status: resp.status,
            statusText: resp.statusText,
            headers: resp.headers,
          });
        }
      } catch (err) {
        log('failed to parse/mutate /next response', err);
      }
      return resp;
    };

    // Re-install fetch wrap whenever the SPA restores the native fetch.
    // (Live probe showed YT Music restores window.fetch to native after our
    // initial document_start patch.)
    function installFetchWrap() {
      try {
        Object.defineProperty(window, 'fetch', {
          configurable: true,
          enumerable: true,
          get() {
            return fetchWrap;
          },
          set(_v) {
            // ignore attempts to replace — keep our wrap.
          },
        });
      } catch (err) {
        log('could not install fetch wrap via defineProperty, falling back', err);
        (window as any).fetch = fetchWrap;
      }
    }
    installFetchWrap();

    // ---- XHR wrap (handles /player) ---------------------------------------

    type XHRWithMeta = XMLHttpRequest & { __url?: string; __method?: string };

    XMLHttpRequest.prototype.open = function (
      this: XHRWithMeta,
      method: string,
      url: string | URL,
      ...rest: any[]
    ) {
      this.__url = typeof url === 'string' ? url : url.href;
      this.__method = method;
      return (ORIG_XHR_OPEN as any).call(this, method, url, ...rest);
    } as typeof XMLHttpRequest.prototype.open;

    XMLHttpRequest.prototype.send = function (this: XHRWithMeta, body?: Document | BodyInit | null) {
      const url = this.__url ?? '';
      if (!isPlayerCall(url) || typeof body !== 'string') {
        return ORIG_XHR_SEND.call(this, body as any);
      }

      let parsed: any;
      try {
        parsed = JSON.parse(body);
      } catch {
        return ORIG_XHR_SEND.call(this, body);
      }
      const videoId: string | undefined = parsed?.videoId;
      if (!videoId) return ORIG_XHR_SEND.call(this, body);

      // Fast path: known swap.
      if (swapCache.has(videoId)) {
        const swap = swapCache.get(videoId);
        if (swap && swap !== videoId) {
          parsed.videoId = swap;
          const newBody = JSON.stringify(parsed);
          log(`/player swap (cache): ${videoId} → ${swap}`);
          if (audioSwapForVideo.has(videoId)) forceAudioMode();
          return ORIG_XHR_SEND.call(this, newBody);
        }
        log(`/player no swap (cache): ${videoId}`);
        return ORIG_XHR_SEND.call(this, body);
      }

      // Slow path: cache miss. Defer the send while we resolve via a minimal
      // /player ping (gives us title/artist) → search → decide. Bounded with
      // a hard wall-clock budget: if anything in this path stalls (Google
      // rate-limit, network blip), we MUST still call ORIG_XHR_SEND on the
      // original body — otherwise the SPA's XHR is dead and the player just
      // shows a spinner forever (and our e2e observer never sees a response).
      log(`/player cache miss for ${videoId}, deferring to resolve...`);
      const SLOW_PATH_BUDGET_MS = 7000;
      let xhrSent = false;
      const sendOrig = () => {
        if (xhrSent) return;
        xhrSent = true;
        ORIG_XHR_SEND.call(this, body);
      };
      const sendSwapped = (swap: string) => {
        if (xhrSent) return;
        xhrSent = true;
        parsed.videoId = swap;
        if (audioSwapForVideo.has(videoId)) forceAudioMode();
        ORIG_XHR_SEND.call(this, JSON.stringify(parsed));
      };
      const budgetTimer = setTimeout(() => {
        if (!xhrSent) log(`/player slow-path budget exceeded for ${videoId}, sending original`);
        sendOrig();
      }, SLOW_PATH_BUDGET_MS);
      void (async () => {
        try {
          const probeAc = new AbortController();
          const probeTimer = setTimeout(() => probeAc.abort(), 4000);
          let probe: Response;
          try {
            probe = await ORIG_FETCH(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body,
              credentials: 'include',
              signal: probeAc.signal,
            });
          } finally {
            clearTimeout(probeTimer);
          }
          const probeJson = await probe.json();
          const vd = probeJson?.videoDetails;
          if (vd?.title && vd?.author) {
            const meta: TrackMeta = {
              videoId,
              title: vd.title,
              artist: vd.author,
              durationSec: vd.lengthSeconds ? Number(vd.lengthSeconds) : undefined,
              explicit: false, // /player response doesn't expose badges; assume false
              musicVideoType: vd.musicVideoType,
            };
            const swap = await resolveExplicit(meta);
            if (swap && swap !== videoId) {
              log(`/player swap (resolved): ${videoId} → ${swap}`);
              clearTimeout(budgetTimer);
              sendSwapped(swap);
              return;
            }
          }
        } catch (err) {
          log('cache-miss resolution failed', err);
        }
        clearTimeout(budgetTimer);
        sendOrig();
      })();
    } as typeof XMLHttpRequest.prototype.send;
  },
});

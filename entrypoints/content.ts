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

import { search, parseSearchResponse, pickExplicitSwap, type TrackRow } from '../src/ytmusic/index.js';

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

    interface TrackMeta {
      videoId: string;
      title: string;
      artist: string;
      durationSec?: number;
      explicit: boolean;
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
            out.push({ videoId, title, artist, durationSec, explicit });
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
          const json = await search(`${meta.title} ${meta.artist}`, { fetchImpl: ORIG_FETCH });
          const rows: TrackRow[] = parseSearchResponse(json);
          const selfRow = rows.find((r) => r.videoId === meta.videoId);
          if (selfRow?.explicit) {
            swapCache.set(meta.videoId, null);
            return null;
          }
          const swap = pickExplicitSwap(meta, rows);
          const id = swap?.videoId ?? null;
          swapCache.set(meta.videoId, id);
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
          log(`/next: resolving swaps for ${metas.length} queue meta(s)...`);
          // Block until all swaps are decided. This makes /next slow on the
          // first call but the answer is then cached for /player.
          await Promise.all(metas.map((m) => resolveExplicit(m).catch(() => null)));
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
          return ORIG_XHR_SEND.call(this, newBody);
        }
        log(`/player no swap (cache): ${videoId}`);
        return ORIG_XHR_SEND.call(this, body);
      }

      // Slow path: cache miss. Defer the send while we resolve via a minimal
      // /player ping (gives us title/artist) → search → decide.
      log(`/player cache miss for ${videoId}, deferring to resolve...`);
      void (async () => {
        try {
          // Hit /player with the original body to fetch metadata cheaply via
          // ORIG_FETCH (own session). We only need videoDetails.
          const probe = await ORIG_FETCH(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            credentials: 'include',
          });
          const probeJson = await probe.json();
          const vd = probeJson?.videoDetails;
          if (vd?.title && vd?.author) {
            const meta: TrackMeta = {
              videoId,
              title: vd.title,
              artist: vd.author,
              durationSec: vd.lengthSeconds ? Number(vd.lengthSeconds) : undefined,
              explicit: false, // /player response doesn't expose badges; assume false
            };
            const swap = await resolveExplicit(meta);
            if (swap && swap !== videoId) {
              parsed.videoId = swap;
              const newBody = JSON.stringify(parsed);
              log(`/player swap (resolved): ${videoId} → ${swap}`);
              ORIG_XHR_SEND.call(this, newBody);
              return;
            }
          }
        } catch (err) {
          log('cache-miss resolution failed', err);
        }
        // Fallback: send original.
        ORIG_XHR_SEND.call(this, body);
      })();
    } as typeof XMLHttpRequest.prototype.send;
  },
});

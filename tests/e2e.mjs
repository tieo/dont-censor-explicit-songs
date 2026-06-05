// E2E tests for the uncensor extension.
//
// Truth signal: the /youtubei/v1/player XHR response that the SPA actually
// consumed (its `videoDetails.videoId`). That's the streaming data feeding
// the audio decoder, so it can't lie about what's playing.
//
// Trigger: prefer driving the SPA via its own player API
// (`document.querySelector('ytmusic-app').inst.root.playerApi`) — that's how
// the SPA internally loads tracks. Fall back to URL nav / DOM click only when
// testing those specific entry points.
//
// Test queries (not videoIds) — pairs are *discovered* at test time so nothing
// is hardcoded.

import { chromium } from 'playwright';
import { search, parseSearchResponse, buildSearchQuery } from '../src/ytmusic/index.ts';

const CDP_PORT = Number(process.env.UNCENSOR_DEV_PORT ?? 9222);
const PLAYER_RESPONSE_TIMEOUT_MS = 30_000;

const TEST_QUERIES = [
  'WAP Cardi B Megan Thee Stallion',
  'HUMBLE Kendrick Lamar',
  'rockstar Post Malone 21 Savage',
];

/* ----------------------------- discovery -------------------------------- */

async function discoverPair(query) {
  const json = await search(query);
  const rows = parseSearchResponse(json);
  for (const row of rows) {
    if (row.explicit) continue;
    const explicit = rows.find(
      (r) =>
        r.explicit &&
        r.title === row.title &&
        r.artist === row.artist &&
        r.durationSec != null &&
        row.durationSec != null &&
        Math.abs(r.durationSec - row.durationSec) <= 2,
    );
    if (explicit) return { clean: row, explicit, title: row.title, artist: row.artist, rows };
  }
  return null;
}

/* ----------------------------- player observer -------------------------- */

/**
 * Wire a /player network observer that captures every XHR response the SPA
 * consumes (filter by resourceType='xhr' to exclude our own fetch probes).
 *
 * Returns { allXhrResponses, lastXhrVideoId, waitForXhrAfter(t0, expected) }.
 */
function attachPlayerObserver(page) {
  const xhrResponses = [];
  let waiters = [];
  page.on('response', async (res) => {
    if (!res.url().includes('youtubei/v1/player')) return;
    // Filter to xhr only so we don't pick up our extension's own
    // ORIG_FETCH probe (resourceType=fetch) — that probe carries the clean
    // videoId, which would cause findLast() to incorrectly report "no swap".
    if (res.request().resourceType() !== 'xhr') return;
    try {
      const text = await res.text();
      const j = JSON.parse(text);
      xhrResponses.push({
        at: Date.now(),
        videoId: j.videoDetails?.videoId,
        title: j.videoDetails?.title,
        author: j.videoDetails?.author,
      });
      const w = waiters; waiters = [];
      w.forEach((r) => r());
    } catch {}
  });

  return {
    xhrResponses,
    /**
     * Resolve as soon as a /player XHR response received after `since`
     * arrives. Event-driven (no polling) — the observer notifies waiters when
     * a response lands.
     */
    waitForXhrAfter(since, timeoutMs = PLAYER_RESPONSE_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        const found = xhrResponses.findLast((r) => r.at >= since);
        if (found) return resolve(found);
        let timer;
        const onLand = () => {
          const hit = xhrResponses.findLast((r) => r.at >= since);
          if (hit) {
            clearTimeout(timer);
            resolve(hit);
          } else {
            waiters.push(onLand);
          }
        };
        waiters.push(onLand);
        timer = setTimeout(() => {
          waiters = waiters.filter((w) => w !== onLand);
          reject(new Error('no /player XHR response observed in time'));
        }, timeoutMs);
      });
    },
  };
}

/** Visual badge check (secondary signal — confirms what the user sees). */
async function readPlayerBarBadgeState(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('ytmusic-player-bar');
    if (!bar) return { hasBar: false };
    const title = bar.querySelector('.title.ytmusic-player-bar')?.textContent?.trim() ?? '';
    const badges = bar.querySelector('#badges');
    let hasExplicitBadge = false;
    if (badges) {
      for (const el of badges.querySelectorAll('[aria-label], [title]')) {
        const label = (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '').toLowerCase();
        if (label.includes('explicit') || label.includes('explizit')) {
          hasExplicitBadge = true;
          break;
        }
      }
    }
    return { hasBar: true, title, hasExplicitBadge };
  });
}

/* ----------------------------- entry points ----------------------------- */
// Each entry point returns the wall-clock timestamp it was triggered, so the
// observer can pick out the /player response that resulted from it.

const entryPoints = {
  /** Direct URL navigation — simulates clicking a deep link. */
  async directUrl(page, pair) {
    const t = Date.now();
    await page
      .goto(`https://music.youtube.com/watch?v=${pair.clean.videoId}`, { waitUntil: 'domcontentloaded' })
      .catch(() => {});
    return { at: t, clickedVideoId: pair.clean.videoId };
  },

  /**
   * Search via URL → click a row whose videoId is in our API's song search
   * results (so we know it's an actual song, not a dance cover / lyrics video
   * that happens to have the same title), is clean (no E badge), and which
   * the API knows has an explicit sibling.
   *
   * We search the UI by `${title} ${artist}` taken from the discovered pair
   * rather than the original test query, because discoverPair may surface a
   * different song than what the query suggested (e.g. "HUMBLE" → "Not Like
   * Us" if that's higher-ranked).
   */
  async searchAndClick(page, pair, validCleanVideoIds) {
    const uiQuery = `${pair.title} ${pair.artist}`;
    // sp= filters to the Songs section. This widens the candidate pool beyond
    // the initial Songs shelf so less-popular clean variants are reachable.
    const SONGS_FILTER_PARAM = 'EgWKAQIIAWoMEA4QChADEAQQCRAF';
    await page
      .goto(
        `https://music.youtube.com/search?q=${encodeURIComponent(uiQuery)}&sp=${SONGS_FILTER_PARAM}`,
        { waitUntil: 'domcontentloaded' },
      )
      .catch(() => {});
    // Wait until at least one search result row is in the DOM (no fixed delay).
    await page
      .waitForFunction(
        () => !!document.querySelector('ytmusic-responsive-list-item-renderer a[href*="watch?v="]'),
        { timeout: 15_000 },
      )
      .catch(() => {});
    const t = Date.now();
    const result = await page.evaluate((validIds) => {
      const validSet = new Set(validIds);
      for (const row of document.querySelectorAll('ytmusic-responsive-list-item-renderer')) {
        const playLink = row.querySelector('a[href*="watch?v="]');
        const href = playLink?.getAttribute('href') ?? '';
        const m = href.match(/[?&]v=([A-Za-z0-9_-]+)/);
        const vid = m?.[1];
        if (!vid || !validSet.has(vid)) continue;
        if (row.querySelector('ytmusic-inline-badge-renderer.explicit-badge')) continue;
        const titleLink = row.querySelector('yt-formatted-string.title a, .title a');
        (titleLink ?? playLink ?? row).click();
        return { ok: true, clickedVideoId: vid };
      }
      return { ok: false };
    }, validCleanVideoIds);
    if (!result.ok) {
      const err = new Error(
        `no API-validated clean songs row visible in search UI (looked for ${validCleanVideoIds.length} ids)`,
      );
      err.skip = true;
      throw err;
    }
    return { at: t, clickedVideoId: result.clickedVideoId };
  },

  /**
   * Click an upcoming-queue item in the SPA's up-next sidebar. Tests the
   * playlist/queue-click flow.
   *
   * We load a /watch URL of the clean track to populate the auto-radio queue,
   * then click a queue item (NOT the now-playing one). This exercises the
   * row-click→/player flow from a queue context, which is what users do when
   * they pick the next song from a playlist or up-next list.
   */
  async playlistPlay(page, pair) {
    // Use &list= to seed the auto-radio playlist (RDAMVM<videoId>). This is
    // what gives us multiple queue items in the up-next panel (without it,
    // the SPA only shows the now-playing item).
    const listId = `RDAMVM${pair.clean.videoId}`;
    await page
      .goto(
        `https://music.youtube.com/watch?v=${pair.clean.videoId}&list=${listId}`,
        { waitUntil: 'domcontentloaded' },
      )
      .catch(() => {});
    await page
      .waitForFunction(
        () => document.querySelectorAll('ytmusic-player-queue-item').length >= 2,
        { timeout: 20_000 },
      )
      .catch(() => {});
    // Wait until our /next post-processing has run at least once. We can't
    // see the extension's logs from here so we poll the DOM for an explicit
    // badge stamped onto any queue item.
    await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll('ytmusic-player-queue-item')].some((item) =>
            item.querySelector('ytmusic-inline-badge-renderer'),
          ),
        { timeout: 20_000 },
      )
      .catch(() => {});
    // Hand off to buildAssertion's "manual" branch — it queries the DOM for
    // swap-marked items and cross-checks each against the search API.
    return { manual: true, pair };
  },

  /**
   * Play a known clean track to populate the auto-radio queue, then advance to
   * the next queued track via playerApi.nextVideo(). Tests that swap also runs
   * for auto-advance (which loads a different videoId than what the user
   * explicitly invoked).
   */
  async queueAdvance(page, pair, _validCleanIds, observer) {
    await page
      .goto(`https://music.youtube.com/watch?v=${pair.clean.videoId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      })
      .catch(() => {});
    // Wait for the up-next queue to populate. Anonymous profiles (e.g. CI
    // with no login) sometimes don't generate an auto-radio, in which case
    // there's nothing to advance to — skip immediately rather than hang.
    const haveQueue = await page
      .waitForFunction(
        () => document.querySelectorAll('ytmusic-player-queue-item').length >= 2,
        { timeout: 10_000, polling: 500 },
      )
      .then(() => true)
      .catch(() => false);
    if (!haveQueue) {
      const err = new Error('no up-next queue (likely anonymous profile)');
      err.skip = true;
      throw err;
    }

    // Snapshot the observer's current /player response count BEFORE invoking
    // nextVideo. We use this as a watermark so the in-flight initial-load
    // /player (whose response may still be arriving — the extension's slow-
    // path probe can add up to 7s to that round-trip) isn't mistaken for an
    // advancement.
    const beforeLen = observer.xhrResponses.length;
    const t = Date.now();
    const ok = await page.evaluate(() => {
      const pApi = document.querySelector('ytmusic-app')?.inst?.root?.playerApi;
      if (!pApi?.nextVideo) return false;
      pApi.nextVideo();
      return true;
    });
    if (!ok) throw new Error('playerApi.nextVideo not available');

    // Wait briefly for a NEW /player XHR (one after the watermark). If none
    // lands within 12s, the auto-radio queue is inert (common in anonymous
    // profiles even when the DOM has stub items) and there's nothing to
    // assert against — skip.
    const sawNew = await new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (observer.xhrResponses.length > beforeLen) return resolve(true);
        if (Date.now() - start > 12_000) return resolve(false);
        setTimeout(tick, 200);
      };
      tick();
    });
    if (!sawNew) {
      const err = new Error('nextVideo did not trigger a new /player XHR (auto-queue inert)');
      err.skip = true;
      throw err;
    }
    return t;
  },
};

/* ----------------------------- runner ----------------------------------- */

function test(name, fn) { return { name, fn }; }

const TEST_TIMEOUT_MS = 90_000;

async function runTests(tests, page, observer) {
  const consoleLog = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[uncensor]')) consoleLog.push({ at: Date.now(), text });
  });

  const results = [];
  for (const t of tests) {
    process.stdout.write(`\n▶ ${t.name}\n`);
    const t0 = Date.now();
    try {
      await page.goto('https://music.youtube.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
      // Wait for the SPA shell to be mounted (so playerApi etc. exists by the
      // time tests run).
      await page
        .waitForFunction(() => !!document.querySelector('ytmusic-app')?.inst?.root?.playerApi, {
          timeout: 15_000,
        })
        .catch(() => {});
      // Hard per-test timeout so a hung test doesn't stall the whole suite —
      // important in CI where the auto-radio queue can fail to populate in
      // unauthenticated profiles.
      await Promise.race([
        t.fn(page, observer),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(`test timed out after ${TEST_TIMEOUT_MS}ms`)), TEST_TIMEOUT_MS),
        ),
      ]);
      results.push({ name: t.name, ok: true });
      console.log('  ✓ pass');
    } catch (err) {
      const relevant = consoleLog.filter((l) => l.at >= t0).slice(-15);
      const ctx = relevant.map((l) => `      ${l.text}`).join('\n');
      if (err.skip) {
        results.push({ name: t.name, skip: true, err: err.message });
        console.log(`  ~ skip: ${err.message}`);
      } else {
        results.push({ name: t.name, ok: false, err: err.message, ctx });
        console.log(`  ✗ FAIL: ${err.message}`);
        if (ctx) console.log(`    extension logs during test:\n${ctx}`);
      }
    }
  }
  return results;
}

/* ----------------------------- tests ------------------------------------ */

function makeTests(pair, allRowsForQuery) {
  const tag = `[${pair.title} by ${pair.artist}]`;
  const validCleanIds = allRowsForQuery
    .filter((r) => !r.explicit && r.title === pair.title && r.artist === pair.artist)
    .map((r) => r.videoId);

  // Look up: does a given videoId have a known explicit sibling per our API?
  // Used so queueAdvance's assertion can adapt — the auto-queue may land on a
  // track without an explicit version, in which case "no swap" is correct.
  async function isSwapEligible(videoId, title, artist) {
    try {
      const json = await search(buildSearchQuery(title, artist));
      const rows = parseSearchResponse(json);
      const self = rows.find((r) => r.videoId === videoId);
      if (self?.explicit) return false; // already explicit — no swap needed
      const sibling = rows.find(
        (r) =>
          r.explicit &&
          r.title === title &&
          r.artist === artist &&
          r.durationSec != null &&
          (self?.durationSec == null || Math.abs(r.durationSec - self.durationSec) <= 2),
      );
      return !!sibling;
    } catch {
      return false;
    }
  }

  /**
   * Generic assertion: the user navigated/clicked some *clean* track, and our
   * extension should ensure that the track that ACTUALLY plays is explicit.
   *
   * Truth signals (in order of authority):
   *   1. The /player XHR response received by the SPA must have a videoId
   *      that is DIFFERENT from the videoId the user invoked (proves a swap
   *      actually happened — the SPA loaded different streaming data than
   *      requested).
   *   2. The player bar #badges element shows the explicit indicator (what
   *      the user actually sees in the UI).
   */
  const buildAssertion = (entryName) => async (page, observer) => {
    const triggered = await entryPoints[entryName](page, pair, validCleanIds, observer);

    // playlistPlay verifies the /next interceptor decorates queue items with
    // explicit badges for swappable tracks — checked directly in the DOM
    // rather than going through the /player observer.
    if (triggered?.manual === true && entryName === 'playlistPlay') {
      const queueState = await page.evaluate(() => {
        const items = [...document.querySelectorAll('ytmusic-player-queue-item')];
        const out = [];
        for (const item of items) {
          let vid;
          try { vid = item.data?.videoId ?? item.__data?.videoId; } catch {}
          const hasBadge = !!item.querySelector('ytmusic-inline-badge-renderer');
          if (vid) {
            const title = item.querySelector('yt-formatted-string')?.textContent?.trim() ?? '';
            out.push({ vid, hasBadge, title: title.slice(0, 80) });
          }
        }
        return out;
      });
      const swapMarked = queueState.filter((q) => q.hasBadge);
      if (queueState.length === 0) {
        const err = new Error('no queue items rendered');
        err.skip = true;
        throw err;
      }
      // Sanity: at least one of the first few items should be swap-eligible
      // per API. Bounded to 3 in parallel to avoid stacking onto the same
      // rate-limit ceiling our extension already negotiated.
      const eligibilities = await Promise.all(
        queueState.slice(0, 3).map((q) => isSwapEligible(q.vid, q.title, pair.artist)),
      );
      const eligibleCount = eligibilities.filter(Boolean).length;
      if (eligibleCount === 0) {
        const err = new Error(`no swap-eligible items in first 3 queue rows (${queueState.length} total)`);
        err.skip = true;
        throw err;
      }
      if (swapMarked.length === 0) {
        throw new Error(
          `playlist queue has at least ${eligibleCount} swap-eligible items but none are E-marked by our /next interceptor`,
        );
      }
      return;
    }

    const t0 = typeof triggered === 'number' ? triggered : triggered.at;
    const invokedVideoId =
      typeof triggered === 'object' && triggered.clickedVideoId ? triggered.clickedVideoId : null;

    const hit = await observer.waitForXhrAfter(t0);

    // Wait for the SPA's player bar to finish rendering the new track. We
    // don't use getVideoData().video_id because for direct-URL nav the SPA
    // reports the URL videoId (clean), not the swapped one — even after
    // /player returned explicit. So we wait on the visible title in the bar.
    await page
      .waitForFunction(
        () => {
          const bar = document.querySelector('ytmusic-player-bar');
          const title = bar?.querySelector('.title.ytmusic-player-bar')?.textContent?.trim();
          return !!title;
        },
        { timeout: 15_000 },
      )
      .catch(() => {});

    // Wait until the player bar's #badges container has its FINAL state
    // (either the explicit badge has been injected after /next post-processing,
    // or the SPA settled into the final non-explicit state). Polled until
    // stable for 1s to avoid catching mid-render flicker.
    await page
      .waitForFunction(
        () => {
          const bar = document.querySelector('ytmusic-player-bar');
          const badges = bar?.querySelector('#badges');
          if (!badges) return false;
          // Stable signal: stash current innerHTML, compare on next tick.
          const cur = badges.innerHTML;
          const w = window;
          if (w.__uncensorBadgeSnap !== cur) {
            w.__uncensorBadgeSnap = cur;
            w.__uncensorBadgeAt = performance.now();
            return false;
          }
          return performance.now() - (w.__uncensorBadgeAt ?? 0) >= 1000;
        },
        { timeout: 15_000, polling: 200 },
      )
      .catch(() => {});

    const bar = await readPlayerBarBadgeState(page);

    const adaptive = entryName === 'queueAdvance' || triggered?.adaptive === true;
    if (adaptive) {
      // Adaptive mode (auto-queue advance, generic playlist row): the SPA can
      // land on a track that has no explicit sibling, in which case "no swap"
      // is correct. Assert consistency instead: if the landed track IS swap-
      // eligible, a swap must have happened (XHR resp != input, E badge).
      const eligible = await isSwapEligible(hit.videoId, hit.title ?? '', hit.author ?? '');
      if (!eligible) return;
      if (invokedVideoId && hit.videoId === invokedVideoId) {
        throw new Error(
          `swap-eligible track "${hit.title}" by ${hit.author} (${hit.videoId}) was not swapped`,
        );
      }
      if (!bar.hasExplicitBadge) {
        throw new Error(
          `swap-eligible track landed without E badge (videoId=${hit.videoId}, title="${hit.title}")`,
        );
      }
      return;
    }

    // Strict mode (directUrl, searchAndClick): we invoked a specific clean
    // videoId. The /player resp must differ AND the player bar must show E.
    if (invokedVideoId == null) throw new Error('no invokedVideoId for this entry');
    if (hit.videoId === invokedVideoId) {
      throw new Error(`/player XHR resp videoId is unchanged (${hit.videoId}) — no swap happened`);
    }
    if (!bar.hasExplicitBadge) {
      throw new Error(
        `player bar has no E badge despite /player resp being ${hit.videoId} (invoked=${invokedVideoId}, title="${bar.title}")`,
      );
    }
  };

  return [
    test(`${tag} directUrl(clean) → audio + badge become explicit`, buildAssertion('directUrl')),
    test(`${tag} searchAndClick(clean row) → audio + badge become explicit`, buildAssertion('searchAndClick')),
    test(`${tag} playlistPlay(click upcoming-queue item) → audio + badge consistent with swap-eligibility`, buildAssertion('playlistPlay')),
    test(`${tag} queueAdvance(playerApi.nextVideo) → audio + badge stay explicit`, buildAssertion('queueAdvance')),
  ];
}

/* ----------------------------- main ------------------------------------- */

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
const ctx = browser.contexts()[0];
// Pre-accept Google's EU consent so headless CI runs don't get bounced to
// consent.youtube.com. This is a no-op when the cookie is already set.
await ctx
  .addCookies([
    { name: 'SOCS', value: 'CAI', domain: '.youtube.com', path: '/', sameSite: 'Lax' },
    { name: 'CONSENT', value: 'YES+', domain: '.youtube.com', path: '/', sameSite: 'Lax' },
  ])
  .catch(() => {});
let page = ctx.pages().find((p) => p.url().startsWith('https://music.youtube.com'));
if (!page) page = await ctx.newPage();
page.on('dialog', (d) => d.accept().catch(() => {}));
await page.bringToFront();

let observer = attachPlayerObserver(page);

let allResults = [];
const discoveryFailures = [];
for (const q of TEST_QUERIES) {
  console.log(`\n=== discovering pair for "${q}" ===`);
  const pair = await discoverPair(q);
  if (!pair) {
    console.log(`  ✗ FAIL: no clean/explicit pair found for "${q}" via Innertube search`);
    discoveryFailures.push(q);
    continue;
  }
  console.log(`  clean=${pair.clean.videoId}  explicit=${pair.explicit.videoId}  "${pair.title}" by ${pair.artist}`);
  const results = await runTests(makeTests(pair, pair.rows), page, observer);
  allResults = allResults.concat(results);

  // Reset the page between songs. After 4 tests on the same page the SPA's
  // internal state (player + queue + service workers + accumulated XHR
  // closures from in-flight extension probes) can wedge subsequent /watch
  // navigations into a state where /player never fires — which manifests as
  // "no /player XHR observed in time" for every test of the next song.
  // Closing and re-opening the page drops all of that.
  try {
    await page.close();
  } catch {}
  page = await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  observer = attachPlayerObserver(page);
}

console.log('\n=== summary ===');
const failed = allResults.filter((r) => !r.ok && !r.skip);
const skipped = allResults.filter((r) => r.skip);
const passed = allResults.filter((r) => r.ok);
for (const r of allResults) {
  const mark = r.ok ? '✓' : r.skip ? '~' : '✗';
  console.log(`  ${mark}  ${r.name}${r.err ? '  — ' + r.err : ''}`);
}
if (discoveryFailures.length) {
  console.log(`Discovery failures (no API pair surfaced for these queries):`);
  for (const q of discoveryFailures) console.log(`  ✗  ${q}`);
}
console.log(
  `${passed.length} passed · ${failed.length + discoveryFailures.length} failed · ${skipped.length} skipped`,
);

process.exit(failed.length || discoveryFailures.length ? 1 : 0);

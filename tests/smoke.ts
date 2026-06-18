// Smoke test: each known clean track must resolve to an explicit sibling via
// our search + match pipeline. If any case can't find a swap, exit nonzero so
// CI fails loudly (this catches regressions in the matcher AND environmental
// issues like region-based content filtering hiding the explicit version).

import {
  search,
  parseSearchResponse,
  findExplicitSwap,
  buildSearchQuery,
  stripArtistPrefix,
  surfaceClass,
  pickExplicitSwap,
  type TrackRow,
} from '../src/ytmusic/index.ts';

interface Case {
  title: string;
  artist: string;
  durationSec?: number;
  /** Excluded from candidates (the videoId of the clean track itself). */
  videoId?: string;
}

// Each case must resolve to *some* explicit candidate matching title+artist+
// duration. We deliberately don't pin to a specific explicit videoId — YT
// Music ranks multiple explicit uploads per song and which one bubbles to the
// top varies with the requester's IP/region/UA, so requiring an exact match
// would make this test flaky for non-extension reasons. Strictness lives in
// the matcher (variant-aware title, ±2s duration, primary-artist), so any
// returned swap is by definition an equivalent recording.
const cases: Case[] = [
  {
    title: 'WAP (feat. Megan Thee Stallion)',
    artist: 'Cardi B',
    durationSec: 188,
    videoId: 'Y3SKjM_2M5k',
  },
  {
    title: 'HUMBLE.',
    artist: 'Kendrick Lamar',
    durationSec: 177,
  },
  {
    title: 'rockstar',
    artist: 'Post Malone',
    durationSec: 218,
  },
  // Regression: "Official Video" upload format ("Artist - Title (...)").
  {
    title: 'AJR - The DJ Is Crying For Help (Official Video)',
    artist: 'AJR',
    durationSec: 220,
  },
  // Regression: clean (188s) and explicit (181s) durations differ by 7s on
  // YT Music. The previous ±2s default tolerance rejected the only valid
  // explicit candidate even though title + primary-artist + variant markers
  // all matched.
  {
    title: "World's Smallest Violin",
    artist: 'AJR',
    durationSec: 188,
  },
];

const failures: string[] = [];

// Offline regression tests for the query-normalization helpers. These guard
// the "Artist - Title (Official Video)" upload format which Google ranks
// inconsistently when queried verbatim — we strip the noise before search()
// to get a deterministic ranking, so the strip helpers themselves are what
// the regression test needs to pin down.
{
  const cases: { in: [string, string]; expectPrefix?: string; expectQuery: string }[] = [
    {
      in: ['AJR - The DJ Is Crying For Help (Official Video)', 'AJR'],
      expectPrefix: 'The DJ Is Crying For Help (Official Video)',
      expectQuery: 'The DJ Is Crying For Help AJR',
    },
    {
      in: ['HUMBLE.', 'Kendrick Lamar'],
      expectQuery: 'HUMBLE. Kendrick Lamar',
    },
    {
      in: ['Bohemian Rhapsody (Official Music Video) [Remastered]', 'Queen'],
      expectQuery: 'Bohemian Rhapsody [Remastered] Queen',
    },
    {
      in: ['WAP (feat. Megan Thee Stallion)', 'Cardi B'],
      expectQuery: 'WAP (feat. Megan Thee Stallion) Cardi B',
    },
  ];
  let unitFails = 0;
  for (const c of cases) {
    if (c.expectPrefix !== undefined) {
      const got = stripArtistPrefix(c.in[0], c.in[1]);
      if (got !== c.expectPrefix) {
        console.log(`✗ stripArtistPrefix("${c.in[0]}", "${c.in[1]}") = "${got}"  expected "${c.expectPrefix}"`);
        unitFails++;
      }
    }
    const q = buildSearchQuery(c.in[0], c.in[1]);
    if (q !== c.expectQuery) {
      console.log(`✗ buildSearchQuery("${c.in[0]}", "${c.in[1]}") = "${q}"  expected "${c.expectQuery}"`);
      unitFails++;
    }
  }
  if (unitFails) {
    console.log(`✗ ${unitFails} query-normalization unit failures`);
    process.exit(1);
  }
  console.log(`✓ query-normalization helpers OK (${cases.length} cases)`);
}

// Offline regression tests for playback-surface compatibility. The black-
// screen-on-music-video bug came from swapping a video-surface track (OMV/UGC)
// to an audio-only explicit song (ATV): the audio stream has no video track so
// the player renders a black frame. The matcher must refuse cross-class swaps.
{
  const ATV = 'MUSIC_VIDEO_TYPE_ATV';
  const OMV = 'MUSIC_VIDEO_TYPE_OMV';
  const UGC = 'MUSIC_VIDEO_TYPE_UGC';
  let unitFails = 0;
  const check = (cond: boolean, msg: string) => {
    if (!cond) { console.log(`✗ ${msg}`); unitFails++; }
  };

  check(surfaceClass(ATV) === 'audio', 'ATV should classify as audio');
  check(surfaceClass(OMV) === 'video', 'OMV should classify as video');
  check(surfaceClass(UGC) === 'video', 'UGC should classify as video');
  check(surfaceClass(undefined) === 'audio', 'unknown type should default to audio');

  const row = (o: Partial<TrackRow>): TrackRow => ({
    videoId: o.videoId ?? 'x', title: o.title ?? 'Song', artist: o.artist ?? 'Artist',
    durationSec: o.durationSec ?? 180, explicit: o.explicit ?? false, musicVideoType: o.musicVideoType,
  });

  // 1. Audio source + explicit ATV candidate → swap (the normal song case).
  {
    const swap = pickExplicitSwap(
      { title: 'Song', artist: 'Artist', durationSec: 180, videoId: 'clean', musicVideoType: ATV },
      [row({ videoId: 'expA', explicit: true, musicVideoType: ATV })],
    );
    check(swap?.videoId === 'expA', 'audio source should swap to explicit ATV');
  }

  // 2. Video source (OMV) + ONLY explicit ATV available → NO swap (black-screen
  //    guard: never feed audio-only into a video surface).
  {
    const swap = pickExplicitSwap(
      { title: 'Song', artist: 'Artist', durationSec: 180, videoId: 'cleanVid', musicVideoType: OMV },
      [row({ videoId: 'expA', explicit: true, musicVideoType: ATV })],
    );
    check(swap === null, 'video source must NOT swap to audio-only ATV (black-screen guard)');
  }

  // 3. Video source + explicit OMV available → swap to the video candidate.
  {
    const swap = pickExplicitSwap(
      { title: 'Song', artist: 'Artist', durationSec: 180, videoId: 'cleanVid', musicVideoType: OMV },
      [
        row({ videoId: 'expA', explicit: true, musicVideoType: ATV }),
        row({ videoId: 'expV', explicit: true, musicVideoType: OMV }),
      ],
    );
    check(swap?.videoId === 'expV', 'video source should swap to a video-class explicit candidate');
  }

  if (unitFails) {
    console.log(`✗ ${unitFails} surface-compatibility unit failures`);
    process.exit(1);
  }
  console.log('✓ surface-compatibility helpers OK (7 cases)');
}

for (const c of cases) {
  process.stdout.write(`\n▶ "${c.title}" by ${c.artist} (${c.durationSec ?? '?'}s)\n`);
  const q = buildSearchQuery(c.title, c.artist);
  const swap = await findExplicitSwap(c, q);
  if (!swap) {
    // Dump top 10 of the *last* attempt to give debug signal.
    const json = await search(q);
    const rows = parseSearchResponse(json);
    failures.push(`${c.title} by ${c.artist}: no explicit candidate found (${rows.length} rows, ${rows.filter((r) => r.explicit).length} explicit)`);
    console.log(`  ✗ FAIL: no explicit swap candidate. Top 10 candidates:`);
    for (const r of rows.slice(0, 10)) {
      console.log(`     ${r.explicit ? 'E' : '.'}  ${r.videoId}  ${r.durationSec}s  "${r.title}" by ${r.artist}`);
    }
    continue;
  }
  console.log(`  → ${swap.videoId}  "${swap.title}" by ${swap.artist} (${swap.durationSec}s)`);
  console.log(`  ✓ pass`);
}

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length}/${cases.length} cases failed:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ ${cases.length}/${cases.length} cases swapped successfully`);

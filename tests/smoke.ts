// Smoke test: each known clean track must resolve to an explicit sibling via
// our search + match pipeline. If any case can't find a swap, exit nonzero so
// CI fails loudly (this catches regressions in the matcher AND environmental
// issues like region-based content filtering hiding the explicit version).

import {
  search,
  parseSearchResponse,
  pickExplicitSwap,
  buildSearchQuery,
  stripArtistPrefix,
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

for (const c of cases) {
  process.stdout.write(`\n▶ "${c.title}" by ${c.artist} (${c.durationSec ?? '?'}s)\n`);
  const json = await search(buildSearchQuery(c.title, c.artist));
  const rows = parseSearchResponse(json);
  const explicitCount = rows.filter((r) => r.explicit).length;
  console.log(`  ${rows.length} candidates · ${explicitCount} explicit`);

  const swap = pickExplicitSwap(c, rows);
  if (!swap) {
    failures.push(`${c.title} by ${c.artist}: no explicit candidate found (${rows.length} rows, ${explicitCount} explicit)`);
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

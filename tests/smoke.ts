// End-to-end smoke test of the standalone client.
// Picks a known clean track and asks the algorithm to find its explicit sibling.

import { search, parseSearchResponse, pickExplicitSwap } from '../src/ytmusic/index.ts';

const cases: { title: string; artist: string; durationSec?: number; videoId?: string }[] = [
  // Known WAP pair from earlier probe.
  { title: 'WAP (feat. Megan Thee Stallion)', artist: 'Cardi B', durationSec: 188, videoId: 'Y3SKjM_2M5k' },
  // Another classic with clean/explicit pair.
  { title: 'HUMBLE.', artist: 'Kendrick Lamar', durationSec: 177 },
  // Track that's probably explicit-only on YT Music — should return null.
  { title: 'rockstar', artist: 'Post Malone', durationSec: 218 },
];

for (const c of cases) {
  console.log(`\n--- Looking up: "${c.title}" by ${c.artist} (${c.durationSec ?? '?'}s) ---`);
  const json = await search(`${c.title} ${c.artist}`);
  const rows = parseSearchResponse(json);
  console.log(`Got ${rows.length} candidates (${rows.filter((r) => r.explicit).length} explicit).`);

  const swap = pickExplicitSwap(c, rows);
  if (swap) {
    console.log(`SWAP → ${swap.videoId}  "${swap.title}" by ${swap.artist} (${swap.durationSec}s)  explicit=${swap.explicit}`);
  } else {
    console.log('No explicit swap candidate found.');
  }
}

// Regression: "Official Video" upload format (Artist - Title (...))
const ajrCase = {
  title: 'AJR - The DJ Is Crying For Help (Official Video)',
  artist: 'AJR',
  durationSec: 220,
};
console.log(`\n--- Looking up: "${ajrCase.title}" by ${ajrCase.artist} (${ajrCase.durationSec}s) ---`);
const ajrJson = await search(`${ajrCase.title} ${ajrCase.artist}`);
const ajrRows = parseSearchResponse(ajrJson);
const ajrSwap = pickExplicitSwap(ajrCase, ajrRows);
if (ajrSwap) console.log(`SWAP → ${ajrSwap.videoId}  "${ajrSwap.title}" by ${ajrSwap.artist} (${ajrSwap.durationSec}s)  explicit=${ajrSwap.explicit}`);
else console.log('No explicit swap candidate found.');

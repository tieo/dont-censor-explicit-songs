// Decides whether a given (clean) track has an explicit sibling on YT Music
// and which candidate to swap to.

import type { TrackRow } from './parse';

export interface MatchInput {
  title: string;
  artist: string;
  durationSec?: number;
  /** Video ID of the currently playing track — excluded from candidates. */
  videoId?: string;
}

export interface MatchOptions {
  /** Acceptable duration delta in seconds (default 2). */
  durationToleranceSec?: number;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    // Strip ONLY featuring/with credits — these vary harmlessly between
    // clean/explicit pairs. Preserve other parentheticals (Live, Acoustic,
    // Remix, etc.) so the matcher won't swap a studio recording with a live
    // recording.
    .replace(
      /\((?:feat\.?|featuring|ft\.?|with|w\/)[^)]*\)|\[(?:feat\.?|featuring|ft\.?|with|w\/)[^\]]*\]/gi,
      ' ',
    )
    .replace(/[^a-z0-9()\[\]]+/g, ' ')
    .trim();
}

// Variant markers that flag non-studio recordings. If they appear in one
// title but not the other, the candidates are different recordings even if
// the base title matches.
const VARIANT_MARKERS = [
  'live',
  'acoustic',
  'remix',
  'instrumental',
  'karaoke',
  'cover',
  'demo',
  'unplugged',
  'edit',
  'extended',
  'radio',
  'orchestral',
  'piano',
  'lyrics',
  'sped up',
  'slowed',
  'reverb',
  'reverbed',
  'nightcore',
];

function variantSignature(title: string): string[] {
  const lc = title.toLowerCase();
  return VARIANT_MARKERS.filter((m) => lc.includes(m)).sort();
}

/**
 * YouTube uploads from artist channels (especially "Official Video" /
 * "Official Audio") prefix the song title with `"Artist - "`. That prefix
 * breaks the song-title prefix match against the bare song name, so we strip
 * it when present and the channel name matches the artist.
 */
function stripArtistPrefix(title: string, artist: string): string {
  if (!artist) return title;
  const t = title.trim();
  const a = artist.trim();
  // Match "Artist", "Artist -", "Artist – ", "Artist: " variants.
  const sepRx = /^[ \t]*[-–—:|][ \t]*/;
  const lc = t.toLowerCase();
  const al = a.toLowerCase();
  if (!lc.startsWith(al)) return title;
  const rest = t.slice(a.length);
  const m = rest.match(sepRx);
  if (!m) return title;
  return rest.slice(m[0].length);
}

function titleMatches(a: string, b: string, artistA?: string, artistB?: string): boolean {
  const ta = artistA ? stripArtistPrefix(a, artistA) : a;
  const tb = artistB ? stripArtistPrefix(b, artistB) : b;
  const na = normalize(ta);
  const nb = normalize(tb);
  if (!na || !nb) return false;
  if (na !== nb && !na.startsWith(nb) && !nb.startsWith(na)) return false;
  // Both must share the same variant markers (or both lack them) — a studio
  // recording must not match a live recording even if the base title is the
  // same.
  const va = variantSignature(ta);
  const vb = variantSignature(tb);
  if (va.length !== vb.length) return false;
  return va.every((m, i) => m === vb[i]);
}

function artistMatches(a: string, b: string): boolean {
  // YT Music joins features with ", " or " & "; match on the primary (first) artist.
  const primary = (s: string) => normalize(s.split(/[,&]| feat\.?| ft\.?| featuring /i)[0] ?? '');
  const pa = primary(a);
  const pb = primary(b);
  return !!pa && !!pb && pa === pb;
}

/**
 * Given a clean track, pick the best explicit candidate from search results.
 * Returns null if no suitable explicit version was found.
 */
export function pickExplicitSwap(
  input: MatchInput,
  candidates: TrackRow[],
  opts: MatchOptions = {}
): TrackRow | null {
  const tol = opts.durationToleranceSec ?? 2;

  const filtered = candidates.filter((c) => {
    if (c.videoId === input.videoId) return false;
    if (!c.explicit) return false;
    if (!titleMatches(c.title, input.title, c.artist, input.artist)) return false;
    if (!artistMatches(c.artist, input.artist)) return false;
    if (input.durationSec != null && c.durationSec != null) {
      if (Math.abs(c.durationSec - input.durationSec) > tol) return false;
    }
    return true;
  });

  if (filtered.length === 0) return null;

  // Prefer the closest duration match, then the first result (highest YT ranking).
  filtered.sort((a, b) => {
    const dur = input.durationSec;
    if (dur == null) return 0;
    const da = Math.abs((a.durationSec ?? dur) - dur);
    const db = Math.abs((b.durationSec ?? dur) - dur);
    return da - db;
  });
  return filtered[0];
}

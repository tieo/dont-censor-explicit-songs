// Decides whether a given (clean) track has an explicit sibling on YT Music
// and which candidate to swap to.

import type { TrackRow } from './parse';
import { parseSearchResponse } from './parse';
import { search, type SearchOptions } from './client';

export interface MatchInput {
  title: string;
  artist: string;
  durationSec?: number;
  /** Video ID of the currently playing track — excluded from candidates. */
  videoId?: string;
  /**
   * Source track's YT Music content type (MUSIC_VIDEO_TYPE_ATV / _OMV / _UGC).
   * When set, swaps are restricted to a playback-compatible candidate so we
   * never feed an audio-only stream into a video surface (black screen).
   */
  musicVideoType?: string;
}

/**
 * Collapse YT Music's content types into a playback surface class. ATV is an
 * audio-only song (static cover art); OMV/UGC carry actual video. A swap is
 * only safe between the same class — swapping a video track to audio-only
 * leaves the player rendering a black frame.
 */
export type SurfaceClass = 'audio' | 'video';
export function surfaceClass(musicVideoType: string | undefined): SurfaceClass {
  if (!musicVideoType) return 'audio'; // songs-filter results & unknowns are audio
  return musicVideoType === 'MUSIC_VIDEO_TYPE_ATV' ? 'audio' : 'video';
}

export interface MatchOptions {
  /**
   * Acceptable duration delta in seconds (default 10). YT Music's clean and
   * explicit uploads are usually the same recording but the durations
   * reported in /next and /search can drift by several seconds — observed
   * differences up to 7s on AJR's "World's Smallest Violin" (188s clean vs
   * 181s explicit). Title + primary-artist + variant-marker matching is what
   * really keeps the swap correct; duration is just a sanity gate against
   * cross-song collisions, so a generous bound is preferable to false
   * negatives.
   */
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
export function stripArtistPrefix(title: string, artist: string): string {
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

/**
 * Strip non-semantic upload tags from a title — e.g. "(Official Video)",
 * "[Official Music Video]", "(Official Audio)", "(Lyric Video)", "(Visualizer)".
 * Preserves variant markers (Live/Acoustic/Remix/...) AND feature credits
 * (the normalizer handles those separately) so the match pipeline still sees
 * the same signal. Used to clean queries before search() — Google's ranking
 * is sensitive to long, tag-heavy strings and the explicit upload often
 * falls out of the top results.
 */
const UPLOAD_TAG_RX =
  /[\(\[][^)\]]*\b(?:official|music\s+video|audio|lyric(?:s)?\s+video|lyrics?|visualizer|hd|hq|4k|mv|m\/v|color\s*coded)\b[^)\]]*[\)\]]/gi;
export function stripUploadTags(title: string): string {
  return title.replace(UPLOAD_TAG_RX, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Build a normalized search query for the Innertube /search call. Strips
 * "Artist - " prefix + upload tags so the explicit sibling reliably surfaces
 * in the top results regardless of how the source title was formatted.
 */
export function buildSearchQuery(title: string, artist: string): string {
  const cleaned = stripUploadTags(stripArtistPrefix(title, artist));
  return `${cleaned} ${artist}`.trim();
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
  const tol = opts.durationToleranceSec ?? 10;
  const wantClass = surfaceClass(input.musicVideoType);

  const filtered = candidates.filter((c) => {
    if (c.videoId === input.videoId) return false;
    if (!c.explicit) return false;
    // Playback-compatibility gate: never swap a video-surface track to an
    // audio-only candidate (or vice versa) — the mismatch is what causes the
    // black-screen-on-music-video bug.
    if (surfaceClass(c.musicVideoType) !== wantClass) return false;
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

/**
 * Search + match in one call. If the first search returns no viable
 * candidate, retries once — YT Music's ranker can reshuffle which uploads
 * land in the top page (observed on AJR's "The DJ Is Crying For Help",
 * where the explicit upload falls out of the top 20 maybe 1 call in 10).
 * A second attempt almost always recovers it.
 */
export async function findExplicitSwap(
  input: MatchInput,
  query: string,
  searchOpts: SearchOptions = {},
  matchOpts: MatchOptions = {},
): Promise<TrackRow | null> {
  // Audio (ATV) sources match against the Songs shelf (default). Video sources
  // need the unfiltered shelf so OMV/UGC candidates are present — the Songs
  // filter strips them, which would leave a video source with no compatible
  // candidate. Caller may still override songsOnly explicitly.
  const effectiveOpts: SearchOptions =
    searchOpts.songsOnly === undefined && surfaceClass(input.musicVideoType) === 'video'
      ? { ...searchOpts, songsOnly: false }
      : searchOpts;

  for (let attempt = 0; attempt < 2; attempt++) {
    const json = await search(query, effectiveOpts);
    const rows = parseSearchResponse(json);
    // Also let the caller signal "this is already explicit" — if the input's
    // own videoId came back tagged explicit, no swap is needed.
    if (input.videoId) {
      const self = rows.find((r) => r.videoId === input.videoId);
      if (self?.explicit) return null;
    }
    const swap = pickExplicitSwap(input, rows, matchOpts);
    if (swap) return swap;
  }
  return null;
}

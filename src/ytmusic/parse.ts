// Parses Innertube search responses into structured track rows.

export interface TrackRow {
  videoId: string;
  title: string;
  /** Primary artist name (best-effort; YT Music joins features with " & " or ", "). */
  artist: string;
  album?: string;
  /** Duration in seconds. */
  durationSec?: number;
  explicit: boolean;
  /**
   * YT Music content type: MUSIC_VIDEO_TYPE_ATV (audio-only song, static art),
   * _OMV (official music video), _UGC (user video). Drives whether a swap is
   * playback-compatible — swapping a video-surface track to an audio-only one
   * leaves the player rendering a black video frame.
   */
  musicVideoType?: string;
}

function walk(node: unknown, hits: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!node || typeof node !== 'object') return hits;
  const obj = node as Record<string, unknown>;
  if (obj.musicResponsiveListItemRenderer) {
    hits.push(obj.musicResponsiveListItemRenderer as Record<string, unknown>);
  }
  for (const v of Object.values(obj)) walk(v, hits);
  return hits;
}

function textFromRuns(node: unknown): string {
  const n = node as { runs?: { text?: string }[] } | undefined;
  return n?.runs?.map((r) => r.text ?? '').join('') ?? '';
}

function durationToSec(s: string): number | undefined {
  // "3:08" or "1:02:34"
  const parts = s.trim().split(':').map((n) => Number(n));
  if (parts.some((n) => Number.isNaN(n))) return undefined;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return undefined;
}

function videoIdFromRow(row: Record<string, unknown>): string | undefined {
  const pid = (row.playlistItemData as { videoId?: string } | undefined)?.videoId;
  if (pid) return pid;

  // Fallback: thumbnail overlay play button endpoint.
  const overlay = row.overlay as
    | {
        musicItemThumbnailOverlayRenderer?: {
          content?: {
            musicPlayButtonRenderer?: {
              playNavigationEndpoint?: { watchEndpoint?: { videoId?: string } };
            };
          };
        };
      }
    | undefined;
  return overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
    ?.playNavigationEndpoint?.watchEndpoint?.videoId;
}

type WatchMusicConfig = {
  watchEndpoint?: {
    watchEndpointMusicSupportedConfigs?: { watchEndpointMusicConfig?: { musicVideoType?: string } };
  };
};

function musicVideoTypeFromRow(row: Record<string, unknown>): string | undefined {
  // The type rides on the play-button endpoint (overlay) and the title run's
  // navigationEndpoint — both under watchEndpoint.watchEndpointMusicSupportedConfigs.
  const overlay = row.overlay as
    | {
        musicItemThumbnailOverlayRenderer?: {
          content?: { musicPlayButtonRenderer?: { playNavigationEndpoint?: WatchMusicConfig } };
        };
      }
    | undefined;
  const fromOverlay =
    overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
      ?.playNavigationEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs
      ?.watchEndpointMusicConfig?.musicVideoType;
  if (fromOverlay) return fromOverlay;

  const flexColumns = row.flexColumns as
    | { musicResponsiveListItemFlexColumnRenderer?: { text?: { runs?: { navigationEndpoint?: WatchMusicConfig }[] } } }[]
    | undefined;
  const runs = flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [];
  for (const r of runs) {
    const t = r.navigationEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs
      ?.watchEndpointMusicConfig?.musicVideoType;
    if (t) return t;
  }
  return undefined;
}

function isExplicitRow(row: Record<string, unknown>): boolean {
  const badges = row.badges as { musicInlineBadgeRenderer?: { icon?: { iconType?: string } } }[] | undefined;
  return (
    badges?.some(
      (b) => b.musicInlineBadgeRenderer?.icon?.iconType === 'MUSIC_EXPLICIT_BADGE'
    ) ?? false
  );
}

export function parseSearchResponse(json: unknown): TrackRow[] {
  const rows = walk(json);
  const tracks: TrackRow[] = [];
  for (const row of rows) {
    const videoId = videoIdFromRow(row);
    if (!videoId) continue;

    const flexColumns = row.flexColumns as
      | { musicResponsiveListItemFlexColumnRenderer?: { text?: unknown } }[]
      | undefined;
    const col0 = textFromRuns(flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text);
    const col1 = textFromRuns(flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text);

    // col1 format for Songs: "Artist • Album • Duration"  (• separators)
    const parts = col1.split(' • ').map((s) => s.trim());
    const durationStr = parts.find((p) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(p));
    const durationSec = durationStr ? durationToSec(durationStr) : undefined;
    // Artist is typically the first segment; album is the middle one(s).
    const artist = parts[0] ?? '';
    const album = parts.length >= 3 ? parts.slice(1, -1).join(' • ') : undefined;

    tracks.push({
      videoId,
      title: col0,
      artist,
      album,
      durationSec,
      explicit: isExplicitRow(row),
      musicVideoType: musicVideoTypeFromRow(row),
    });
  }
  return tracks;
}

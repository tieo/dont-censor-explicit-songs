// Shared preferences contract between the popup (writes), the ISOLATED-world
// bridge content script (reads chrome.storage), and the MAIN-world content
// script (consumes prefs via window.postMessage — it can't touch chrome.* APIs).

export interface Prefs {
  /**
   * When a music VIDEO (OMV/UGC) has no explicit video sibling — the common
   * case, since explicit uploads on YT Music are almost always audio-only —
   * swap to the explicit audio (ATV) version instead of leaving the censored
   * video playing. Drops the video; the player falls back to cover art.
   */
  musicVideoAudioSwap: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  musicVideoAudioSwap: false,
};

/** chrome.storage.local key holding the serialized Prefs object. */
export const PREFS_STORAGE_KEY = 'prefs';

/** Marker on window.postMessage payloads carrying prefs MAIN<-ISOLATED. */
export const PREFS_MESSAGE_SOURCE = 'uncensor:prefs';

export function normalizePrefs(raw: unknown): Prefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Prefs>;
  return { musicVideoAudioSwap: o.musicVideoAudioSwap === true };
}

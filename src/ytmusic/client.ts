// Minimal Innertube client for music.youtube.com.
// Works unauthenticated for read-only search. The same endpoint shape is used
// from the browser extension (where the user's cookies are sent automatically).

export interface InnertubeContext {
  client: {
    clientName: string;
    clientVersion: string;
    hl: string;
    gl: string;
  };
}

export const DEFAULT_CONTEXT: InnertubeContext = {
  client: {
    clientName: 'WEB_REMIX',
    clientVersion: '1.20240101.01.00',
    hl: 'en',
    gl: 'US',
  },
};

// Publicly known key embedded in the music.youtube.com web client.
const WEB_REMIX_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';

// Search filter param that scopes results to Songs only.
const SONGS_FILTER = 'EgWKAQIIAWoMEA4QChADEAQQCRAF';

export interface SearchOptions {
  context?: InnertubeContext;
  /** When true, restrict results to Songs (recommended for swap matching). */
  songsOnly?: boolean;
  /** Extra headers — useful in extension context for auth cookies / SAPISID. */
  headers?: Record<string, string>;
  /** Override fetch (default: globalThis.fetch). */
  fetchImpl?: typeof fetch;
  /**
   * Whether to include a Cookie header bypassing EU consent. Required for Node;
   * forbidden in browser fetch (the browser sends real cookies automatically).
   */
  includeConsentCookie?: boolean;
}

export async function search(query: string, opts: SearchOptions = {}): Promise<unknown> {
  const context = opts.context ?? DEFAULT_CONTEXT;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  const body: Record<string, unknown> = { context, query };
  if (opts.songsOnly !== false) body.params = SONGS_FILTER;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...opts.headers,
  };
  // In Node we need to set our own UA + consent cookie; in the browser these
  // are forbidden headers and the browser handles them.
  const inBrowser = typeof window !== 'undefined';
  if (!inBrowser) {
    headers['User-Agent'] =
      headers['User-Agent'] ??
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    if (opts.includeConsentCookie !== false) {
      headers.Cookie = headers.Cookie ?? 'SOCS=CAI';
    }
  }

  const url = `https://music.youtube.com/youtubei/v1/search?prettyPrint=false&key=${WEB_REMIX_KEY}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    credentials: inBrowser ? 'include' : undefined,
  });

  if (!res.ok) {
    throw new Error(`YT Music search failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

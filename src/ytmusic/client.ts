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

// Search filter param that scopes results to Songs only.
const SONGS_FILTER = 'EgWKAQIIAWoMEA4QChADEAQQCRAF';

/**
 * Resolve the Innertube API key. The key is not a secret — it's the same
 * value the music.youtube.com web client ships in its bootstrap config, used
 * to identify "we're the YT Music web client" — but we read it from the
 * page (or scrape it from the page's HTML in Node) instead of hardcoding so
 * GitHub's secret scanner doesn't flag the literal as a leaked Google key.
 */
let cachedKey: string | undefined;
async function getInnertubeKey(fetchImpl: typeof fetch, headers: Record<string, string>): Promise<string> {
  if (cachedKey) return cachedKey;

  // In the browser / extension MAIN-world context the SPA already loaded the
  // config under window.ytcfg. Read it directly.
  if (typeof window !== 'undefined') {
    const cfg = (window as { ytcfg?: { get?: (k: string) => unknown; data_?: Record<string, unknown> } }).ytcfg;
    const fromGetter = cfg?.get?.('INNERTUBE_API_KEY');
    const fromData = cfg?.data_?.INNERTUBE_API_KEY;
    const key = typeof fromGetter === 'string' ? fromGetter : typeof fromData === 'string' ? fromData : undefined;
    if (key) {
      cachedKey = key;
      return key;
    }
  }

  // Node / first-load fallback: fetch the music.youtube.com landing page and
  // pull the key out of its inline ytcfg.set(...) blob.
  const res = await fetchImpl('https://music.youtube.com/', { headers });
  if (!res.ok) throw new Error(`could not fetch music.youtube.com for key: ${res.status}`);
  const html = await res.text();
  const m = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
  if (!m) throw new Error('could not extract INNERTUBE_API_KEY from music.youtube.com');
  cachedKey = m[1];
  return cachedKey;
}

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
  /**
   * Hard per-call timeout in milliseconds (default 5000). Beyond this we
   * abort the fetch so a single throttled / hung request can't stall callers
   * (notably the /next post-processor in the content script, which races
   * many concurrent searches).
   */
  timeoutMs?: number;
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

  const key = await getInnertubeKey(fetchImpl, headers);
  const url = `https://music.youtube.com/youtubei/v1/search?prettyPrint=false&key=${key}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 5000);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      credentials: inBrowser ? 'include' : undefined,
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`YT Music search failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

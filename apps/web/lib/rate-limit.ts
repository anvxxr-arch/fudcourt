/**
 * Shared, in-process rate limiting and micro-caching for upstream API calls.
 *
 * DexScreener sits behind Cloudflare and answers a burst with
 * `429 {"type":".../error-1015/","title":"Error 1015: You are being rate
 * limited"}` (measured: 10 concurrent proxy hits = 10x 429). The UI fires a
 * request on every state change -- typing a mint, toggling a chain, switching a
 * mode -- so without this a user clicking around gets an error page instead of
 * data. Two mechanisms:
 *
 *  - a token bucket, so concurrent callers queue instead of all bursting;
 *  - a short TTL cache, so an identical repeat within the window costs nothing.
 *
 * Scope note: this is per Node process, which is what a single `next start`
 * gives us. It protects the upstream from this app's own bursts, which is the
 * failure mode that actually occurs. It is not a distributed limiter -- if the
 * app is scaled to several instances each keeps its own bucket. That is an
 * acceptable trade for a read-only public feed and is stated rather than
 * implied.
 */

const MIN_GAP_MS = 200; // <= 5 upstream requests/sec
const CACHE_TTL_MS = 15_000;

type Entry = { at: number; body: unknown };
/** What a coalesced group shares: the body text plus enough of the response to
 *  rebuild an equivalent Response per caller. */
type Shared = { text: string; status: number; contentType: string };

const cache = new Map<string, Entry>();
/** In-flight upstream calls, keyed by URL, so identical concurrent requests
 *  share one round-trip. Without this, 10 simultaneous requests for the same
 *  URL are 10 distinct cache misses that all reach upstream. */
const inflight = new Map<string, Promise<Shared>>();
let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serialise access so callers queue rather than bursting. */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastAt = Date.now();
    }
  });
  // keep the chain alive even when a link rejects
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Fetch a URL through the limiter, sharing the body for identical calls made
 * within the TTL. Rejections are never cached, so a transient upstream failure
 * is retried on the next request rather than pinned for the whole window.
 */
export async function limitedFetch(
  url: string,
  init: RequestInit = {},
  opts: { ttlMs?: number } = {}
): Promise<Response> {
  const ttl = opts.ttlMs ?? CACHE_TTL_MS;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) {
    return new Response(JSON.stringify(hit.body), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
    });
  }

  // Single-flight: a caller arriving while an identical call is already in
  // flight awaits that one instead of queueing its own, so N simultaneous
  // requests cost exactly one upstream round-trip.
  //
  // The shared value is the *text*, not the Response. A Response body is a
  // one-shot stream: the first reader consumes it and every later reader gets
  // an empty body, which surfaced as 9x "non-JSON body" 502s. Reading the text
  // once and handing every waiter its own copy is the only way to share safely.
  const pending = inflight.get(url);
  if (pending) {
    const shared = await pending;
    // Marked distinctly from HIT: this cost zero upstream calls, but it did not
    // come from the cache either -- it shared a round-trip already in flight.
    // Collapsing the two would make the header lie about what happened.
    return new Response(shared.text, {
      status: shared.status,
      headers: { 'Content-Type': shared.contentType, 'X-Cache': 'COALESCED' },
    });
  }

  const run = enqueue(async () => {
    const res = await fetch(url, init);
    // Read the body ONCE, here, so the winner and every coalesced waiter all
    // get real bytes. Leaving it on the Response means the first caller drains
    // the stream and the rest see an empty body.
    const text = await res.text();
    const contentType = res.headers.get('Content-Type') ?? 'application/json';
    if (res.ok) {
      try {
        cache.set(url, { at: Date.now(), body: JSON.parse(text) });
      } catch {
        /* a non-JSON 200 is not cacheable; just skip it */
      }
    }
    return { text, status: res.status, contentType };
  });

  inflight.set(url, run);
  try {
    const winner = await run;
    return new Response(winner.text, {
      status: winner.status,
      headers: { 'Content-Type': winner.contentType, 'X-Cache': 'MISS' },
    });
  } finally {
    inflight.delete(url);
  }
}

/** Test seam: drop cached bodies, in-flight calls and the bucket. */
export function __resetLimiter() {
  cache.clear();
  inflight.clear();
  lastAt = 0;
  chain = Promise.resolve();
}

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
 * Pacing is per origin (scheme+host+port): a slow origin (or a hung one) must
 * never head-of-line-block an unrelated fast origin -- including a second
 * listener on the same hostname but a different port (e.g. Go :3101 vs Rust
 * :3102 sidecars). A single global chain meant one stalled upstream stalled
 * every family; per-origin chains isolate that blast radius while keeping the
 * same ≤5 req/s guarantee toward each origin. The cache and the single-flight
 * map stay keyed by full URL -- sharing is about identical bytes, pacing is
 * about the origin being asked.
 *
 * Scope note: this is per Node process, which is what a single `next start`
 * gives us. It protects the upstream from this app's own bursts, which is the
 * failure mode that actually occurs. It is not a distributed limiter -- if the
 * app is scaled to several instances each keeps its own bucket. That is an
 * acceptable trade for a read-only public feed and is stated rather than
 * implied.
 */
const MIN_GAP_MS = 200; // <= 5 upstream requests/sec, per origin
/** Deadline applied when a caller supplies no signal of its own. Without one, a
 *  fetch that never settles pins this limiter slot forever -- and because
 *  `enqueue` serialises every call for one origin through that origin's chain,
 *  it stalls every later request to the same origin too. The timeout is the
 *  backstop that keeps one hung upstream from becoming a whole-family outage.
 *  Matches the shortest per-route budget. */
const DEFAULT_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 15_000;
/** Hard cap on retained bodies. The TTL alone does NOT bound memory: an entry is
 *  only ever ignored once it is stale, never removed, and a search box mints a
 *  fresh distinct key per query. Steady-state growth would track DISTINCT
 *  QUERIES EVER MADE. This makes it bounded instead. */
const CACHE_MAX_ENTRIES = 300;
type Entry = { at: number; body: unknown };
/** What a coalesced group shares: the body text plus enough of the response to
 *  rebuild an equivalent Response per caller. */
type Shared = { text: string; status: number; contentType: string };
/** Insertion-ordered, so the first key is the least recently used. */
const cache = new Map<string, Entry>();
/** In-flight upstream calls, keyed by URL, so identical concurrent requests
 *  share one round-trip. Without this, 10 simultaneous requests for the same
 *  URL are 10 distinct cache misses that all reach upstream. */
const inflight = new Map<string, Promise<Shared>>();
/** Per-origin pacing state, keyed by `paceKey(url)`. One slow or hung origin
 *  pins only its own chain; every other origin keeps flowing. */
const chains = new Map<string, Promise<unknown>>();
const lastAts = new Map<string, number>();
/** Fallback pacing key when the URL does not parse: a single shared bucket
 *  rather than a throw inside the limiter. Unparseable input still fetches. */
const GLOBAL_KEY = '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Pacing key for a URL: its origin (scheme+host+port). Two URLs on the same
 *  origin share one gap budget; two origins never share one -- even when they
 *  differ only by port. */
function paceKey(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return GLOBAL_KEY;
  }
}


/** Read a live entry, promoting it to most-recently-used. Returns undefined for
 *  a miss or a stale entry -- and drops the stale one on the way out, so an
 *  expired body does not sit in memory until the key is evicted by pressure. */
function takeLive(url: string, ttl: number): Entry | undefined {
  const hit = cache.get(url);
  if (!hit) return undefined;
  if (Date.now() - hit.at >= ttl) {
    cache.delete(url);
    return undefined;
  }
  // Re-insert to move this key to the end (Map preserves insertion order).
  cache.delete(url);
  cache.set(url, hit);
  return hit;
}

/** Insert, evicting least-recently-used entries past the cap. */
function store(url: string, entry: Entry) {
  cache.delete(url);
  cache.set(url, entry);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Serialise access per origin so callers to one origin queue rather than
 *  bursting, while callers to other origins are unaffected. */
function enqueue<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const key = paceKey(url);
  const head = chains.get(key) ?? Promise.resolve();
  const run = head.then(async () => {
    const wait = (lastAts.get(key) ?? 0) + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastAts.set(key, Date.now());
    }
  });
  // keep the chain alive even when a link rejects
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined
    )
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
  const hit = takeLive(url, ttl);
  if (hit) {
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

  const run = enqueue(url, async () => {
    // Compose the caller's signal (if any) with a default deadline. Every call
    // site passes AbortSignal.timeout today, but the limiter must not DEPEND on
    // that: a future caller that forgets one would hang its origin's serialised
    // chain and take the whole family down, not just its own request.
    const ctl = new AbortController();
    const timer = setTimeout(
      () => ctl.abort(new Error(`limitedFetch: no response in ${DEFAULT_TIMEOUT_MS}ms`)),
      DEFAULT_TIMEOUT_MS
    );
    const caller = init.signal;
    if (caller) {
      if (caller.aborted) ctl.abort(caller.reason);
      else caller.addEventListener('abort', () => ctl.abort(caller.reason), { once: true });
    }
    try {
      const res = await fetch(url, { ...init, signal: ctl.signal });
      // Read the body ONCE, here, so the winner and every coalesced waiter all
      // get real bytes. Leaving it on the Response means the first caller drains
      // the stream and the rest see an empty body.
      const text = await res.text();
      const contentType = res.headers.get('Content-Type') ?? 'application/json';
      if (res.ok) {
        try {
          store(url, { at: Date.now(), body: JSON.parse(text) });
        } catch {
          /* a non-JSON 200 is not cacheable; just skip it */
        }
      }
      return { text, status: res.status, contentType };
    } finally {
      clearTimeout(timer);
    }
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

/** Test seam: drop cached bodies, in-flight calls and every per-origin bucket. */
export function __resetLimiter() {
  cache.clear();
  inflight.clear();
  chains.clear();
  lastAts.clear();
}

/** Test seam: what the cache currently retains. Exists so the LRU bound is
 *  assertable from outside instead of taken on trust -- an eviction policy with
 *  no observable is an eviction policy nobody ever verifies. */
export function __cacheStats() {
  return { size: cache.size, cap: CACHE_MAX_ENTRIES, inflight: inflight.size };
}

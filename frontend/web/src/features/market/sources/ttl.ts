/**
 * A tiny in-process TTL cache with single-flight and stale-while-revalidate, for
 * the CSV/text macro feeds.
 *
 * The shared limiter (`platform/http/rate-limit.ts`) micro-caches only bodies it
 * can `JSON.parse`. BIS and FRED answer CSV, so those responses are never cached
 * there and every board reload would re-hit upstream. These series move daily at
 * most, so a long TTL is correct — and the in-flight map means N simultaneous
 * reloads cost one upstream call, not N.
 *
 * Revalidate is STALE-WHILE-REVALIDATE, not blocking, because the limiter
 * serialises every upstream call through one chain with a minimum gap: a cold
 * board of ~19 memoised series pays each one's latency in turn (measured ~20s
 * for the macro route). Serving the previous value while the refresh runs means
 * only the first-ever request pays that, and every later one is instant.
 *
 * Scope matches the limiter's: per Node process, which is what one `next start`
 * gives us. Rejections are never cached, so a transient upstream failure is
 * retried on the next request rather than pinned for the whole window.
 */
type Entry = { at: number; value: unknown };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * How far past its TTL a value may still be SERVED while a refresh runs in the
 * background. Without a bound, an upstream that has been down for days would be
 * papered over with a very old body indefinitely; past this the caller waits for
 * a live read instead. Expressed as a multiple of the entry's own TTL, so one
 * rule fits a short quote cache and a 1-hour annual series.
 */
const STALE_MULTIPLIER = 6;

/** Start (and register) one run, storing its value on success. */
function refresh<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = fn()
    .then((value) => {
      store.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, run);
  return run;
}

/** Resolve `fn()` once per `key` per `ttlMs`; concurrent callers share one run. */
export function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit) {
    const age = Date.now() - hit.at;
    // Fresh — serve without touching upstream.
    if (age < ttlMs) return Promise.resolve(hit.value as T);
    // Stale but recent enough to serve: hand back the old value NOW and refresh
    // in the background. Deliberately not awaited, and a failed refresh is
    // swallowed (the run is never stored, so the next call retries) — a
    // stale-but-real body beats turning a working board into an error page. A
    // later caller while that refresh is in flight still gets the stale value
    // rather than blocking on it, which is the whole point.
    if (age < ttlMs * STALE_MULTIPLIER) {
      if (!inflight.has(key)) refresh(key, fn).catch(() => {});
      return Promise.resolve(hit.value as T);
    }
  }
  // No usable entry (or one too old to serve): single-flight a blocking read.
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  return refresh(key, fn);
}

/** Test seam: drop every memoised value. */
export function __resetMemo() {
  store.clear();
  inflight.clear();
}

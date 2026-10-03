/**
 * A tiny in-process TTL cache with single-flight, for the CSV/text macro feeds.
 *
 * The shared limiter (`platform/http/rate-limit.ts`) micro-caches only bodies it
 * can `JSON.parse`. BIS and FRED answer CSV, so those responses are never cached
 * there and every board reload would re-hit upstream. These series move daily at
 * most, so a long TTL is correct — and the in-flight map means N simultaneous
 * reloads cost one upstream call, not N.
 *
 * Scope matches the limiter's: per Node process, which is what one `next start`
 * gives us. Rejections are never cached, so a transient upstream failure is
 * retried on the next request rather than pinned for the whole window.
 */
type Entry = { at: number; value: unknown };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/** Resolve `fn()` once per `key` per `ttlMs`; concurrent callers share one run. */
export function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value as T);
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
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

/** Test seam: drop every memoised value. */
export function __resetMemo() {
  store.clear();
  inflight.clear();
}

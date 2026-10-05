/**
 * Bounded-concurrency fetch, for upstreams that do NOT rate-limit.
 *
 * The shared limiter (`lib/rate-limit.ts`) serialises EVERY call
 * through one chain with a 200ms minimum gap. That is the right shape for a host
 * that answers a burst with 429 — DexScreener, measured — but it is the wrong
 * shape for the World Bank. The annual board is ONE CALL PER INDICATOR (the API
 * rejects a `;`-joined indicator list, measured), so a deep board is dozens of
 * calls, and behind the serial chain each one pays the previous one's latency on
 * top of its own. Measured on this machine: 16 indicator calls sequential = 51s;
 * the same 16 at concurrency 6 = 0.7s, all 200; 32 concurrent calls also all 200.
 *
 * So this is a small per-pool semaphore — deliberately NOT a general-purpose
 * replacement for `limitedFetch`. Anything behind a measured rate limit keeps
 * using the limiter; a host that has been measured to tolerate concurrency gets
 * its own pool here. The cap is what keeps the parallelism polite, and every call
 * still carries a deadline, so one hung upstream cannot pin a slot and starve the
 * pool the way an un-deadlined caller would starve the limiter's single chain.
 */

/** A counting semaphore: at most `limit` holders at once, FIFO for the rest. */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

/** Deadline applied when the caller supplies no signal of its own. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Build a fetch bound to one concurrency lane. Create ONE per upstream host and
 * reuse it, so the cap is shared by every call to that host in this process.
 */
export function createFetchPool(limit: number, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`createFetchPool: limit must be a positive integer, got ${limit}`);
  }
  const sem = new Semaphore(limit);

  return async function pooledFetch(url: string, init: RequestInit = {}): Promise<Response> {
    await sem.acquire();
    // Cold-500 trace: the clock starts at slot acquisition so pool queueing
    // shows up in the elapsed figure on the failure path. Logging happens on
    // failure only — the success path below is byte-for-byte the old behavior.
    const start = Date.now();
    // Compose the caller's signal with this pool's own deadline: a caller that
    // forgets one must not be able to hold a slot forever.
    const ctl = new AbortController();
    const timer = setTimeout(
      () => ctl.abort(new Error(`pooledFetch: no response in ${timeoutMs}ms`)),
      timeoutMs
    );
    const caller = init.signal;
    if (caller) {
      if (caller.aborted) ctl.abort(caller.reason);
      else caller.addEventListener('abort', () => ctl.abort(caller.reason), { once: true });
    }
    try {
      const res = await fetch(url, { ...init, signal: ctl.signal });
      if (!res.ok) {
        console.error(
          `[pooledFetch] upstream-not-ok route=${url} status=${res.status} elapsedMs=${Date.now() - start} aborted=${ctl.signal.aborted}`
        );
      }
      return res;
    } catch (err) {
      console.error(
        `[pooledFetch] throw route=${url} elapsedMs=${Date.now() - start} aborted=${ctl.signal.aborted} reason=${String(ctl.signal.reason ?? '').slice(0, 120)} err=${err instanceof Error ? err.message : String(err)}`
      );
      throw err;
    } finally {
      clearTimeout(timer);
      sem.release();
    }
  };
}
// Client-side mutation headers.
//
// There is deliberately no auth header here any more. The retired
// `x-fud-token` was sent from NEXT_PUBLIC_FUD_MUTATION_TOKEN, which Next
// inlines at BUILD time — the value shipped verbatim in a public JS chunk,
// so any visitor could read it and write to wallets/transactions.
//
// Writes are now authorised server-side from the httpOnly `fud_session`
// cookie (lib/mutation-auth.ts), which never enters the client bundle. The
// browser only needs to send the cookie it already has, so these headers are
// just content negotiation.
export const MUT_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
};

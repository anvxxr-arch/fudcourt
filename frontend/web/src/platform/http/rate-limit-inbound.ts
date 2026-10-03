/**
 * Inbound rate limiting — per client, per time window — for the public API
 * surface.
 *
 * Relationship to `lib/rate-limit.ts`: that module paces *outbound* calls (one
 * bucket per Node process) so our own bursts cannot trip DexScreener's and
 * CryptoRank's 429s. It bounds nothing about how much work one client can ask
 * *us* for. Measured 2026-09-29 over the public hostname: 25 consecutive
 * `GET /api/cryptorank?mode=converter` all answered 200 with 921,588 bytes
 * each (~23 MB in 37 s), and `&fresh=1` skipped even the app cache, so every one
 * reached the python upstream helper. This module is the missing layer, and
 * `middleware.ts` enforces it before a route handler runs.
 *
 * Deliberate properties:
 *  - **Fail-open, never fail-closed.** A limiter bug must not take the boards
 *    down. A counter error answering "allowed" costs bandwidth; answering
 *    "refused" turns a bug into an outage, which is worse for a public
 *    read-only surface.
 *  - **Priced by payload, not by request count.** Every route body was
 *    measured on the origin (2026-09-29) and priced in PAGE_BYTES units
 *    (50 KB), rounded up. The spread is what forces this: `mode=chain` is
 *    1,190,228 B and `mode=converter` 921,588 B, while `mode=coin` is 835 B —
 *    the same route, three orders of magnitude apart. A flat request counter
 *    must be sized for the worst payload (which throttles every cheap call) or
 *    for the cheapest (which protects nothing: 60 requests of 921 KB is still
 *    55 MB).
 *  - **Bounded state.** One bucket per client, LRU-evicted at MAX_CLIENTS and
 *    pruned when stale. A flood of distinct client keys cannot grow the map
 *    without end — the same unbounded-cache bug `lib/rate-limit.ts` documents
 *    and bounds for its body cache.
 *  - **Observable.** Every decision travels with X-RateLimit-* headers and a
 *    refusal carries Retry-After, so a caller can see its budget before it is
 *    refused. Throttling nobody can see is throttling nobody can diagnose.
 *  - **Scope-aware, by peer address.** The origin recognises its own traffic
 *    from the address it actually accepted the connection from — never from
 *    the absence of a header. (Measured 2026-09-29: Next.js 16 `base-server.js`
 *    does `req.headers['x-forwarded-for'] ??= originalRequest?.socket?.remoteAddress`,
 *    so EVERY request on this host carries an XFF, which stringifies to
 *    `::ffff:127.0.0.1` on loopback. A "no proxy headers => local" test can
 *    therefore never fire in production, and this module shipped that way: the
 *    operator's harness was charged the public budget and a full
 *    `verify-cryptorank.py` run (137 units, 53 calls) was refused from
 *    call ~25. See the DR-004 amendment.) A request whose CF-Connecting-IP is
 *    absent — so it did not transit the tunnel — and whose last XFF hop is a
 *    loopback or private/link-local address is local: same accounting, much
 *    larger budget, and the scope is reported in the response rather than
 *    assumed.
 *
 * Known limits, stated rather than hidden: counters are in-memory module state
 * and the middleware entry runs once per Node process, so several instances
 * would each keep their own budget and a restart clears them. For this
 * deployment (one `next start` behind one tunnel) that is the whole population.
 * A distributed budget belongs at Cloudflare's edge; this is what the origin can
 * enforce by itself. Nothing here is persisted or touches the treasury DB.
 */

/** One price unit = 50 KB of worst-case response body. */
export const PAGE_BYTES = 50 * 1024;

export type RateScope = 'public' | 'local';

export type RateDecision = {
  allowed: boolean;
  /** Allowance for this window, in units. */
  limit: number;
  /** Units left in this window after this request. */
  remaining: number;
  /** What this request was charged. */
  cost: number;
  /** Seconds until the window rolls over. */
  resetSeconds: number;
  /** Seconds a refused client should wait; 0 when allowed. */
  retryAfterSeconds: number;
  scope: RateScope;
};

/**
 * Worst-case response bytes per cryptorank mode, measured on the origin
 * (`127.0.0.1:3100`, 2026-09-29) with the fattest documented key. Listed modes
 * are the ones above one unit; everything else — including the refused
 * funding/unlocks modes — is `DEFAULT_COST`.
 *
 * The anchors: chain 1,190,228 · converter 921,588 · tag 110,248 · tags 71,986 ·
 * gainers 57,001 · losers 56,630 · blockchains 55,834 · coins 35,878 ·
 * categories 35,953 · listings 19,285 · exchanges 14,467 · home 2,956 ·
 * coin 835.
 */
export const CR_MODE_COST: Readonly<Record<string, number>> = {
  chain: 20,
  converter: 20,
  tag: 3,
  tags: 2,
  gainers: 2,
  losers: 2,
  blockchains: 2,
};

/**
 * Worst-case bytes per other route family (measured the same way): llama
 * `mode=chains` 64,245 (protocols 20,842, historical 7,031 stay default) ·
 * ticker 69,445 for the full board, and its 64.5 s cold upstream makes it the
 * most expensive call per second as well · markets = CoinGecko top-250 pool ·
 * news 18,473 · dex profiles×50 17,766 · signals scoreboard 5,851. Families
 * absent from this table (`/api/all`, `/api/wallets`, `/api/coins`,
 * `/api/reconcile`, `/api/transactions`, the auth routes) serve empty envelopes
 * and refusals of tens of bytes.
 *
 * chainrank (692 B) and khala (mode=report worst case 84,315 B, from a 579,989 B
 * report page the sidecar reads) are NOT priced here any more: their web surfaces
 * were removed (DR-041) — the /chainrank and /khala boards and their /api/*
 * proxies are gone, so no inbound route reaches this limiter for them. The
 * sidecar families stay on :3101 as API-only surfaces.
 */
export const ROUTE_COST: Readonly<Record<string, number>> = {
  ticker: 2,
  markets: 2,
  // The market hub's asset-class boards. `stock` and `commodity` each fan out
  // one Yahoo chart call PER SYMBOL (16 and 12), so a cold board has the same
  // shape as `ticker` -- many upstream calls behind one page -- and is priced
  // the same 2. `forex` is a single call, but the family rule prices the first
  // path segment, and a sub-path must not be a cheaper way into the family.
  market: 2,
  // The executor is a money-moving surface (PRD §108 rate limiting, §77 adapter
  // rate limits). `POST /api/executor/executions` plans, sizes and persists an
  // order, and `preview` does the same pricing without persisting — both are far
  // more expensive than a ticker read, so leaving them at DEFAULT_COST (1) made
  // creating a live execution the cheapest way into the backend. Priced per the
  // same family rule: every executor sub-path inherits the price, so
  // `/api/executor/executions/:id/cancel` is not a cheaper way to trade.
  executor: 8,
};

/** Unit cost of anything not priced above. */
export const DEFAULT_COST = 1;

/**
 * Units per window. Measured against real page loads, not intuition: a full
 * `/cryptorank` mount fires 9 mode fetches totalling 32 units (home 1 + coin 1 +
 * exchanges 1 + listings 1 + blockchains 2 + chain 20 + news 1 + tags 2 + tag 3),
 * so the heavy allowance admits two full mounts a minute plus browsing. The
 * light allowance is the same ceiling expressed for routes whose worst payload
 * is one unit.
 */
export const HEAVY_ALLOWANCE = 80;
export const LIGHT_ALLOWANCE = 120;

/** How a route is classified as heavy: it can cost more than one unit. */
export function costForRequest(pathname: string, params: URLSearchParams): number {
  // Payload's API lives under the blog prefix (`/blog/cms/api/...`, DR-017), so
  // the `/api/<family>` indexing below does not apply to it. Several of its
  // endpoints are list/query-shaped and can return far more than a scalar (the
  // posts collection with `depth=2` pulls related documents, and Payload's
  // GraphQL endpoint answers arbitrary queries), so it is priced as a heavy
  // family rather than a unit — the same reasoning that makes `ticker` a 2.
  // Without this branch every Payload call would fall through to DEFAULT_COST
  // and be the cheapest way into a data-heavy backend.
  if (pathname.startsWith('/blog/cms/api/')) return 2;
  const seg = pathname.split('/')[2] ?? '';
  if (seg === 'cryptorank') return CR_MODE_COST[params.get('mode') ?? ''] ?? DEFAULT_COST;
  if (seg === 'llama') return params.get('mode') === 'chains' ? 2 : DEFAULT_COST;
  // Sub-paths inherit the family price: /api/ticker/instrument is the same data
  // family as /api/ticker and must not be a cheaper way into it.
  return ROUTE_COST[seg] ?? DEFAULT_COST;
}

/** Fixed window length. */
export const WINDOW_MS = 60_000;

/** A signed-in caller is doing real work — more room, never unlimited. */
export const AUTHED_MULTIPLIER = 3;

/** Traffic the origin accepted from its own address space; keep it out of the way. */
export const LOCAL_MULTIPLIER = 100;

/** Hard cap on retained client buckets (LRU beyond it). */
export const MAX_CLIENTS = 10_000;

/**
 * Addresses the origin treats as its own: loopback, RFC1918, link-local (v4 and
 * v6) and IPv6 unique-local. Written out rather than imported — this module
 * stays dependency-free so it can run in the edge middleware runtime.
 */
function isPrivateAddress(ip: string): boolean {
  let s = ip.trim().toLowerCase();
  if (!s) return false;
  // Strip an IPv6 bracket form and any zone index ("fe80::1%eth0").
  if (s.startsWith('[')) s = s.slice(1, s.indexOf(']') === -1 ? undefined : s.indexOf(']'));
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  // An IPv4-mapped IPv6 address (what Node reports for a loopback peer:
  // "::ffff:127.0.0.1") is an IPv4 address in a costume — classify the v4 part,
  // never the "::ffff:" prefix itself.
  if (s.startsWith('::ffff:')) s = s.slice(7);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const octets = s.split('.').map(Number);
    if (octets.some((o) => Number.isNaN(o) || o > 255)) return false;
    const [a, b] = octets;
    return (
      a === 127 || // 127.0.0.0/8  loopback
      a === 10 || //  10.0.0.0/8   private
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
      (a === 192 && b === 168) || //          192.168.0.0/16 private
      (a === 169 && b === 254) //             169.254.0.0/16 link-local
    );
  }
  return s === '::1' || /^f[cd][0-9a-f]{2}:/.test(s) || /^fe[89ab][0-9a-f]:/.test(s); // ::1, fc00::/7, fe80::/10
}
/**
 * Which client a request belongs to, and which budget scale applies.
 *
 * CF-Connecting-IP is set by Cloudflare itself, so it wins when present — and
 * its presence is also the proof the request came in through the tunnel, which
 * is why a forged `X-Forwarded-For: 127.0.0.1` cannot reach the local scope
 * through it.
 *
 * Otherwise the **last** hop of X-Forwarded-For is used, never the first: a
 * client can pre-seed earlier hops with anything, and a proxy appends the peer
 * it actually saw. Trusting the first hop would hand an attacker unlimited
 * identities.
 *
 * The local scope is then decided by that last hop's ADDRESS, not by the
 * absence of a header: Next.js synthesises XFF from the socket peer, so
 * "no headers" is an unreachable state on this deployment (measured
 * 2026-09-29 — see the module header and the DR-004 amendment). A missing last
 * hop still counts as local: nothing identified a remote client, which on this
 * origin means the connection was accepted locally.
 */
export function clientKey(headers: Headers): { key: string; scope: RateScope } {
  const cf = headers.get('cf-connecting-ip')?.trim();
  if (cf) return { key: cf, scope: 'public' };
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const hops = xff.split(',').map((hop) => hop.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) {
      return isPrivateAddress(last)
        ? { key: last, scope: 'local' }
        : { key: last, scope: 'public' };
    }
  }
  return { key: 'local', scope: 'local' };
}

type Bucket = { windowStart: number; units: number; seenAt: number };

/** Insertion-ordered, and re-inserted on every use, so the first key is LRU. */
const buckets = new Map<string, Bucket>();

/**
 * Charge one request against its client's window.
 *
 * `now` is injectable so a test can cross the window without waiting a minute;
 * production takes the default.
 */
export function checkInbound(
  clientId: string,
  pathname: string,
  opts: { now?: number; authed?: boolean; scope?: RateScope; params?: URLSearchParams } = {},
): RateDecision {
  const scope: RateScope = opts.scope ?? 'public';
  const cost = costForRequest(pathname, opts.params ?? new URLSearchParams());
  const base = cost > DEFAULT_COST ? HEAVY_ALLOWANCE : LIGHT_ALLOWANCE;
  const limit = Math.round(
    base * ((opts.authed ?? false) ? AUTHED_MULTIPLIER : 1) * (scope === 'local' ? LOCAL_MULTIPLIER : 1),
  );
  try {
    const now = opts.now ?? Date.now();
    const key = `${scope}:${clientId}`;
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
      bucket = { windowStart: now, units: 0, seenAt: now };
    } else {
      // Move to the MRU end: Map preserves insertion order.
      buckets.delete(key);
    }
    bucket.seenAt = now;
    const allowed = bucket.units + cost <= limit;
    if (allowed) bucket.units += cost;
    buckets.set(key, bucket);
    if (buckets.size > MAX_CLIENTS) {
      for (const [k, b] of buckets) {
        if (now - b.seenAt >= WINDOW_MS) buckets.delete(k);
      }
      while (buckets.size > MAX_CLIENTS) {
        const oldest = buckets.keys().next();
        if (oldest.done) break;
        buckets.delete(oldest.value);
      }
    }
    const resetSeconds = Math.ceil(Math.max(0, bucket.windowStart + WINDOW_MS - now) / 1000);
    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - bucket.units),
      cost,
      resetSeconds,
      retryAfterSeconds: allowed ? 0 : Math.max(1, resetSeconds),
      scope,
    };
  } catch {
    // Fail-open: see the module header. Reported as allowed with nothing
    // budgeted, so callers keep serving and the headers stay honest about not
    // knowing the remaining budget.
    return { allowed: true, limit, remaining: 0, cost, resetSeconds: 0, retryAfterSeconds: 0, scope };
  }
}

/** Response headers for a decision — emitted on a pass and on the 429 alike. */
export function rateHeaders(d: RateDecision): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(d.limit),
    'X-RateLimit-Remaining': String(d.remaining),
    'X-RateLimit-Reset': String(d.resetSeconds),
    'X-RateLimit-Cost': String(d.cost),
    'X-RateLimit-Scope': d.scope,
  };
}

/** Retained buckets / clear them — the LRU bound is asserted, not trusted. */
export function __bucketCount(): number {
  return buckets.size;
}

export function __resetRateLimit(): void {
  buckets.clear();
}

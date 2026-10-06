/**
 * Inbound request pricing — payload cost table for the public API surface.
 *
 * Extracted verbatim from `lib/rate-limit-inbound.ts` (cost-table
 * sub-domain). That module re-exports everything here, so existing importers
 * keep working unchanged. This file single-sources the shared pricing
 * constants; the bucket limiter consumes them via import. It stays
 * dependency-free so it can run in the edge middleware runtime.
 */

/** One price unit = 50 KB of worst-case response body. */
export const PAGE_BYTES = 50 * 1024;

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
  // The economy module's boards fan out one upstream call PER dimension/series
  // (regime reads growth/inflation/labor/liquidity/policy, compare runs N
  // indicators through the same adapters), and /api/economy routes sit at the
  // same /api/<family> level, so the family rule prices the first segment here.
  economy: 2,
  // The signals feed/index/scoreboard payloads carry full row arrays and the
  // scoreboard's catches table; a silent default would make the fattest
  // single-route payloads the cheapest way into the upstream.
  signals: 2,
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

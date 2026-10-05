/**
 * Ticker family — exchange-native market data via CCXT, keyless.
 *
 * Replaces the CoinGecko `/api/markets` family (lib/markets.ts) as the source
 * for the public ticker board. Rationale (owner, 2026-09-28): a single
 * aggregator is a single point of failure and a single point of trust, so
 * prices come from exchanges directly and are cross-checked between them.
 *
 * The cross-exchange check is the point: every quote below is relayed from
 * independent venues, and `spread` reports their divergence. A pair that
 * disagrees is a fact to display, never something to average away.
 *
 * Scope is centralized-exchange instruments only — spot, perpetual, dated
 * future and option. DEX pools are a different family (lib/dex.ts) and are
 * deliberately excluded: a DEX quote has no venue to cross-check against and
 * no order book in the same sense, so folding it into this board would put an
 * unverifiable price next to verified ones.
 *
 * Venue reachability on this host was measured, not assumed (2026-09-28);
 * see TICKER_VENUES for the per-venue, per-type table and why Binance, Kucoin
 * and Gate are excluded.
 */

/**
 * Settlement currencies we quote, and why this list exists.
 *
 * Venues list the same coin against many quotes. Measured across the venues we
 * read, BTC appears settled in AUD, AED, BRL, EUR, TRY, INR, GBP, CHF and UAH
 * at one and in USD, USDT, USDC, USDE, XUSD, USD1 at another.
 *
 * Fiat is excluded, and this is the reason: quoting BTC/AUD next to BTC/USDT
 * would present a currency conversion as a market price. The two would differ
 * by roughly the AUD/USD rate and the board would report that as a colossal
 * cross-venue spread. It is not a bug in a venue's number; it is two different
 * questions being averaged into one.
 *
 * Coin-margined derivatives (OKX's `BTC/USD:BTC-260929-84000-C`, settling in
 * BTC) ARE included, because they are real, heavily traded contracts and on
 * OKX they are the only options that actually return a price — the
 * dollar-settled twin of the same strike is listed but unpriced. Their premium
 * is denominated in the coin, not in USD, so rows are grouped by settlement and
 * never averaged across it; see the grouping key in app/api/ticker/route.ts.
 */
export const TICKER_SETTLEMENTS = ['USD', 'USDT', 'USDC', 'USDE', 'XUSD', 'USD1', 'USDD'] as const;
export type TickerSettle = (typeof TICKER_SETTLEMENTS)[number];

/**
 * True when a market settles in a currency this board will quote.
 *
 * A coin-margined derivative settles in the coin itself, which is neither fiat
 * nor a stablecoin, yet is quotable for the reason documented above: it is a
 * real contract and the row is labelled with its settlement so it is never
 * confused with a USD-quoted one.
 */
export function isQuotableSettlement(settle: string | null | undefined, base?: string | null): boolean {
  if (typeof settle !== 'string') return false;
  if (base && settle === base) return true;
  return (TICKER_SETTLEMENTS as readonly string[]).includes(settle);
}

/** Venues we read. Keep this list explicit: each is a live upstream we can lose. */
export const TICKER_EXCHANGES = [
  'okx', 'bybit', 'bitget', 'mexc', 'phemex', 'bingx', 'bitfinex', 'htx', 'coinbase', 'kraken',
] as const;
export type TickerExchange = (typeof TICKER_EXCHANGES)[number];

/**
 * The four market types, named the way ccxt names them.
 *
 * They are genuinely different instruments, not views of one price: a spot
 * quote is a claim on the asset, a perpetual is a rolling contract, a dated
 * future settles at expiry, and an option is a right with a strike. Presenting
 * them in one undifferentiated "price" column would be a lie, so a row always
 * carries its type and the UI keeps them apart.
 */
export const TICKER_TYPES = ['spot', 'swap', 'future', 'option'] as const;
export type TickerType = (typeof TICKER_TYPES)[number];

export const TICKER_TYPE_LABELS: Record<TickerType, string> = {
  spot: 'Spot',
  swap: 'Perpetual',
  future: 'Dated future',
  option: 'Option',
};

/**
 * Venues we read, and which of the four types each one actually answered from
 * this host when measured on 2026-09-28.
 *
 * This is a measured table, not a guess, and it is deliberately not "what ccxt
 * claims": ccxt's static `has` flags said OKX and Bybit both support all four,
 * and both were true, but Bybit's option *ticker* returns no price at all for
 * instruments that exist in its own market list. Per-venue reachability was
 * also established by probing, not by documentation:
 *
 *   - binance and kucoin are excluded: their futures hosts (fapi / api-futures)
 *     are TLS-intercepted on this network and fail certificate validation.
 *   - gate is excluded: connect timeout from this host.
 *
 * A venue is listed for a type only when it returned a real price for it. That
 * makes `failed` on a row a genuine anomaly rather than the normal case.
 */
export const TICKER_VENUES: Record<TickerExchange, readonly TickerType[]> = {
  okx: ['spot', 'swap', 'future', 'option'],
  bybit: ['spot', 'swap', 'future', 'option'],
  bitget: ['spot', 'swap'],
  mexc: ['spot', 'swap'],
  phemex: ['spot', 'swap'],
  bingx: ['spot', 'swap'],
  bitfinex: ['spot', 'swap'],
  htx: ['swap', 'future'],
  coinbase: ['spot', 'future'],
  kraken: ['spot'],
};

/** True when a venue was measured to serve a market type from this host. */
export function venueServes(venue: TickerExchange, type: TickerType): boolean {
  return TICKER_VENUES[venue].includes(type);
}

/** The venues to read for one market type. */
export function venuesForType(type: TickerType): TickerExchange[] {
  return TICKER_EXCHANGES.filter(v => venueServes(v, type));
}

/**
 * CoinGecko exposed a top-250 pool; exchanges do not offer an equivalent
 * keyless ranking, so the board is an explicit allowlist of pairs we can
 * actually quote. It is NOT a "top N by market cap" list and must never be
 * presented as one.
 */
export const TICKER_SYMBOLS = [
  'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT', 'DOGE/USDT',
  'ADA/USDT', 'AVAX/USDT', 'LINK/USDT', 'DOT/USDT', 'MATIC/USDT', 'LTC/USDT',
  'TRX/USDT', 'TON/USDT', 'ARB/USDT', 'OP/USDT', 'ATOM/USDT', 'NEAR/USDT',
  'APT/USDT', 'SUI/USDT', 'PEPE/USDT', 'SHIB/USDT', 'INJ/USDT', 'SEI/USDT',
  'TIA/USDT', 'RUNE/USDT', 'WIF/USDT', 'AAVE/USDT', 'UNI/USDT', 'CRV/USDT',
] as const;
export type TickerSymbol = (typeof TICKER_SYMBOLS)[number];

/**
 * The coins the ticker covers — the base half of the allowlist above, which is
 * what the detail URL carries (`/ticker/BTC`, not `/ticker/BTC/USDT`). The
 * quote currency is a property of a venue's listing, so it is not in the URL.
 *
 * A string-keyed lookup, not a `Set`: the membership is static, derived once
 * from the literal allowlist above. This is the single rule for "does this coin
 * exist". The detail page checks the route parameter against it and returns 404
 * through `notFound()`, so a coin we do not quote is not an indexable page that
 * renders an error table — the page and `/api/ticker/instruments` agree on what
 * exists instead of the page answering 200 for the coin its own API rejects
 * with 404.
 */
export const TICKER_COIN: Record<string, true> = Object.fromEntries(
  TICKER_SYMBOLS.map((s) => [s.split('/')[0] as string, true as const]),
);

/** OUR params — validated strictly in the route (400, never clamped). */
export const TICKER_SORTS = ['symbol', 'price', 'change', 'volume', 'spread'] as const;
export type TickerSort = (typeof TICKER_SORTS)[number];

export const TICKER_ORDERS = ['asc', 'desc'] as const;
export type TickerOrder = (typeof TICKER_ORDERS)[number];

export const TICKER_PAGE_SIZE_MAX = 50;
export const TICKER_SEARCH_MAX = 16;

/** One upstream sweep serves every search/sort/page for this long. */
import { l2GetJson, l2SetJson } from '@/platform/cache/valkey';

export const TICKER_TTL_MS = 60_000;

/** Timeframes the detail chart accepts. CCXT timeframe codes, not free text. */
export const TICKER_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'] as const;
export type TickerTimeframe = (typeof TICKER_TIMEFRAMES)[number];

/** Hard cap on candles returned for the chart, so a request can't be unbounded. */
export const TICKER_CANDLE_MAX = 500;

/**
 * A quote from one venue. `baseVolume` is the base asset, `quoteVolume` the
 * quote asset; exchanges disagree on which they populate per endpoint, so a
 * null is a real "this venue did not report it", never coerced to 0.
 */
export type VenueQuote = {
  exchange: TickerExchange;
  last: number;
  bid: number | null;
  ask: number | null;
  /** Venue's own 24h high/low, not derived from a candle scan. */
  high24h: number | null;
  low24h: number | null;
  baseVolume: number | null;
  quoteVolume: number | null;
  /**
   * 24h change as a fraction, straight from the venue (`percentage`). Both
   * OKX and Bybit report it natively, so it is relayed rather than derived
   * from high/low — a derived value would be wrong for a pair that made a
   * new high in the window.
   */
  change24h: number | null;
  /** Venue's own timestamp, so a stale quote is visible as stale. */
  at: number;
  /**
   * Open interest, in base units, for derivatives. Null on spot (no such
   * concept) and null when the venue's ticker omits it — ccxt does not return
   * it inline, it needs a separate fetch, so a missing value here means "we did
   * not ask or could not get it", never "the market has none".
   */
  openInterest: number | null;
  /**
   * Funding rate as a fraction (0.0001 = 0.01% per interval), perpetual only.
   * Null elsewhere, for the same reason as openInterest.
   */
  fundingRate: number | null;
};

/**
 * One dated future or option instrument.
 *
 * A future is identified by its expiry; an option additionally by its strike
 * and whether it is a call or a put. Expiry is a millisecond timestamp, which
 * is what ccxt reports and what lets the UI group strikes under a date instead
 * of showing raw epoch numbers.
 */
export type TickerInstrument = {
  /**
   * Settlement currency, e.g. 'USDT' on a Bybit future, 'USD' on an OKX one.
   *
   * This is load-bearing rather than cosmetic. The same coin has a USD-settled
   * future at one venue and a USDT-settled one at another, and their prices
   * differ by a real basis — not because a venue is wrong. Averaging or
   * "cross-checking" across the two would report that basis as venue
   * disagreement, so rows are grouped by settlement and labelled.
   */
  settle: string | null;
  /** The exchange's own symbol, e.g. 'BTC/USD:BTC-261030'. */
  symbol: string;
  type: TickerType;
  /** Expiry in ms, or null for instruments that do not expire. */
  expiry: number | null;
  /** Option strike in quote units; null for anything but options. */
  strike: number | null;
  /** 'call' | 'put'; null for anything but options. */
  optionKind: 'call' | 'put' | null;
  /** Contract size, which differs per venue and must not be assumed to be 1. */
  contractSize: number | null;
};
/**
 * One board row: the pair, every venue that quoted it, and the cross-venue
 * divergence. Fields no venue reports (market cap, circulating supply, global
 * rank) are deliberately absent rather than filled with a guess.
 */
export type TickerRow = {
  symbol: TickerSymbol;
  base: string;
  quote: string;
  /** Which of the four instrument types this row is. Rows never mix types. */
  type: TickerType;
  /** The exact instrument quoted, for derivatives; equals the pair on spot. */
  instrument: TickerInstrument;
  /** Median of the venue quotes, or null when no venue answered. */
  price: number | null;
  /**
   * 24h change in PERCENT (1.39 = +1.39%), or null if uncomputable.
   *
   * This is ccxt's `percentage` field, reported as-is — NOT a fraction. The
   * board's own `fmtPct` appends '%' with no x100, which is what fixed this
   * doc: it previously said "as a fraction (0.042 = +4.2%)", and a consumer
   * that trusted it printed +138.87% for a +1.39% move.
   */
  change24h: number | null;
  high24h: number | null;
  low24h: number | null;
  quoteVolume: number | null;
  /** Per-venue prices, so the UI can show the actual sources. */
  venues: VenueQuote[];
  /**
   * Max relative divergence across venues (0 = identical, 0.01 = 1% apart).
   * Null when fewer than two venues quoted. This is a measurement, not a
   * verdict: a wide spread on a thin pair is information, not an error.
   */
  spread: number | null;
  /** Venues that failed for this symbol; the row is still shown, honestly. */
  failed: TickerExchange[];
};


/**
 * Cross-venue divergence between two prices, in percent of their mean.
 *
 * Returns percent (not a bare fraction) so the value carries the unit its
 * consumers assume: the board appends "%", and the colour thresholds below it
 * are expressed in percent. Returns null for a non-positive mean, which is a
 * data error rather than a spread.
 */
export function spreadBetween(a: number, b: number): number | null {
  const mean = (a + b) / 2;
  if (!Number.isFinite(mean) || mean <= 0) return null;
  return (Math.abs(a - b) / mean) * 100;
}

/**
 * Reduce several venue figures to one displayed value: the median, which
 * ignores a single outlier venue instead of dragging the number with it.
 *
 * `positiveOnly` is not optional decoration — it encodes two different facts.
 * A price must be > 0 (a zero or negative price is a data error, and folding
 * it into the median would print a real-looking number). A 24h change is
 * signed and legitimately negative, so discarding the losers would have
 * turned every losing pair into a blank. Callers state which they mean.
 */
export function medianOf(values: number[], positiveOnly: boolean): number | null {
  const clean = values
    .filter(p => Number.isFinite(p) && (positiveOnly ? p > 0 : true))
    .sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

/** Median of venue prices. Null when no venue supplied a usable price. */
export function medianPrice(prices: number[]): number | null {
  return medianOf(prices, true);
}

let sweepCache: { at: number; rows: TickerRow[] } | null = null;
const SWEEP_KEY = 'fudcourt:web:ticker:sweep';

/**
 * The tiered venue-sweep cache.
 *
 * The sweep is the most expensive thing this app does: a cold process pays
 * 71-80 s for it (measured), because it is one quote per (venue, symbol, type)
 * job across ten exchanges. Optimising half of it would be worse than not
 * optimising it — measured, a process restart with a 60 s cache TTL always
 * re-paid the full sweep, since the sweep outlives the TTL. So the TTLs are
 * deliberately tiered:
 *
 *   FRESH (60 s)   prices are current; serve from memory, no refresh.
 *   STALE (1 h)    a serve-stale window. Between the two, the caller serves the
 *                  last known sweep immediately and a refresh runs in the
 *                  background, so no request ever blocks on the sweep again.
 *                  The response carries `timestamp`, so a stale read is visible
 *                  rather than passed off as current.
 *   VALKEY (1 h)   the L2, which is what makes the first call after a restart
 *                  fast: a restart discards module state but not Valkey.
 *
 * Beyond STALE nothing is served: an hour-old price is not "stale but usable",
 * it is wrong. Past that the caller waits for a real sweep, and if it fails the
 * route reports the failure instead of showing the old numbers as live.
 *
 * Rejections are never cached, in any tier, so a venue outage is retried on the
 * next request rather than being pinned for a window.
 */
export const SWEEP_FRESH_MS = TICKER_TTL_MS;
export const SWEEP_STALE_MS = 60 * 60 * 1000;

/** The freshest sweep available from memory, and its age. */
export function sweepSnapshot(): { at: number; rows: TickerRow[] } | null {
  return sweepCache;
}

/** Adopt a sweep read from the L2 as this process's memory copy. */
export function primeSweep(snapshot: { at: number; rows: TickerRow[] }): void {
  sweepCache = snapshot;
}

/** Read the L2 copy (survives restarts). Null on any miss or failure. */
export async function readSweepL2(): Promise<{ at: number; rows: TickerRow[] } | null> {
  const v = await l2GetJson<{ at: number; rows: TickerRow[] }>(SWEEP_KEY).catch(() => null);
  return v?.rows?.length ? v : null;
}

/**
 * Run one sweep and record it in memory and in the L2.
 *
 * The L2 entry is given the STALE lifetime, not the fresh one: it is the
 * restart-recovery copy, and expiring it after 60 s is exactly the bug that made
 * every post-restart request pay the full sweep.
 */
export async function runSweep(run: () => Promise<TickerRow[]>): Promise<TickerRow[]> {
  const rows = await run();
  if (!rows.length) return rows;
  sweepCache = { at: Date.now(), rows };
  await l2SetJson(SWEEP_KEY, sweepCache, SWEEP_STALE_MS).catch(() => {});
  return rows;
}

/** Rejections are never cached: a venue outage is retried, not pinned. */
export async function memoSweep(
  _ttlMs: number,
  run: () => Promise<TickerRow[]>
): Promise<TickerRow[]> {
  if (sweepCache && Date.now() - sweepCache.at < SWEEP_FRESH_MS) return sweepCache.rows;
  return runSweep(run);
}

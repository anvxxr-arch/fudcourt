/**
 * Ticker markets — settlements, venues and symbols.
 *
 * Extracted verbatim from features/market/ticker/client.ts; that module re-exports
 * everything here, so import from either path.
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

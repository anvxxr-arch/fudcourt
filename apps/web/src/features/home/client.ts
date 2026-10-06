/**
 * Home page (`/`) data contract.
 *
 * The landing page adds NO route of its own — it is a read-only composition of
 * two families that already ship:
 *
 *   - `GET /api/cryptorank?mode=home` — the CryptoRank homepage slice: the
 *     global market header (total market cap, 24h volume, BTC/ETH dominance,
 *     gas) plus the homepage funding + upcoming-ICO slices.
 *   - `GET /api/markets?limit=10` — the CoinGecko top-250 pool, first page
 *     (the same family the tracker reads).
 *
 * Both are reached through the existing thin proxies under
 * `src/app/(frontend)/api/*`, so this module mirrors their envelopes and
 * formats them; it fetches nothing and validates nothing on its own.
 *
 * Every formatter is null-tolerant and renders `—` for an absent metric. That
 * is the never-fake doctrine: a value upstream did not publish is rendered as
 * absent, never coerced to `0`. `fundingRounds[].coinName` is null on most rows
 * (CryptoRank publishes unnamed rounds), so the em-dash there is the honest
 * rendering of "no project name published", not a missing field on our side.
 */
export { DASH, fetchJson } from './client-shared';
export {
  CR_HOME_URL,
  TOP_LIMIT,
  MARKETS_TOP_URL,
  TRENDING_URL,
  GAINERS_URL,
  LOSERS_URL,
  DEFI_PROTOCOLS_URL,
  SCOREBOARD_URL,
  NEWS_URL,
  fmtUsdCompact,
  fmtPrice,
  fmtPct,
  fmtNum,
  fmtGas,
  toneOf,
  fmtDate,
} from './client-crypto';
export type {
  CrGlobal,
  CrFundingRound,
  CrUpcomingIco,
  CrHome,
  MarketCoin,
  MarketsEnvelope,
  CrTrendRow,
  CrTrending,
  CrMoverRow,
  CrMovers,
  LlamaProtocol,
  LlamaProtocols,
  NewsItem,
  NewsEnvelope,
  ScoreboardBucket,
  ScoreboardCatch,
  ScoreboardChain,
  ScoreboardPayload,
} from './client-crypto';
export {
  FOREX_URL,
  COMMODITY_URL,
  STOCK_US_URL,
  MACRO_URL,
  INDONESIA_URL,
  fmtRate,
  fmtX,
  fmtYield,
  fmtBp,
  fmtBpRaw,
  fmtIndicator,
  fmtCountCompact,
  fmtEconomy,
  fmtDelta,
  deltaDir,
  fmtPolicyRate,
  fmtYear,
} from './client-markets';
export type {
  ForexPair,
  ForexEnvelope,
  Quote,
  QuotesEnvelope,
  MacroSpread,
  MacroQuote,
  PolicyRateRow,
  IndicatorRow,
  WorldCell,
  WorldRow,
  WorldIndicatorRow,
  UpstreamFailure,
  MacroEnvelope,
  IndonesiaQuote,
  IndonesiaPolicy,
  IndonesiaEconomyRow,
  IndonesiaEnvelope,
} from './client-markets';

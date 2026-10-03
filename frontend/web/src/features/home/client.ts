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

/** CryptoRank homepage slice (`mode=home`). */
export const CR_HOME_URL = '/api/cryptorank?mode=home';

/**
 * CoinGecko top-250 pool, first page — the same family the tracker reads.
 *
 * `sort=mcap&order=desc` is passed EXPLICITLY: the route's default is
 * `sort=volume`, so a bare `?limit=10` returns the top 10 by 24h VOLUME and a
 * "top by market cap" heading over it would be a fabricated claim. `mcap`
 * restores the upstream `market_cap_desc` order verbatim.
 */
export const TOP_LIMIT = 10;
export const MARKETS_TOP_URL = `/api/markets?limit=${TOP_LIMIT}&sort=mcap&order=desc`;

/** The placeholder for an absent value — mirrors `Dash` in `components/ui/feedback`. */
export const DASH = '—';

export type CrGlobal = {
  totalMarketCap: number | null;
  totalMarketCapChangePercent: number | null;
  totalVolume24h: number | null;
  totalVolume24hChangePercent: number | null;
  btcDominance: number | null;
  btcDominanceChangePercent: number | null;
  ethDominance: number | null;
  ethDominanceChangePercent: number | null;
  allCurrencies: number | null;
  gasGwei: number | null;
};

export type CrFundingRound = {
  date: string | null;
  type: string | null;
  raiseUsd: number | null;
  valuationUsd: number | null;
  coinName: string | null;
  coinKey: string | null;
  coinIcon: string | null;
  funds: string[];
};

export type CrUpcomingIco = {
  name: string | null;
  symbol: string | null;
  key: string | null;
  platform: string | null;
  raiseUsd: number | null;
  date: string | null;
};

export type CrHome = {
  kind: string;
  upstream: string;
  fetchedAt: number;
  cache: string;
  global: CrGlobal;
  fundingRounds: CrFundingRound[];
  upcomingIco: CrUpcomingIco[];
};

export type MarketCoin = {
  symbol: string;
  name: string;
  image: string;
  lastPrice: number | null;
  priceChangePercent: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  volume: number | null;
  marketCap: number | null;
  rank: number | null;
};

export type MarketsEnvelope = {
  coins: MarketCoin[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  pool: number;
  upstream: string;
  derived: string;
  timestamp: number;
};

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Compact USD — `$2.98T`, `$20.8B`, `$5.0M`, `$1.2K`. Absent -> `—`. */
export function fmtUsdCompact(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const abs = Math.abs(v);
  if (abs >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

/**
 * A unit price with precision that follows the magnitude, so a sub-cent token
 * does not render as `$0.00` (which would read as a zero, not as a small
 * number). Absent -> `—`.
 */
export function fmtPrice(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const abs = Math.abs(v);
  if (abs === 0) return '$0';
  if (abs >= 1000) return `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (abs >= 1) return `$${v.toFixed(2)}`;
  if (abs >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toPrecision(4)}`;
}

/** Signed percent — `+0.50%` / `-59.74%`. Absent -> `—`. */
export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (!isNum(v)) return DASH;
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

/** Grouped number. Absent -> `—`. */
export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (!isNum(v)) return DASH;
  return v.toLocaleString('en-US', { maximumFractionDigits: digits });
}

/** Gas with a precision that follows the magnitude (`0.0651` vs `12.30`). Absent -> `—`. */
export function fmtGas(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return `${v.toFixed(Math.abs(v) < 1 ? 4 : 2)} Gwei`;
}

/** `positive` / `negative` / `neutral` for a signed metric — `neutral` when absent or flat. */
export function toneOf(v: number | null | undefined): 'positive' | 'negative' | 'neutral' {
  if (!isNum(v) || v === 0) return 'neutral';
  return v > 0 ? 'positive' : 'negative';
}

/** An ISO or `Date`-parseable stamp -> `YYYY-MM-DD`; anything unparseable -> `—`. */
export function fmtDate(v: string | null | undefined): string {
  if (!v) return DASH;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toISOString().slice(0, 10);
}

/** Home markets quotes domain: FX majors, commodities, US stocks. */
import { DASH, isNum } from './client-shared';

/** Cross-asset families: FX majors, commodities, US indices. */
export const FOREX_URL = '/api/market/forex';
export const COMMODITY_URL = '/api/market/commodity';
export const STOCK_US_URL = '/api/market/stock?region=us';

/** A rate with fixed 4 decimals (`1.1252`). Absent -> `—`. */
export function fmtRate(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return v.toFixed(4);
}

/** A multiplier (`3.48×`). Absent -> `—`. */
export function fmtX(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return `${v.toFixed(2)}×`;
}

export type ForexPair = {
  pair: string;
  base: string;
  quote: string;
  rate: number | null;
  inverse: number | null;
};

export type ForexEnvelope = {
  pairs: ForexPair[];
  count: number;
  base: string;
  updated: number;
  upstream: string;
  derived: string;
};

/** One Yahoo chart row — the shape both the commodity and the stock families emit. */
export type Quote = {
  symbol: string;
  name: string;
  kind: string | null;
  exchange: string | null;
  currency: string | null;
  price: number | null;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  week52High: number | null;
  week52Low: number | null;
  /** Intraday closes (5m) for the sparkline trend — present when the route serves them. */
  trend?: (number | null)[];
};

export type QuotesEnvelope = {
  quotes: Quote[];
  count: number;
  failed: string[];
  upstream: string;
  asOf: number;
  derived: string;
  region?: string;
};

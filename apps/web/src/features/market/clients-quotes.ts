import { getJSON } from '@/lib/fetch';
import { numParam as num } from '@/lib/num';

/**
 * Shared JSON-envelope transport for market providers.
 *
 * Thin wrapper over shared `@/lib/fetch` getJSON: fetches `url` with `init`
 * and optionally maps the decoded JSON through `parse`. Providers that fetch
 * CSV/text or use their own pool keep their own transport; JSON-envelope
 * call sites go through here so URLs, cache/no-store inits, error paths and
 * response shapes stay in one place.
 */
export function fetchProviderEnvelope<T>(url: string, init?: RequestInit, parse?: (json: unknown) => T): Promise<T> {
  if (parse) return getJSON<unknown>(url, init).then(parse);
  return getJSON<T>(url, init);
}

/**
 * Yahoo Finance chart family (keyless, public) -- the shared quote contract
 * behind the stock and commodity sections of the market hub.
 *
 * Yahoo's batch endpoint (`/v7/finance/quote?symbols=a,b,c`) answers
 * `401 Unauthorized` without a crumb+cookie (measured), so this uses the CHART
 * endpoint, one symbol per call. That is N upstream calls per board load; the
 * shared outbound limiter (`lib/rate-limit.ts`) serialises them at
 * <=5/s and caches each symbol's body for QUOTE_TTL_MS, so a board reload
 * inside the window costs zero upstream calls.
 *
 * Honest-by-construction: a metric the payload omits stays null (the UI renders
 * '—'), never 0-filled; a symbol that fails is reported in the route's
 * `failed[]` rather than dropped silently.
 */

/** Fixed upstream: Yahoo Finance chart (public, keyless, GET-only). */
export const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';

/** Yahoo rejects a request without a browser-shaped User-Agent. */
export const YAHOO_UA = 'Mozilla/5.0 (compatible; FUDCOURT/1.0; +https://fc.dwirijal.my.id)';

/** One upstream fetch serves every board reload inside the window. */
export const QUOTE_TTL_MS = 60_000;

/** The chart URL for one symbol (a 1-day range is all a quote row needs). */
export function chartUrl(symbol: string): string {
  const p = new URLSearchParams({ range: '1d', interval: '5m' });
  return `${YAHOO_CHART}/${encodeURIComponent(symbol)}?${p}`;
}

/** One row of the shape the stock/commodity tables render. Nulls stay null. */
export type MarketQuote = {
  symbol: string;
  name: string;
  kind: string | null;
  exchange: string | null;
  currency: string | null;
  price: number;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  week52High: number | null;
  week52Low: number | null;
  marketTime: number | null;
  /** Intraday closes (5m) for the sparkline trend; nulls filtered by the atom. */
  trend: (number | null)[];
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Yahoo chart payload -> one quote, or null when it carries no price. */
export function parseChart(json: unknown, symbol: string): MarketQuote | null {
  const result = (json as { chart?: { result?: unknown[] } } | null)?.chart?.result?.[0] as
    | { meta?: Record<string, unknown>; indicators?: { quote?: { close?: (number | null)[] }[] } }
    | undefined;
  const m = result?.meta;
  if (!m) return null;
  const price = num(m.regularMarketPrice);
  if (price === null) return null;
  const prev = num(m.chartPreviousClose) ?? num(m.previousClose);
  return {
    symbol: str(m.symbol) ?? symbol,
    name: str(m.longName) ?? str(m.shortName) ?? symbol,
    kind: str(m.instrumentType),
    exchange: str(m.fullExchangeName) ?? str(m.exchangeName),
    currency: str(m.currency),
    price,
    previousClose: prev,
    change: prev === null ? null : price - prev,
    changePercent: prev === null || prev === 0 ? null : (price / prev - 1) * 100,
    dayHigh: num(m.regularMarketDayHigh),
    dayLow: num(m.regularMarketDayLow),
    volume: num(m.regularMarketVolume),
    week52High: num(m.fiftyTwoWeekHigh),
    week52Low: num(m.fiftyTwoWeekLow),
    marketTime: num(m.regularMarketTime),
    trend: result?.indicators?.quote?.[0]?.close ?? [],
  };
}


/** Board envelope rendered by `quote-board.tsx`. */
export type QuotesBoardEnvelope = {
  quotes?: MarketQuote[];
  failed?: { symbol: string; reason: string }[];
  derived?: string;
  error?: string;
  detail?: string;
};

/** Transport for one Yahoo-quote board. The endpoint varies per section, so it stays a parameter. */
export function fetchQuotes(endpoint: string): Promise<QuotesBoardEnvelope> {
  return fetchProviderEnvelope<QuotesBoardEnvelope>(endpoint, { cache: 'no-store' });
}

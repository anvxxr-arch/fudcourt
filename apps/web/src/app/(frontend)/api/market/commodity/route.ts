import { NextResponse } from 'next/server';
import {
  COMMODITIES,
  COMMODITY_LABELS,
  COMMODITY_SYMBOLS,
  COMMODITY_TTL_MS,
} from '@/features/market/commodity-symbols';
import {
  YAHOO_CHART,
  YAHOO_UA,
  chartUrl,
  parseChart,
  type MarketQuote,
} from '@/features/market/clients';
import { limitedFetch } from '@/lib/rate-limit';
import { mapPool } from '@/app/(frontend)/api/economy/_lib/rows';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const TIMEOUT_MS = 20_000;

type Failed = { symbol: string; reason: string };
/** One symbol's outcome. The union lets `mapPool`'s ordered results be split back
 * into the same two arrays the serial loop built, in the same order. */
type QuoteOutcome = { ok: true; quote: MarketQuote } | { ok: false; failure: Failed };

/**
 * Read-only proxy to the Yahoo Finance chart endpoint (public, keyless) serving
 * the commodity board (front-month futures).
 *
 * Same contract as /api/market/stock: one call per symbol, a failed symbol is
 * reported in `failed[]` rather than dropped, a partial board is a 200, and
 * only an all-symbols failure is a 502.
 */
export async function GET() {
  const quotes: MarketQuote[] = [];
  const failed: Failed[] = [];

  const outcomes = await mapPool(COMMODITIES, 6, async (spec): Promise<QuoteOutcome> => {
    let res: Response;
    try {
      res = await limitedFetch(
        chartUrl(spec.symbol),
        { headers: { 'User-Agent': YAHOO_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) },
        { ttlMs: COMMODITY_TTL_MS }
      );
    } catch (e) {
      return { ok: false, failure: { symbol: spec.symbol, reason: `fetch failed: ${e instanceof Error ? e.message : String(e)}` } };
    }
    if (!res.ok) {
      return { ok: false, failure: { symbol: spec.symbol, reason: `upstream ${res.status}` } };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, failure: { symbol: spec.symbol, reason: 'non-JSON body' } };
    }
    const quote = parseChart(json, spec.symbol);
    if (!quote) {
      return { ok: false, failure: { symbol: spec.symbol, reason: 'no quote in payload' } };
    }
    // The curated label beats "Gold Dec 26" -- the board is a market map, not a
    // contract-calendar. Kept alongside the raw Yahoo name in the payload.
    quote.name = COMMODITY_LABELS[spec.symbol] ?? quote.name;
    return { ok: true, quote };
  });
  // `mapPool` returns in input order, so this split rebuilds exactly the arrays
  // the serial loop produced -- successes and failures alike, same sequence.
  for (const o of outcomes) {
    if (o.ok === true) quotes.push(o.quote);
    else failed.push(o.failure);
  }

  if (quotes.length === 0) {
    return NextResponse.json(
      { error: 'no quotes returned', detail: `all ${COMMODITY_SYMBOLS.length} symbols failed`, failed },
      { status: 502 }
    );
  }

  return NextResponse.json({
    quotes,
    count: quotes.length,
    failed,
    upstream: YAHOO_CHART,
    asOf: Math.floor(Date.now() / 1000),
    derived: `front-month futures; one Yahoo chart call per symbol; ${failed.length} of ${COMMODITY_SYMBOLS.length} failed`,
  });
}

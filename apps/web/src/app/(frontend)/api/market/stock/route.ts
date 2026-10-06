import { NextResponse } from 'next/server';
import {
  DEFAULT_STOCK_REGION,
  STOCK_LABELS,
  STOCK_REGIONS,
  STOCK_SYMBOLS,
  STOCK_TTL_MS,
  isStockRegion,
  type StockRegion,
} from '@/features/market/stock-regions';
import {
  YAHOO_CHART,
  YAHOO_UA,
  chartUrl,
  parseChart,
  type MarketQuote,
} from '@/features/market/clients';
import { limitedFetch } from '@/lib/rate-limit';
import { mapPool } from '@/app/(frontend)/api/economy/_lib/rows';
import { fail } from '../../_lib/http';

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
 * the stock board.
 *
 * One upstream call per symbol (the batch quote endpoint answers 401 without a
 * crumb). `region` is OUR parameter -> a value outside STOCK_REGIONS is a strict
 * 400, never clamped or silently defaulted. Honest-by-construction: a symbol
 * that fails is reported in `failed[]` with its reason rather than dropped, a
 * partial board is still a 200, and only a board where EVERY symbol failed is a
 * loud 502 -- never a fake empty 200.
 */
export async function GET(req: Request) {
  const regionParam = new URL(req.url).searchParams.get('region');
  if (regionParam !== null && !isStockRegion(regionParam)) {
    return fail('invalid region', 400, `region must be one of: ${STOCK_REGIONS.join(', ')}`);
  }
  const region: StockRegion = regionParam !== null && isStockRegion(regionParam) ? regionParam : DEFAULT_STOCK_REGION;
  const symbols = STOCK_SYMBOLS[region];

  const quotes: MarketQuote[] = [];
  const failed: Failed[] = [];
  // Per-symbol upstream freshness marks from the fan-out below, aggregated
  // into a single X-Cache header on the 200 path (HIT only if all HIT).
  const cacheMarks: string[] = [];

  const outcomes = await mapPool(symbols, 6, async (symbol: string): Promise<QuoteOutcome> => {
    let res: Response;
    try {
      res = await limitedFetch(
        chartUrl(symbol),
        { headers: { 'User-Agent': YAHOO_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) },
        { ttlMs: STOCK_TTL_MS }
      );
    } catch (e) {
      cacheMarks.push('MISS');
      return { ok: false, failure: { symbol, reason: `fetch failed: ${e instanceof Error ? e.message : String(e)}` } };
    }
    const mark = res.headers.get('X-Cache');
    cacheMarks.push(mark === 'HIT' || mark === 'COALESCED' ? mark : 'MISS');
    if (!res.ok) {
      return { ok: false, failure: { symbol, reason: `upstream ${res.status}` } };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, failure: { symbol, reason: 'non-JSON body' } };
    }
    const quote = parseChart(json, symbol);
    if (!quote) {
      return { ok: false, failure: { symbol, reason: 'no quote in payload' } };
    }
    // The curated label reads better than the raw long name (e.g. 'IDX Composite
    // (IHSG)' over 'IDX COMPOSITE'); the exchange column still carries the venue.
    quote.name = STOCK_LABELS[quote.symbol] ?? quote.name;
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
      { error: 'no quotes returned', detail: `all ${symbols.length} ${region} symbols failed`, failed },
      { status: 502 }
    );
  }

  // HIT only if EVERY upstream call was a HIT; COALESCED if any coalesced
  // and none missed; otherwise MISS.
  const cache =
    cacheMarks.length > 0 && cacheMarks.every((m) => m === 'HIT')
      ? 'HIT'
      : cacheMarks.some((m) => m === 'MISS') || cacheMarks.length === 0
        ? 'MISS'
        : 'COALESCED';
  return NextResponse.json(
    {
      region,
      quotes,
      count: quotes.length,
      failed,
      upstream: YAHOO_CHART,
      asOf: Math.floor(Date.now() / 1000),
      derived: `region=${region}; one Yahoo chart call per symbol; ${failed.length} of ${symbols.length} failed`,
    },
    { status: 200, headers: { 'X-Cache': cache } }
  );
}

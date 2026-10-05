import { NextResponse } from 'next/server';
import {
  DEFAULT_STOCK_REGION,
  STOCK_LABELS,
  STOCK_REGIONS,
  STOCK_SYMBOLS,
  STOCK_TTL_MS,
  isStockRegion,
} from '@/features/market/stock';
import {
  YAHOO_CHART,
  YAHOO_UA,
  chartUrl,
  parseChart,
  type MarketQuote,
} from '@/features/market/clients';
import { limitedFetch } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const TIMEOUT_MS = 20_000;

type Failed = { symbol: string; reason: string };

function fail(message: string, status: number, detail?: string) {
  return NextResponse.json({ error: message, ...(detail ? { detail } : {}) }, { status });
}

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
  const region = regionParam ?? DEFAULT_STOCK_REGION;
  const symbols = STOCK_SYMBOLS[region];

  const quotes: MarketQuote[] = [];
  const failed: Failed[] = [];

  for (const symbol of symbols) {
    let res: Response;
    try {
      res = await limitedFetch(
        chartUrl(symbol),
        { headers: { 'User-Agent': YAHOO_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) },
        { ttlMs: STOCK_TTL_MS }
      );
    } catch (e) {
      failed.push({ symbol, reason: `fetch failed: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    if (!res.ok) {
      failed.push({ symbol, reason: `upstream ${res.status}` });
      continue;
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      failed.push({ symbol, reason: 'non-JSON body' });
      continue;
    }
    const quote = parseChart(json, symbol);
    if (!quote) {
      failed.push({ symbol, reason: 'no quote in payload' });
      continue;
    }
    // The curated label reads better than the raw long name (e.g. 'IDX Composite
    // (IHSG)' over 'IDX COMPOSITE'); the exchange column still carries the venue.
    quote.name = STOCK_LABELS[quote.symbol] ?? quote.name;
    quotes.push(quote);
  }

  if (quotes.length === 0) {
    return NextResponse.json(
      { error: 'no quotes returned', detail: `all ${symbols.length} ${region} symbols failed`, failed },
      { status: 502 }
    );
  }

  return NextResponse.json({
    region,
    quotes,
    count: quotes.length,
    failed,
    upstream: YAHOO_CHART,
    asOf: Math.floor(Date.now() / 1000),
    derived: `region=${region}; one Yahoo chart call per symbol; ${failed.length} of ${symbols.length} failed`,
  });
}

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

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const TIMEOUT_MS = 20_000;

type Failed = { symbol: string; reason: string };

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

  for (const spec of COMMODITIES) {
    let res: Response;
    try {
      res = await limitedFetch(
        chartUrl(spec.symbol),
        { headers: { 'User-Agent': YAHOO_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) },
        { ttlMs: COMMODITY_TTL_MS }
      );
    } catch (e) {
      failed.push({ symbol: spec.symbol, reason: `fetch failed: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    if (!res.ok) {
      failed.push({ symbol: spec.symbol, reason: `upstream ${res.status}` });
      continue;
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      failed.push({ symbol: spec.symbol, reason: 'non-JSON body' });
      continue;
    }
    const quote = parseChart(json, spec.symbol);
    if (!quote) {
      failed.push({ symbol: spec.symbol, reason: 'no quote in payload' });
      continue;
    }
    // The curated label beats "Gold Dec 26" -- the board is a market map, not a
    // contract-calendar. Kept alongside the raw Yahoo name in the payload.
    quote.name = COMMODITY_LABELS[spec.symbol] ?? quote.name;
    quotes.push(quote);
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

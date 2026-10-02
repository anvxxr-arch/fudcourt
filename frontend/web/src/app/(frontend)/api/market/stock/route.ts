import { NextResponse } from 'next/server';
import { STOCK_LABELS, STOCK_SYMBOLS, STOCK_TTL_MS } from '@/features/market/stock/client';
import {
  YAHOO_CHART,
  YAHOO_UA,
  chartUrl,
  parseChart,
  type MarketQuote,
} from '@/features/market/quotes';
import { limitedFetch } from '@/platform/http/rate-limit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const TIMEOUT_MS = 20_000;

type Failed = { symbol: string; reason: string };

/**
 * Read-only proxy to the Yahoo Finance chart endpoint (public, keyless) serving
 * the stock board.
 *
 * One upstream call per symbol (the batch quote endpoint answers 401 without a
 * crumb). Honest-by-construction: a symbol that fails is reported in `failed[]`
 * with its reason rather than dropped, a partial board is still a 200, and only
 * a board where EVERY symbol failed is a loud 502 -- never a fake empty 200.
 */
export async function GET() {
  const quotes: MarketQuote[] = [];
  const failed: Failed[] = [];

  for (const symbol of STOCK_SYMBOLS) {
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
    if (quote.name === symbol) quote.name = STOCK_LABELS[symbol] ?? symbol;
    quotes.push(quote);
  }

  if (quotes.length === 0) {
    return NextResponse.json(
      { error: 'no quotes returned', detail: `all ${STOCK_SYMBOLS.length} symbols failed`, failed },
      { status: 502 }
    );
  }

  return NextResponse.json({
    quotes,
    count: quotes.length,
    failed,
    upstream: YAHOO_CHART,
    asOf: Math.floor(Date.now() / 1000),
    derived: `one Yahoo chart call per symbol; ${failed.length} of ${STOCK_SYMBOLS.length} failed`,
  });
}

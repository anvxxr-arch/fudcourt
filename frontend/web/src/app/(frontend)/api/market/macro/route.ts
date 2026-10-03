import { NextResponse } from 'next/server';
import {
  MACRO,
  MACRO_LABELS,
  MACRO_SPREADS,
  MACRO_SYMBOLS,
  MACRO_TTL_MS,
  type MacroQuote,
} from '@/features/market/macro/client';
import {
  YAHOO_CHART,
  YAHOO_UA,
  chartUrl,
  parseChart,
} from '@/features/market/quotes';
import { limitedFetch } from '@/platform/http/rate-limit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const TIMEOUT_MS = 20_000;

type Failed = { symbol: string; reason: string };
type Spread = { label: string; long: string; short: string; bp: number | null; note: string };

/**
 * Read-only proxy to the Yahoo Finance chart endpoint (public, keyless) serving
 * the macro board: the US Treasury curve (13-week / 5y / 10y / 30y), the dollar
 * index and the two volatility indices.
 *
 * Same contract as /api/market/{stock,commodity}: one call per symbol, a failed
 * symbol is reported in `failed[]` rather than dropped, a partial board is a 200,
 * and only an all-symbols failure is a loud 502 — never a fake empty 200.
 *
 * `spreads[]` is DERIVED LOCALLY (the upstream publishes no spread series) and is
 * labelled as such in `derived`. A spread whose legs are not both present stays
 * null: it is never computed against a missing leg, because that would turn "no
 * data" into a plausible-looking number.
 */
export async function GET() {
  const quotes: MacroQuote[] = [];
  const failed: Failed[] = [];

  for (const spec of MACRO) {
    let res: Response;
    try {
      res = await limitedFetch(
        chartUrl(spec.symbol),
        { headers: { 'User-Agent': YAHOO_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) },
        { ttlMs: MACRO_TTL_MS }
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
    // The curated label beats Yahoo's ("10-Year Bond", "13 WEEK TREASURY BILL")
    // — the board is a curve, not a ticker dump. The raw name stays in the payload.
    // `group`/`unit`/`note` ride along so a consumer in another feature renders the
    // row from the payload instead of importing this family across a boundary.
    quotes.push({
      ...quote,
      name: MACRO_LABELS[spec.symbol] ?? quote.name,
      group: spec.group,
      unit: spec.unit,
      note: spec.note,
    });
  }

  if (quotes.length === 0) {
    return NextResponse.json(
      { error: 'no quotes returned', detail: `all ${MACRO_SYMBOLS.length} symbols failed`, failed },
      { status: 502 }
    );
  }

  const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));
  const spreads: Spread[] = MACRO_SPREADS.map((s) => {
    const long = bySymbol.get(s.long);
    const short = bySymbol.get(s.short);
    const bp = long && short ? (long.price - short.price) * 100 : null;
    return { label: s.label, long: s.long, short: s.short, bp, note: s.note };
  });

  return NextResponse.json({
    quotes,
    spreads,
    count: quotes.length,
    failed,
    upstream: YAHOO_CHART,
    asOf: Math.floor(Date.now() / 1000),
    derived: `one Yahoo chart call per symbol; ${failed.length} of ${MACRO_SYMBOLS.length} failed; curve spreads computed locally from the quotes`,
  });
}

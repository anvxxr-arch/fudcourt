import { NextResponse } from 'next/server';
import {
  ECONOMY_COUNTRIES,
  ECONOMY_FROM_YEAR,
  ECONOMY_INDICATORS,
  FRED_LOOKBACK_DAYS,
  INDICATORS,
  MACRO,
  MACRO_LABELS,
  MACRO_SPREADS,
  MACRO_SYMBOLS,
  MACRO_TTL_MS,
  POLICY_RATES,
  POLICY_RATE_AREAS,
  type MacroQuote,
} from '@/features/market/macro/client';
import { YAHOO_CHART, YAHOO_UA, chartUrl, parseChart } from '@/features/market/quotes';
import { daysAgo, fetchPolicyRates, SOURCE_UA } from '@/features/market/sources/bis';
import { fetchFred } from '@/features/market/sources/fred';
import { fetchWorldBank } from '@/features/market/sources/worldbank';
import { limitedFetch } from '@/platform/http/rate-limit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const TIMEOUT_MS = 20_000;

type Failed = { symbol: string; reason: string };
type Spread = { label: string; long: string; short: string; bp: number | null; note: string };
type PolicyRow = { area: string; bank: string; region: string; rate: number | null; date: string | null; note: string };
type IndicatorRow = {
  id: string;
  name: string;
  group: string;
  unit: string;
  decimals: number;
  value: number | null;
  date: string | null;
  note: string;
};
type EconomyRow = {
  code: string;
  name: string;
  gdpGrowth: number | null;
  gdpYear: string | null;
  inflation: number | null;
  inflationYear: string | null;
};

/**
 * Read-only proxy serving the GLOBAL macro board, from four keyless upstreams:
 *
 *  - Yahoo Finance chart — the live Treasury curve, the dollar index and the
 *    volatility indices (one call per symbol, as the stock/commodity families do).
 *  - BIS WS_CBPOL        — central-bank policy rates, ~33 banks.
 *  - FRED CSV            — US macro series (prices, labour, money, spreads).
 *  - World Bank          — an annual GDP-growth / inflation comparison of eight
 *    major economies.
 *
 * Each upstream is fetched and reported independently: one failing empties its own
 * block and is named in `failed[]`, while the rest of the board still renders.
 * `spreads[]` is DERIVED LOCALLY (the upstream publishes no spread series) and is
 * labelled as such in `derived`; a spread whose legs are not both present stays
 * null rather than being computed against a missing leg.
 *
 * Honest-by-construction throughout: a value an upstream did not publish is null
 * (the UI renders '—'), never 0-filled, and an indicator is only ever reported
 * with the observation date it actually came from.
 */
export async function GET() {
  const failed: Failed[] = [];

  // ---- 1. live quotes (Yahoo) ----------------------------------------------
  const quotes: MacroQuote[] = [];
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

  // ---- 2. central-bank policy rates (BIS) ----------------------------------
  const byArea = new Map<string, { rate: number; date: string }>();
  try {
    for (const r of await fetchPolicyRates(POLICY_RATE_AREAS)) byArea.set(r.area, r);
  } catch (e) {
    failed.push({ symbol: 'BIS:WS_CBPOL', reason: e instanceof Error ? e.message : String(e) });
  }
  const policyRates: PolicyRow[] = POLICY_RATES.map((s) => {
    const hit = byArea.get(s.area);
    return {
      area: s.area,
      bank: s.bank,
      region: s.region,
      rate: hit?.rate ?? null,
      date: hit?.date ?? null,
      note: s.note,
    };
  });

  // ---- 3. US macro indicators (FRED) ---------------------------------------
  const cosd = daysAgo(FRED_LOOKBACK_DAYS);
  const indicators: IndicatorRow[] = await Promise.all(
    INDICATORS.map(async (spec): Promise<IndicatorRow> => {
      const base: IndicatorRow = {
        id: spec.id,
        name: spec.name,
        group: spec.group,
        unit: spec.unit,
        decimals: spec.decimals,
        value: null,
        date: null,
        note: spec.note,
      };
      try {
        const shaped = await fetchFred(spec.id, cosd, spec.shape, spec.lag);
        if (shaped) return { ...base, value: shaped.value, date: shaped.date };
        failed.push({ symbol: `FRED:${spec.id}`, reason: 'no observation in window' });
      } catch (e) {
        failed.push({ symbol: `FRED:${spec.id}`, reason: e instanceof Error ? e.message : String(e) });
      }
      return base;
    })
  );

  // ---- 4. global economy comparison (World Bank) ---------------------------
  const economyCodes = ECONOMY_COUNTRIES.map((c) => c.code);
  // Keyed by country, holding one entry per ECONOMY_INDICATORS position.
  const byCountry = new Map<string, { value: number; year: string }[]>();
  for (const spec of ECONOMY_INDICATORS) {
    try {
      for (const o of await fetchWorldBank(spec.id, economyCodes, ECONOMY_FROM_YEAR)) {
        const list = byCountry.get(o.country) ?? [];
        list.push({ value: o.value, year: o.year });
        byCountry.set(o.country, list);
      }
    } catch (e) {
      failed.push({ symbol: `WB:${spec.id}`, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  const economies: EconomyRow[] = ECONOMY_COUNTRIES.map((c) => {
    const [gdp, cpi] = byCountry.get(c.code) ?? [];
    return {
      code: c.code,
      name: c.name,
      gdpGrowth: gdp?.value ?? null,
      gdpYear: gdp?.year ?? null,
      inflation: cpi?.value ?? null,
      inflationYear: cpi?.year ?? null,
    };
  });

  // ---- derived curve spreads ----------------------------------------------
  const quoteBySymbol = new Map(quotes.map((q) => [q.symbol, q]));
  const spreads: Spread[] = MACRO_SPREADS.map((s) => {
    const long = quoteBySymbol.get(s.long);
    const short = quoteBySymbol.get(s.short);
    const bp = long && short ? (long.price - short.price) * 100 : null;
    return { label: s.label, long: s.long, short: s.short, bp, note: s.note };
  });

  // Only a TOTAL quote failure is a 502: the quote block is the board's spine.
  if (quotes.length === 0) {
    return NextResponse.json(
      { error: 'no quotes returned', detail: `all ${MACRO_SYMBOLS.length} quote symbols failed`, failed },
      { status: 502 }
    );
  }

  return NextResponse.json({
    quotes,
    spreads,
    policyRates,
    indicators,
    economies,
    count: quotes.length,
    failed,
    upstream: [YAHOO_CHART, 'stats.bis.org WS_CBPOL', 'fred.stlouisfed.org CSV', 'api.worldbank.org v2'],
    userAgent: SOURCE_UA,
    asOf: Math.floor(Date.now() / 1000),
    derived: `quotes: one Yahoo chart call per symbol; policy rates: BIS WS_CBPOL (daily, 60-day window); indicators: FRED CSV with the transform applied server-side; economy: World Bank annual, newest non-null year per country; ${failed.length} upstream item(s) failed`,
  });
}

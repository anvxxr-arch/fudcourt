import { NextResponse } from 'next/server';
import {
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
  WB_AGGREGATE_NAMES,
  WORLD_AGGREGATES,
  WORLD_CODES,
  WORLD_COUNTRIES,
  type MacroQuote,
} from '@/features/market/macro/client';
import { YAHOO_CHART, YAHOO_UA, chartUrl, parseChart } from '@/features/market/quotes';
import { daysAgo, fetchPolicyRates, SOURCE_UA } from '@/features/market/sources/bis';
import { fetchFred } from '@/features/market/sources/fred';
import { fetchWorldBankSeries } from '@/features/market/sources/worldbank';
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
/**
 * One cell of the worldwide table: the newest value, the year it was published
 * for, and — where the window holds one at least ~8 years back — an earlier
 * observation to compare it against. `prior` null means "no trend to show",
 * never "no change".
 */
type WorldCell = {
  value: number | null;
  year: string | null;
  prior: { value: number; year: string } | null;
};

/** One row of the worldwide table — a country or an aggregate. */
type WorldRow = {
  code: string;
  name: string;
  /** Grouping label: the country's region, or the aggregate's group. */
  region: string;
  /** Keyed by indicator id; a series the upstream did not publish stays absent. */
  cells: Record<string, WorldCell>;
};

/** One column of the worldwide table — the spec the UI renders the header from. */
type WorldIndicatorRow = {
  id: string;
  name: string;
  short: string;
  kind: string;
  decimals: number;
  note: string;
  /** The column block this indicator's header groups under. */
  theme: string;
};

/**
 * Read-only proxy serving the GLOBAL macro board, from four keyless upstreams:
 *
 *  - Yahoo Finance chart — the live Treasury curve, the dollar index and the
 *    volatility indices (one call per symbol, as the stock/commodity families do).
 *  - BIS WS_CBPOL        — central-bank policy rates, ~33 banks.
 *  - FRED CSV            — US macro series (prices, labour, money, spreads).
 *  - World Bank          — the WORLDWIDE annual board: 125 countries and 18
 *    aggregates (World, the four income groups, and the regional/unions blocks)
 *    across 24 themed structural series each, every cell carrying both its own
 *    reference year and — where the window holds one — its change over the
 *    decade.
 *
 * Each upstream is fetched and reported independently: one failing empties its own
 * block and is named in `failed[]`, while the rest of the board still renders.
 * `spreads[]` is DERIVED LOCALLY (the upstream publishes no spread series) and is
 * labelled as such in `derived`; a spread whose legs are not both present stays
 * null rather than being computed against a missing leg.
 *
 * Honest-by-construction throughout: a value an upstream did not publish is null
 * (the UI renders '—'), never 0-filled, and every annual cell carries the
 * reference YEAR it was published for — a World Bank figure lags, so a 2023
 * number printed without its year reads as current when it is not. A cell's
 * `prior` is null when the series has no observation far enough back to compare
 * against; that means "no trend shown", not "no change".
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

  // ---- 4. worldwide economy board (World Bank) -----------------------------
  // One call per indicator over EVERY code at once (countries batch; the
  // indicator list does not). 24 calls fill both tables, and they run through the
  // World Bank's OWN concurrency pool rather than the shared serial limiter — see
  // `sources/worldbank.ts` for the measurement that made that the right call.
  // Each call is independent: a failing series empties only its own column and is
  // named in `failed[]`, while every other column still fills.
  const cellByCode = new Map<string, Record<string, WorldCell>>();
  await Promise.all(
    ECONOMY_INDICATORS.map(async (spec) => {
      try {
        const series = await fetchWorldBankSeries(spec.id, WORLD_CODES, ECONOMY_FROM_YEAR, WB_AGGREGATE_NAMES);
        for (const s of series) {
          const cells = cellByCode.get(s.country) ?? {};
          cells[spec.id] = {
            value: s.latest.value,
            year: s.latest.year,
            prior: s.prior ? { value: s.prior.value, year: s.prior.year } : null,
          };
          cellByCode.set(s.country, cells);
        }
      } catch (e) {
        failed.push({ symbol: `WB:${spec.id}`, reason: e instanceof Error ? e.message : String(e) });
      }
    })
  );
  const economies: WorldRow[] = WORLD_COUNTRIES.map((c) => ({
    code: c.code,
    name: c.name,
    region: c.region,
    cells: cellByCode.get(c.code) ?? {},
  }));
  const aggregates: WorldRow[] = WORLD_AGGREGATES.map((a) => ({
    code: a.code,
    name: a.name,
    region: a.group,
    cells: cellByCode.get(a.code) ?? {},
  }));
  // The column specs ride in the payload for the same reason the quote metadata
  // does: the landing page renders these headers from the API rather than
  // importing the macro family across a feature boundary.
  const worldIndicators: WorldIndicatorRow[] = ECONOMY_INDICATORS.map((s) => ({
    id: s.id,
    name: s.name,
    short: s.short,
    kind: s.kind,
    decimals: s.decimals,
    note: s.note,
    theme: s.theme,
  }));

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
    worldIndicators,
    aggregates,
    economies,
    count: quotes.length,
    failed,
    upstream: [YAHOO_CHART, 'stats.bis.org WS_CBPOL', 'fred.stlouisfed.org CSV', 'api.worldbank.org v2'],
    userAgent: SOURCE_UA,
    asOf: Math.floor(Date.now() / 1000),
    derived: `quotes: one Yahoo chart call per symbol; policy rates: BIS WS_CBPOL (daily, 60-day window); indicators: FRED CSV with the transform applied server-side; worldwide board: World Bank annual, ${WORLD_COUNTRIES.length} countries + ${WORLD_AGGREGATES.length} aggregates across ${ECONOMY_INDICATORS.length} series, newest non-null year per cell, each cell compared against its observation ~10 years earlier where the window holds one; ${failed.length} upstream item(s) failed`,
  });
}

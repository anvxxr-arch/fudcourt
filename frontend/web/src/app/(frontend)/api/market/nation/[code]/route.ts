import { NextResponse } from 'next/server';
import {
  NATION_BALANCE_ID,
  NATION_BALANCE_LEGS,
  NATION_FISCAL,
  NATION_FISCAL_FROM_YEAR,
  NATION_FISCAL_IDS,
  NATION_FROM_YEAR,
  NATION_INDICATORS,
  NATION_THEMES,
  nationByCode,
  type NationSource,
} from '@/features/market/nation/client';
import { FOREX_TTL_MS, FOREX_UPSTREAM } from '@/features/market/forex/client';
import { POLICY_RATES } from '@/features/market/macro/client';
import { SOURCE_UA, fetchPolicyRates } from '@/features/market/sources/bis';
import { fetchImfFiscal } from '@/features/market/sources/imf';
import {
  fetchWorldBankSeries,
  pickLatestAndPrior,
  type WorldBankPoint,
} from '@/features/market/sources/worldbank';
import { limitedFetch } from '@/platform/http/rate-limit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const TIMEOUT_MS = 20_000;

type Failed = { symbol: string; reason: string };

/** One cell of the profile: newest published value, its year, and a comparison point. */
type Cell = {
  value: number | null;
  year: string | null;
  prior: { value: number; year: string } | null;
};

/** One row of the profile — a World Bank series or an IMF fiscal series. */
type Row = {
  id: string;
  name: string;
  kind: string;
  decimals: number;
  note: string;
  source: NationSource;
  value: number | null;
  year: string | null;
  prior: { value: number; year: string } | null;
};

/** One themed column block; blocks with no published value are dropped upstream. */
type Block = { theme: string; rows: Row[] };

/** The currency against the dollar, as the forex feed publishes it. */
type Fx = {
  currency: string;
  base: string;
  /** Units of `currency` per 1 unit of `base` (i.e. per USD). */
  rate: number | null;
  inverse: number | null;
  updated: number | null;
};

type Policy = { area: string; bank: string; region: string; rate: number | null; date: string | null; note: string };

/**
 * Whether an indicator is one of the two legs the budget balance is derived from.
 * Typed against `NATION_BALANCE_LEGS` so adding a leg to that tuple cannot
 * silently stop being collected here.
 */
function isBalanceLeg(id: string): id is (typeof NATION_BALANCE_LEGS)[number] {
  return (NATION_BALANCE_LEGS as readonly string[]).includes(id);
}

/**
 * Read-only proxy serving ONE country's economy profile, from four keyless
 * upstreams:
 *
 *  - World Bank (annual)     — the structural profile: the same series the
 *    worldwide board carries, fetched for this country alone (the API batches
 *    countries, not indicators, so this is one call per series). Every cell
 *    keeps the year it was published FOR, and a cell's `prior` is the
 *    observation ~10 years earlier where the window holds one.
 *  - IMF Fiscal Monitor      — the government-finance block, ACTUALS ONLY.
 *  - BIS WS_CBPOL (daily)    — the policy rate, where BIS carries one.
 *  - open.er-api.com (daily) — the currency against the dollar.
 *
 * Honest-by-construction, same rules as the board routes:
 *  - a value an upstream did not publish is null (the UI renders '—'), never
 *    0-filled, and a cell's `prior` is null when there is no observation far
 *    enough back — "no trend shown", not "no change";
 *  - a themed block whose EVERY row is unpublished is DROPPED from the payload
 *    and named in `droppedThemes`. A wall of em dashes is not information, and
 *    the World Bank publishes no government-finance series for a large minority
 *    of countries — that gap belongs in the payload as a stated omission;
 *  - the derived balance needs both legs in the SAME year. A 2024 revenue minus
 *    a 2023 expense is not any year's balance, so a country whose legs never
 *    share a year gets no balance cell rather than a fabricated one;
 *  - one upstream failing empties only its own block and is named in `failed[]`.
 *
 * Only a total failure of BOTH the annual profile and the fiscal block is a 502:
 * a page with one of the two is still a page.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const nation = nationByCode(code ?? '');
  if (!nation) {
    return NextResponse.json(
      { error: 'unknown country code', detail: `${JSON.stringify(code ?? '')} is not one of the countries this board covers` },
      { status: 404 }
    );
  }

  const failed: Failed[] = [];

  // ---- 1. the currency against the dollar (exchangerate-api) ---------------
  let fx: Fx | null = null;
  try {
    const res = await limitedFetch(FOREX_UPSTREAM, { signal: AbortSignal.timeout(TIMEOUT_MS) }, { ttlMs: FOREX_TTL_MS });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const body = (await res.json()) as {
      result?: string;
      base_code?: string;
      rates?: Record<string, number>;
      time_last_update_unix?: number;
    };
    if (body.result !== 'success' || !body.rates) throw new Error('upstream returned no rates');
    const base = body.base_code ?? 'USD';
    // A country whose currency IS the base (the United States) is a real row at
    // parity, not a missing one — but it is not a "rate" either, so it says so.
    const rate = nation.currency === base ? 1 : body.rates[nation.currency];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(`the feed does not carry ${nation.currency}`);
    }
    fx = {
      currency: nation.currency,
      base,
      rate,
      inverse: 1 / rate,
      updated: typeof body.time_last_update_unix === 'number' ? body.time_last_update_unix : null,
    };
  } catch (e) {
    failed.push({ symbol: `FX:${nation.currency}`, reason: e instanceof Error ? e.message : String(e) });
  }

  // ---- 2. the policy rate (BIS) -------------------------------------------
  let policy: Policy | null = null;
  if (nation.policyArea) {
    const spec = POLICY_RATES.find((p) => p.area === nation.policyArea);
    policy = {
      area: nation.policyArea,
      bank: spec?.bank ?? nation.policyArea,
      region: spec?.region ?? '',
      rate: null,
      date: null,
      note: spec?.note ?? '',
    };
    try {
      const [hit] = await fetchPolicyRates([nation.policyArea]);
      if (hit) policy = { ...policy, rate: hit.rate, date: hit.date };
      else failed.push({ symbol: `BIS:${nation.policyArea}`, reason: 'no observation in window' });
    } catch (e) {
      failed.push({ symbol: `BIS:${nation.policyArea}`, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // ---- 3. the structural profile (World Bank) ------------------------------
  // One call per series (the API rejects a `;`-separated indicator list), all
  // through the World Bank's own concurrency pool. `NATION_BALANCE_ID` is
  // filtered out — it has no upstream series of its own; its two legs are
  // fetched as normal series and the balance is derived from them in step 3b.
  const cellById = new Map<string, Cell>();
  const legPoints = new Map<string, readonly WorldBankPoint[]>();
  await Promise.all(
    NATION_INDICATORS.filter((spec) => spec.id !== NATION_BALANCE_ID).map(async (spec) => {
      try {
        const [series] = await fetchWorldBankSeries(spec.id, [nation.code], NATION_FROM_YEAR);
        if (!series) return;
        cellById.set(spec.id, {
          value: series.latest.value,
          year: series.latest.year,
          prior: series.prior ? { value: series.prior.value, year: series.prior.year } : null,
        });
        if (isBalanceLeg(spec.id)) legPoints.set(spec.id, series.points);
      } catch (e) {
        failed.push({ symbol: `WB:${spec.id}`, reason: e instanceof Error ? e.message : String(e) });
      }
    })
  );

  // ---- 3b. derived budget balance -----------------------------------------
  // revenue − expense, but ONLY for years where BOTH legs carry an observation.
  // The difference between a 2024 revenue and a 2023 expense is not any year's
  // balance — it is a number no agency ever published — so a country whose legs
  // never share a year gets NO balance cell rather than a fabricated one.
  {
    const revenue = legPoints.get(NATION_BALANCE_LEGS[0]);
    const expense = legPoints.get(NATION_BALANCE_LEGS[1]);
    if (revenue && expense) {
      const expenseByYear = new Map(expense.map((p) => [p.year, p.value]));
      const points: WorldBankPoint[] = [];
      for (const p of revenue) {
        const spent = expenseByYear.get(p.year);
        if (spent === undefined) continue;
        points.push({ year: p.year, value: p.value - spent });
      }
      if (points.length > 0) {
        const { latest, prior } = pickLatestAndPrior(points);
        cellById.set(NATION_BALANCE_ID, {
          value: latest.value,
          year: latest.year,
          prior: prior ? { value: prior.value, year: prior.year } : null,
        });
      }
    }
  }

  const wbRows: Row[] = NATION_INDICATORS.map((spec) => {
    const cell = cellById.get(spec.id);
    return {
      id: spec.id,
      name: spec.name,
      kind: spec.kind,
      decimals: spec.decimals,
      note: spec.note,
      source: 'World Bank' as const,
      value: cell?.value ?? null,
      year: cell?.year ?? null,
      prior: cell?.prior ?? null,
    };
  });

  // Drop a block whose every row is unpublished, and say which. Rendering eight
  // em dashes under a heading asserts a block exists where the upstream has
  // nothing; naming the omission is the honest version of the same fact.
  const blocks: Block[] = [];
  const droppedThemes: string[] = [];
  for (const theme of NATION_THEMES) {
    const rows = wbRows.filter((r) => NATION_INDICATORS.find((s) => s.id === r.id)?.theme === theme);
    if (rows.length === 0) continue;
    if (rows.every((r) => r.value === null)) {
      droppedThemes.push(theme);
      continue;
    }
    blocks.push({ theme, rows });
  }

  // ---- 4. government finance (IMF Fiscal Monitor) --------------------------
  // Actuals only: the vintage runs years past its publication date with no flag
  // separating an outturn from a forecast, so `fetchImfFiscal` keeps the years it
  // could report as actuals and reports how many projections it withheld.
  let fiscal: { vintage: string; published: string; actualThrough: number; droppedProjections: number } | null = null;
  let fiscalRows: Row[] = NATION_FISCAL.map((spec) => ({
    id: spec.id,
    name: spec.name,
    kind: spec.kind,
    decimals: spec.decimals,
    note: spec.note,
    source: 'IMF Fiscal Monitor' as const,
    value: null,
    year: null,
    prior: null,
  }));
  try {
    const imf = await fetchImfFiscal(nation.code, NATION_FISCAL_FROM_YEAR, NATION_FISCAL_IDS);
    fiscal = {
      vintage: imf.vintage,
      published: imf.published,
      actualThrough: imf.actualThrough,
      droppedProjections: imf.droppedProjections,
    };
    const byId = new Map(imf.series.map((s) => [s.indicator, s.points]));
    fiscalRows = fiscalRows.map((row) => {
      const points = byId.get(row.id) ?? [];
      const latest = points.length > 0 ? points[points.length - 1] : undefined;
      if (!latest) {
        failed.push({ symbol: `IMF:${row.id}`, reason: 'no published actual in window' });
        return row;
      }
      const { prior } = pickLatestAndPrior([...points]);
      return { ...row, value: latest.value, year: latest.year, prior: prior ? { value: prior.value, year: prior.year } : null };
    });
  } catch (e) {
    fiscal = null;
    fiscalRows = [];
    failed.push({ symbol: 'IMF:FM', reason: e instanceof Error ? e.message : String(e) });
  }

  const annualCount = wbRows.filter((r) => r.value !== null).length + fiscalRows.filter((r) => r.value !== null).length;
  if (annualCount === 0 && fx === null && !policy) {
    return NextResponse.json(
      { error: 'no data returned', detail: `no World Bank series, no IMF actual, no FX rate and no policy rate resolved for ${nation.code}`, failed },
      { status: 502 }
    );
  }

  return NextResponse.json({
    nation: {
      code: nation.code,
      iso2: nation.iso2,
      name: nation.name,
      region: nation.region,
      currency: nation.currency,
      income: nation.income,
      capital: nation.capital,
    },
    fx,
    policy,
    blocks,
    droppedThemes,
    fiscal,
    fiscalRows,
    failed,
    upstream: [
      'api.worldbank.org v2 (annual)',
      'api.imf.org SDMX 2.1 (IMF.FAD Fiscal Monitor)',
      'stats.bis.org WS_CBPOL (daily)',
      FOREX_UPSTREAM,
    ],
    userAgent: SOURCE_UA,
    asOf: Math.floor(Date.now() / 1000),
    derived: `structural profile: World Bank annual for ${nation.code}, newest non-null year per series, each compared against its observation ~10 years earlier where the window holds one; budget balance (${NATION_BALANCE_ID}) derived here as revenue − expense for a year BOTH legs observe, never across two reference years; government finance: IMF Fiscal Monitor actuals only${fiscal ? ` (${fiscal.vintage}, published ${fiscal.published.slice(0, 10)}, actuals through ${fiscal.actualThrough}, ${fiscal.droppedProjections} projection year(s) withheld)` : ' unavailable'}; fx: ${fx ? `${fx.base}/${fx.currency}` : 'unavailable'}; policy: ${policy ? `BIS ${policy.area}` : 'not carried by BIS'}; ${blocks.length} block(s) rendered, ${droppedThemes.length} dropped as unpublished; ${failed.length} upstream item(s) failed`,
  });
}

/**
 * The economy module's PROVIDER ADAPTERS (plan Phase 11).
 *
 * WHY THIS LIVES IN THE ROUTE LAYER AND NOT IN `features/economy`. The structure
 * gate forbids a feature from importing another feature, and these adapters read
 * `features/market` (FRED, the World Bank, BIS). Putting them in `app/`
 * is not a workaround — it is the layering the plan asks for: the domain
 * (`features/economy`) owns the taxonomy, the model and the registry, and knows
 * nothing about a provider; only the route layer, which is allowed to depend on
 * both, joins the two. A view that imported this file would be reaching past the
 * API contract, which is the thing the split exists to prevent.
 *
 * NORMALISATION, NOT PASS-THROUGH. Every upstream here answers in its own shape —
 * FRED a two-column CSV of levels, the World Bank an annual JSON array, BIS a
 * daily SDMX CSV. Each is reduced to the same `EconomicObservation[]`, with the
 * series' declared `shape`/`lag` applied HERE so that a caller never has to know
 * that `us-cpi` needs a 12-period year-ago transform while `id-cpi` is already a
 * percentage. The transform is per-INDICATOR (the registry decides it per
 * binding), never per-source, because the same source serves both kinds.
 *
 * THE HONESTY RULES, ENFORCED IN CODE:
 *  - a missing observation is `null`, never `0` — FRED's `.`, BIS's `NaN` and an
 *    absent World Bank row all become `null`;
 *  - a transform whose base the window does not carry is `null`, not a number
 *    computed over a shorter span;
 *  - the derived balance is emitted ONLY for a year BOTH legs observe — a 2024
 *    revenue minus a 2023 expense is not any year's balance.
 */
import { limitedFetch } from '@/lib/rate-limit';
import { BIS_ACCEPT, SOURCE_UA, bisUrl, daysAgo } from '@/features/market/bis';
import { FRED_TTL_MS, fredUrl, parseFredCsv } from '@/features/market/fred';
import { fetchWorldBankSeries } from '@/features/market/worldbank';
import { memo } from '@/features/market/bis';
import { DERIVED_LEGS } from '@/features/economy/model';
import type { EconomicIndicator, EconomicObservation, Frequency, ValueShape } from '@/features/economy/model';

const TIMEOUT_MS = 25_000;
const BIS_TTL_MS = 30 * 60_000;

/** One dated point, before any transform. */
type Point = { date: string; value: number };

/**
 * How much history to ask a date-keyed upstream for, per frequency. Enough to
 * fill a chart and to cover the transform's own lag, without dragging a decade
 * of daily rows through the limiter for a series that prints every day.
 */
function fredWindowDays(freq: Frequency): number {
  switch (freq) {
    case 'daily':
      return 365 * 2;
    case 'weekly':
      return 365 * 4;
    case 'monthly':
      return 365 * 8;
    case 'quarterly':
      return 365 * 20;
    default:
      return 365 * 30;
  }
}

/** Annual upstreams: years of history to request. */
function wbWindowYears(freq: Frequency): number {
  return freq === 'annual' ? 30 : 20;
}

function isoDaysAgo(days: number, now = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The shaped value at index `i`. `level` reads the point as published; `yoy`
 * and `change` need the point `lag` rows back, and return `null` when the window
 * does not reach it — the base is genuinely absent, and a shorter-span number
 * wearing a "YoY" label is worse than a gap.
 */
function shapedAt(points: readonly Point[], i: number, shape: ValueShape, lag: number): number | null {
  const p = points[i];
  if (!p) return null;
  if (shape === 'level') return p.value;
  if (lag < 1 || i < lag) return null;
  const base = points[i - lag];
  if (shape === 'change') return p.value - base.value;
  if (base.value === 0) return null;
  return (p.value / base.value - 1) * 100;
}

function toObservations(points: readonly Point[], ind: EconomicIndicator): EconomicObservation[] {
  return points.map((p, i) => ({
    indicatorId: ind.slug,
    date: p.date,
    value: shapedAt(points, i, ind.shape, ind.lag),
    previous: i > 0 ? shapedAt(points, i - 1, ind.shape, ind.lag) : null,
    // Neither FRED's graph CSV nor the World Bank's JSON exposes a revision
    // alongside the current value; claiming one would be invention.
    revised: null,
  }));
}

// ---------------------------------------------------------------------------
// BIS: a daily SDMX CSV, and the one place the parsed body is kept as a SERIES
// rather than reduced to its latest point (`sources/bis.ts` only needs the head).
// ---------------------------------------------------------------------------

function parseBisRows(text: string, area: string): Point[] {
  const lines = text.split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  const iArea = header.indexOf('REF_AREA');
  const iTime = header.indexOf('TIME_PERIOD');
  const iVal = header.indexOf('OBS_VALUE');
  if (iArea < 0 || iTime < 0 || iVal < 0) return [];
  // Columns 0–4 (DATAFLOW, FREQ, REF_AREA, TIME_PERIOD, OBS_VALUE) never carry a
  // comma; the quoted fields that DO start at SUPP_INFO_BREAKS, well after the
  // three indices read here. A naive split is therefore safe for these columns.
  const byDate = new Map<string, number>();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length <= iVal) continue;
    if (cols[iArea] !== area) continue;
    const raw = cols[iVal];
    if (!raw || raw === 'NaN') continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    byDate.set(cols[iTime], value);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, value]) => ({ date, value }));
}

async function readBis(ind: EconomicIndicator): Promise<Point[]> {
  const url = bisUrl([ind.sourceSeriesId], daysAgo(365 * 6));
  return memo(`eco:bis:${ind.sourceSeriesId}`, BIS_TTL_MS, async () => {
    const res = await limitedFetch(url, {
      headers: { Accept: BIS_ACCEPT, 'User-Agent': SOURCE_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`BIS upstream ${res.status}`);
    return parseBisRows(await res.text(), ind.sourceSeriesId);
  });
}

// ---------------------------------------------------------------------------
// FRED: keyless graph CSV of LEVELS; the transform is applied after parse.
// ---------------------------------------------------------------------------

async function readFredPoints(seriesId: string, cosd: string): Promise<Point[]> {
  const url = fredUrl(seriesId, cosd);
  return memo(`eco:fred:${seriesId}:${cosd}`, FRED_TTL_MS, async () => {
    const res = await limitedFetch(url, {
      headers: { 'User-Agent': SOURCE_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`FRED upstream ${res.status}`);
    return parseFredCsv(await res.text());
  });
}

// ---------------------------------------------------------------------------
// World Bank: annual JSON, plus the derived-balance path.
// ---------------------------------------------------------------------------

async function readWorldBankPoints(ind: EconomicIndicator): Promise<Point[]> {
  const fromYear = new Date().getFullYear() - wbWindowYears(ind.frequency);
  const [series] = await fetchWorldBankSeries(ind.sourceSeriesId, [ind.country ?? ''], fromYear);
  if (!series) return [];
  return series.points.map((p) => ({ date: p.year, value: p.value }));
}

/**
 * A derived series: `legs[0] − legs[1]` for the years BOTH legs publish. The
 * join is on the exact year string, so a country whose legs never share a year
 * yields an empty list and the indicator renders `—` — the honest outcome, since
 * the difference of two different reference years is not a balance anyone
 * published.
 */
async function readDerivedPoints(ind: EconomicIndicator): Promise<Point[]> {
  const key = ind.sourceSeriesId.replace(/^derived:/, '');
  const legs = DERIVED_LEGS[key];
  if (!legs || !ind.country) return [];
  const fromYear = new Date().getFullYear() - wbWindowYears(ind.frequency);
  const [a, b] = await Promise.all(
    legs.map((code) => fetchWorldBankSeries(code, [ind.country as string], fromYear))
  );
  const first = a[0];
  const second = b[0];
  if (!first || !second) return [];
  const byYear = new Map(second.points.map((p) => [p.year, p.value]));
  const out: Point[] = [];
  for (const p of first.points) {
    const other = byYear.get(p.year);
    if (other === undefined) continue;
    out.push({ date: p.year, value: p.value - other });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The one entry point the routes use.
// ---------------------------------------------------------------------------

/**
 * Read a canonical indicator's full observation history, ascending by date.
 *
 * Throws when the upstream fails — the route turns that into a named `failed[]`
 * entry so a gap is never silent. An empty array is a legitimate answer (the
 * upstream simply has nothing for this country), and is NOT an error.
 */
export async function readObservations(ind: EconomicIndicator): Promise<EconomicObservation[]> {
  let points: Point[];
  switch (ind.source) {
    case 'fred':
      points = await readFredPoints(ind.sourceSeriesId, isoDaysAgo(fredWindowDays(ind.frequency)));
      break;
    case 'bis':
      points = await readBis(ind);
      break;
    case 'worldbank':
      points = ind.sourceSeriesId.startsWith('derived:')
        ? await readDerivedPoints(ind)
        : await readWorldBankPoints(ind);
      break;
    default:
      throw new Error(`no adapter for source '${String(ind.source)}'`);
  }
  return toObservations(points, ind);
}

/** The newest observation that actually carries a value, or null. */
export function latestOf(obs: readonly EconomicObservation[]): EconomicObservation | null {
  for (let i = obs.length - 1; i >= 0; i--) {
    if (obs[i].value !== null) return obs[i];
  }
  return null;
}

/**
 * The expected next publication, DERIVED from the last observation's date and
 * the series' own cadence — never presented as an agency's official schedule.
 * Returns null when the cadence is annual or slower (a year-away date is not a
 * calendar entry) or when the last date cannot be parsed.
 */
export function nextExpected(ind: EconomicIndicator, lastDate: string | null): string | null {
  if (!lastDate) return null;
  const step: Record<string, { months: number } | null> = {
    daily: null,
    weekly: { months: 0 },
    monthly: { months: 1 },
    quarterly: { months: 3 },
    annual: null,
  };
  const s = step[ind.frequency];
  if (!s) return null;
  const base = /^\d{4}-\d{2}(-\d{2})?$/.test(lastDate)
    ? new Date(`${lastDate.length === 7 ? `${lastDate}-01` : lastDate}T00:00:00Z`)
    : null;
  if (!base || Number.isNaN(base.getTime())) return null;
  const next = new Date(base);
  if (ind.frequency === 'weekly') next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + s.months);
  return next.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Liquidity (plan Phase 9). Each component is a real, named FRED series — the
// list is fixed here because a liquidity board is a CURATED basket, and
// `direction` states which way a rising value pushes liquidity so the index
// below cannot silently invert a component.
// ---------------------------------------------------------------------------

export type LiquiditySpec = {
  id: string;
  label: string;
  seriesId: string;
  unit: string;
  decimals: number;
  /** `+1`: rising = looser liquidity. `-1`: rising = tighter. */
  direction: 1 | -1;
  /** Multiply the raw series to reach the printed unit (FRED prints $M for WALCL). */
  scale: number;
  note: string;
};

export const LIQUIDITY_COMPONENTS: readonly LiquiditySpec[] = [
  { id: 'fed-bs', label: 'Fed balance sheet', seriesId: 'WALCL', unit: 'US$', decimals: 2, direction: 1, scale: 1e6, note: 'Federal Reserve total assets, weekly (WALCL)' },
  { id: 'boj-bs', label: 'BoJ balance sheet', seriesId: 'JPNASSETS', unit: '¥100M', decimals: 0, direction: 1, scale: 1, note: 'Bank of Japan total assets, monthly (JPNASSETS)' },
  { id: 'rrp', label: 'Reverse repo', seriesId: 'RRPONTSYD', unit: 'US$B', decimals: 1, direction: -1, scale: 1, note: 'Overnight reverse repurchase agreements, daily (RRPONTSYD). A rising RRP drains reserves.' },
  { id: 'reserves', label: 'Bank reserves', seriesId: 'WRESBAL', unit: 'US$M', decimals: 0, direction: 1, scale: 1, note: 'Reserve balances with Federal Reserve Banks, weekly (WRESBAL)' },
  { id: 'tga', label: 'Treasury General Account', seriesId: 'WTREGEN', unit: 'US$M', decimals: 0, direction: -1, scale: 1, note: 'U.S. Treasury General Account, weekly (WTREGEN). A rising TGA drains reserves.' },
  { id: 'm2', label: 'M2', seriesId: 'M2SL', unit: 'US$B', decimals: 0, direction: 1, scale: 1, note: 'M2 money stock, monthly (M2SL)' },
  { id: 'dxy', label: 'Broad dollar index', seriesId: 'DTWEXBGS', unit: 'index', decimals: 2, direction: -1, scale: 1, note: 'Nominal broad U.S. dollar index, daily (DTWEXBGS). A stronger dollar tightens global conditions.' },
  { id: 'nfci', label: 'Financial conditions', seriesId: 'NFCI', unit: 'index', decimals: 3, direction: -1, scale: 1, note: 'Chicago Fed National Financial Conditions Index, weekly (NFCI). Positive = tighter than average.' },
  { id: 'credit', label: 'IG credit spread', seriesId: 'BAMLC0A0CM', unit: 'pp', decimals: 2, direction: -1, scale: 1, note: 'ICE BofA US Corporate Index option-adjusted spread, daily (BAMLC0A0CM). Wider = tighter.' },
];

/** Read one liquidity component as a level series (no transform). */
export async function readLiquiditySeries(spec: LiquiditySpec): Promise<Point[]> {
  const cosd = isoDaysAgo(365 * 2);
  const points = await readFredPoints(spec.seriesId, cosd);
  return points.map((p) => ({ date: p.date, value: p.value * spec.scale }));
}

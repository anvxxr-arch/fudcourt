import { NextResponse } from 'next/server';
import {
  IDR_QUOTES,
  IDR_QUOTE_LABELS,
  IDR_QUOTE_NOTES,
  IDR_QUOTE_SYMBOLS,
  IDR_QUOTE_TTL_MS,
  ID_COUNTRY,
  ID_ECONOMY,
  ID_ECONOMY_FROM_YEAR,
  ID_APBN,
  ID_APBN_FROM_YEAR,
  ID_APBN_IDS,
  ID_POLICY_AREA,
  ID_POLICY_LABEL,
} from '@/features/market/clients';
import { YAHOO_CHART, YAHOO_UA, chartUrl, parseChart } from '@/features/market/clients';
import { fetchPolicyRates, SOURCE_UA } from '@/features/market/bis';
import { fetchWorldBank } from '@/features/market/worldbank';
import { fetchImfFiscal } from '@/features/market/imf';
import { limitedFetch } from '@/lib/rate-limit';
import { mapPool } from '@/app/(frontend)/api/economy/_lib/rows';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const TIMEOUT_MS = 20_000;

type Failed = { symbol: string; reason: string };
type IdrQuote = {
  symbol: string;
  name: string;
  group: string;
  note: string;
  price: number;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  currency: string | null;
  marketTime: number | null;
};
type Policy = { area: string; label: string; rate: number | null; date: string | null; note: string };
/** One symbol's outcome. The union lets `mapPool`'s ordered results be split back
 * into the same two arrays the serial loop built, in the same order. */
type IdrOutcome = { ok: true; quote: IdrQuote } | { ok: false; failure: Failed };
type EconomyRow = {
  id: string;
  name: string;
  group: string;
  kind: string;
  decimals: number;
  value: number | null;
  year: string | null;
  note: string;
};

/**
 * Read-only proxy serving the INDONESIA macro board, from three keyless upstreams:
 *
 *  - Yahoo Finance chart — LIVE rupiah crosses and the two headline IDX indices
 *    (one call per symbol, as the stock/commodity families do).
 *  - BIS WS_CBPOL        — the BI-Rate.
 *  - World Bank          — annual structural indicators (growth, prices, external
 *    accounts, social). These lag by design, so every row carries the YEAR it came
 *    from; an annual figure printed without its year reads as current when it is not.
 *  - IMF Fiscal Monitor  — general-government revenue/expenditure/balance/debt.
 *    The World Bank publishes none of these for Indonesia (obs=0 on the raw API),
 *    and the vintage runs years past its publication date with no flag separating
 *    an outturn from a forecast — so `sources/imf.ts` keeps only the actuals and
 *    reports the withheld projection years in `apbn`.
 *
 * Each upstream is fetched and reported independently: one failing empties its own
 * block and is named in `failed[]` while the rest of the board still renders. An
 * indicator the World Bank has not published stays null (the UI renders '—'),
 * never 0-filled, and a quote symbol that fails is reported rather than dropped.
 */
export async function GET() {
  const failed: Failed[] = [];
  // Per-symbol upstream freshness marks from the Yahoo fan-out below,
  // aggregated into a single X-Cache header on the 200 path (HIT only if
  // all HIT). The BIS/World Bank/IMF helpers return parsed data, not
  // Responses, so they contribute no freshness mark.
  const cacheMarks: string[] = [];

  // ---- 1. live quotes (Yahoo) ----------------------------------------------
  const quotes: IdrQuote[] = [];
  const outcomes = await mapPool(IDR_QUOTES, 6, async (spec): Promise<IdrOutcome> => {
    let res: Response;
    try {
      res = await limitedFetch(
        chartUrl(spec.symbol),
        { headers: { 'User-Agent': YAHOO_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) },
        { ttlMs: IDR_QUOTE_TTL_MS }
      );
    } catch (e) {
      cacheMarks.push('MISS');
      return { ok: false, failure: { symbol: spec.symbol, reason: `fetch failed: ${e instanceof Error ? e.message : String(e)}` } };
    }
    const mark = res.headers.get('X-Cache');
    cacheMarks.push(mark === 'HIT' || mark === 'COALESCED' ? mark : 'MISS');
    if (!res.ok) {
      return { ok: false, failure: { symbol: spec.symbol, reason: `upstream ${res.status}` } };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, failure: { symbol: spec.symbol, reason: 'non-JSON body' } };
    }
    const q = parseChart(json, spec.symbol);
    if (!q) {
      return { ok: false, failure: { symbol: spec.symbol, reason: 'no quote in payload' } };
    }
    return { ok: true, quote: {
      symbol: q.symbol,
      name: IDR_QUOTE_LABELS[spec.symbol] ?? q.name,
      group: spec.group,
      note: IDR_QUOTE_NOTES[spec.symbol] ?? '',
      price: q.price,
      previousClose: q.previousClose,
      change: q.change,
      changePercent: q.changePercent,
      currency: q.currency,
      marketTime: q.marketTime,
    } };
  });
  // `mapPool` returns in input order, so this split rebuilds exactly the arrays
  // the serial loop produced -- successes and failures alike, same sequence.
  for (const o of outcomes) {
    if (o.ok === true) quotes.push(o.quote);
    else failed.push(o.failure);
  }

  // ---- 2. the BI-Rate (BIS) ------------------------------------------------
  let policy: Policy = { area: ID_POLICY_AREA, label: ID_POLICY_LABEL, rate: null, date: null, note: 'Bank Indonesia 7-day reverse repo rate' };
  try {
    const [hit] = await fetchPolicyRates([ID_POLICY_AREA]);
    if (hit) policy = { ...policy, rate: hit.rate, date: hit.date };
    else failed.push({ symbol: `BIS:${ID_POLICY_AREA}`, reason: 'no observation in window' });
  } catch (e) {
    failed.push({ symbol: `BIS:${ID_POLICY_AREA}`, reason: e instanceof Error ? e.message : String(e) });
  }

  // ---- 3. structural indicators (World Bank) -------------------------------
  const economy: EconomyRow[] = await Promise.all(
    ID_ECONOMY.map(async (spec): Promise<EconomyRow> => {
      const base: EconomyRow = {
        id: spec.id,
        name: spec.name,
        group: spec.group,
        kind: spec.kind,
        decimals: spec.decimals,
        value: null,
        year: null,
        note: spec.note,
      };
      try {
        const [obs] = await fetchWorldBank(spec.id, [ID_COUNTRY], ID_ECONOMY_FROM_YEAR);
        if (obs) return { ...base, value: obs.value, year: obs.year };
        failed.push({ symbol: `WB:${spec.id}`, reason: 'no published observation' });
      } catch (e) {
        failed.push({ symbol: `WB:${spec.id}`, reason: e instanceof Error ? e.message : String(e) });
      }
      return base;
    })
  );

  // ---- 4. government finance / APBN (IMF Fiscal Monitor) -------------------
  // The World Bank publishes NONE of these for Indonesia (measured: obs=0 on the
  // raw API), so they come from the IMF's Fiscal Monitor vintage. That vintage
  // runs years past its publication date and carries no flag separating an
  // outturn from a forecast, so `fetchImfFiscal` keeps only the years it could
  // report as ACTUALS and reports how many projections it dropped — which is
  // why a 2030 projection can never be printed here as the current value.
  let apbn: { vintage: string; published: string; actualThrough: number; droppedProjections: number } | null = null;
  try {
    const fiscal = await fetchImfFiscal(ID_COUNTRY, ID_APBN_FROM_YEAR, ID_APBN_IDS);
    apbn = {
      vintage: fiscal.vintage,
      published: fiscal.published,
      actualThrough: fiscal.actualThrough,
      droppedProjections: fiscal.droppedProjections,
    };
    const byId = new Map(fiscal.series.map((s) => [s.indicator, s]));
    for (const spec of ID_APBN) {
      const base: EconomyRow = {
        id: spec.id,
        name: spec.name,
        group: spec.group,
        kind: spec.kind,
        decimals: spec.decimals,
        value: null,
        year: null,
        note: spec.note,
      };
      const points = byId.get(spec.id)?.points ?? [];
      const last = points.length > 0 ? points[points.length - 1] : undefined;
      if (last) {
        economy.push({ ...base, value: last.value, year: last.year });
      } else {
        economy.push(base);
        failed.push({ symbol: `IMF:${spec.id}`, reason: 'no published actual in window' });
      }
    }
  } catch (e) {
    failed.push({ symbol: 'IMF:FM', reason: e instanceof Error ? e.message : String(e) });
  }

  // Only a total failure of BOTH the live quotes and the annual block is a 502;
  // a board with one of the two is still a board.
  const live = quotes.length + (policy.rate === null ? 0 : 1);
  const annual = economy.filter((e) => e.value !== null).length;
  if (live === 0 && annual === 0) {
    return NextResponse.json(
      {
        error: 'no data returned',
        detail: `all ${IDR_QUOTE_SYMBOLS.length} quote symbols failed and no World Bank indicator resolved`,
        failed,
      },
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
      quotes,
      policy,
      economy,
      apbn,
      count: quotes.length,
      failed,
      upstream: [YAHOO_CHART, 'stats.bis.org WS_CBPOL', 'api.worldbank.org v2', 'api.imf.org SDMX 2.1 (IMF.FAD Fiscal Monitor)'],
      userAgent: SOURCE_UA,
      asOf: Math.floor(Date.now() / 1000),
      derived: `quotes: one Yahoo chart call per symbol (live); policy: BIS WS_CBPOL; economy: World Bank annual, newest non-null year per indicator; government finance: IMF Fiscal Monitor vintage${apbn ? ` ${apbn.vintage} (published ${apbn.published.slice(0, 10)}, actuals through ${apbn.actualThrough}, ${apbn.droppedProjections} projection year(s) withheld)` : ' unavailable'}; ${failed.length} upstream item(s) failed`,
    },
    { status: 200, headers: { 'X-Cache': cache } }
  );
}

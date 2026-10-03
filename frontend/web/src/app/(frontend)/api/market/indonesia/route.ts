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
  ID_POLICY_AREA,
  ID_POLICY_LABEL,
} from '@/features/market/indonesia/client';
import { YAHOO_CHART, YAHOO_UA, chartUrl, parseChart } from '@/features/market/quotes';
import { fetchPolicyRates, SOURCE_UA } from '@/features/market/sources/bis';
import { fetchWorldBank } from '@/features/market/sources/worldbank';
import { limitedFetch } from '@/platform/http/rate-limit';

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
 *
 * Each upstream is fetched and reported independently: one failing empties its own
 * block and is named in `failed[]` while the rest of the board still renders. An
 * indicator the World Bank has not published stays null (the UI renders '—'),
 * never 0-filled, and a quote symbol that fails is reported rather than dropped.
 */
export async function GET() {
  const failed: Failed[] = [];

  // ---- 1. live quotes (Yahoo) ----------------------------------------------
  const quotes: IdrQuote[] = [];
  for (const spec of IDR_QUOTES) {
    let res: Response;
    try {
      res = await limitedFetch(
        chartUrl(spec.symbol),
        { headers: { 'User-Agent': YAHOO_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) },
        { ttlMs: IDR_QUOTE_TTL_MS }
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
    const q = parseChart(json, spec.symbol);
    if (!q) {
      failed.push({ symbol: spec.symbol, reason: 'no quote in payload' });
      continue;
    }
    quotes.push({
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
    });
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

  return NextResponse.json({
    quotes,
    policy,
    economy,
    count: quotes.length,
    failed,
    upstream: [YAHOO_CHART, 'stats.bis.org WS_CBPOL', 'api.worldbank.org v2'],
    userAgent: SOURCE_UA,
    asOf: Math.floor(Date.now() / 1000),
    derived: `quotes: one Yahoo chart call per symbol (live); policy: BIS WS_CBPOL; economy: World Bank annual, newest non-null year per indicator; ${failed.length} upstream item(s) failed`,
  });
}

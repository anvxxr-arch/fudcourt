import { getJSON } from '@/lib/fetch';

/**
 * client.ts — the treasury family's data client for `/api/treasury`.
 *
 * One endpoint, five modes (see `@/server/treasury`): `history`, `analytics`,
 * `breakdown`, `attribution`, `diff`. The types below mirror the route's JSON
 * exactly; the shell reads them and never reshapes, so a field added
 * server-side shows up here without a second definition to drift.
 *
 * The route is team-gated, so every call carries the session cookie the shell
 * already holds (same-origin `fetch` sends it by default). `cache: 'no-store'`
 * keeps the board live — the whole point of the time machine is that the last
 * point is *now*, and a cached series would freeze the right edge.
 */

export type TreasuryRange = '24h' | '7d' | '30d' | '90d';
export type TreasuryGroup = 'total' | 'chain' | 'wallet' | 'asset';
export type TreasuryBucket = '5m' | '15m' | '1h' | '6h' | '1d';
export type TreasuryDimension = 'chain' | 'wallet' | 'asset';

export type HistoryPoint = { t: string; key: string; v: number };

export type HistoryResult = {
  range: TreasuryRange;
  bucket: TreasuryBucket;
  group: TreasuryGroup;
  keys: string[];
  points: HistoryPoint[];
  buckets: number;
  /** True sync observations in the window (runs, not rows). */
  observations: number;
};

export type Analytics = {
  range: TreasuryRange;
  observations: number;
  firstTs: string | null;
  lastTs: string | null;
  current: number | null;
  first: number | null;
  changeUsd: number | null;
  changePct: number | null;
  ath: number | null;
  athTs: string | null;
  low: number | null;
  lowTs: string | null;
  drawdownPct: number | null;
  volatilityDailyPct: number | null;
};

export type BreakdownRow = {
  key: string;
  label: string;
  color: string | null;
  emoji: string | null;
  current: number;
  first: number;
  changeUsd: number;
  changePct: number | null;
  sharePct: number | null;
  peak: number;
  peakTs: string | null;
};

export type BreakdownResult = {
  range: TreasuryRange;
  dimension: TreasuryDimension;
  observations: number;
  fromTs: string | null;
  toTs: string | null;
  totalCurrent: number;
  totalFirst: number;
  rows: BreakdownRow[];
};

export type DiffRow = {
  chain: string;
  asset: string;
  wallet: string;
  from: number;
  to: number;
  delta: number;
  deltaPct: number | null;
};

export type DiffReason = {
  date: string;
  chain: string;
  asset: string;
  event: string;
  amountUsd: number | null;
  direction: string;
  memo: string | null;
  hash: string | null;
  url: string | null;
  source: string;
};

export type DiffResult = {
  range: TreasuryRange;
  fromTs: string | null;
  toTs: string | null;
  observations: number;
  rows: DiffRow[];
  reasons: DiffReason[];
};

/** The window length to request per range, chosen so the point count stays sane. */
export const RANGE_BUCKET: Record<TreasuryRange, TreasuryBucket> = {
  '24h': '5m',
  '7d': '1h',
  '30d': '6h',
  '90d': '1d',
};

export function loadHistory(
  group: TreasuryGroup,
  range: TreasuryRange,
  bucket: TreasuryBucket = RANGE_BUCKET[range],
): Promise<HistoryResult> {
  const qs = new URLSearchParams({ mode: 'history', group, range, bucket });
  return getJSON<HistoryResult>(`/api/treasury?${qs}`, { cache: 'no-store' });
}

export function loadAnalytics(range: TreasuryRange): Promise<Analytics> {
  return getJSON<Analytics>(`/api/treasury?mode=analytics&range=${range}`, { cache: 'no-store' });
}

export function loadBreakdown(dimension: TreasuryDimension, range: TreasuryRange): Promise<BreakdownResult> {
  return getJSON<BreakdownResult>(`/api/treasury?mode=breakdown&dimension=${dimension}&range=${range}`, {
    cache: 'no-store',
  });
}

export function loadDiff(range: TreasuryRange): Promise<DiffResult> {
  return getJSON<DiffResult>(`/api/treasury?mode=diff&range=${range}`, { cache: 'no-store' });
}

/**
 * One (key, asset) decomposed: the window's change for it split into the part
 * the price moved and the part the book moved. `opened`/`closed` say WHY a price
 * effect is 0 (nothing to reprice / no end price), which is not the same claim as
 * "the price did not move".
 */
export type AttributionPair = {
  key: string;
  asset: string;
  startQty: number;
  endQty: number;
  startValueUsd: number;
  endValueUsd: number;
  startPrice: number | null;
  endPrice: number | null;
  deltaUsd: number;
  priceEffectUsd: number;
  flowEffectUsd: number;
  opened: boolean;
  closed: boolean;
  priceSharePct: number | null;
};

/** One dimension key, aggregated over its assets. */
export type AttributionRow = {
  key: string;
  startValueUsd: number;
  endValueUsd: number;
  deltaUsd: number;
  priceEffectUsd: number;
  flowEffectUsd: number;
  priceSharePct: number | null;
  assets: number;
  openedAssets: number;
  closedAssets: number;
};

export type Attribution = {
  dimension: TreasuryDimension;
  range: TreasuryRange;
  observations: number;
  fromTs: string | null;
  toTs: string | null;
  /** Null when the window held one observation: there is no change to attribute. */
  totalStartUsd: number | null;
  totalEndUsd: number | null;
  totalDeltaUsd: number | null;
  totalPriceEffectUsd: number | null;
  totalFlowEffectUsd: number | null;
  residualUsd: number | null;
  marketSharePct: number | null;
  singleObservation: boolean;
  rows: AttributionRow[];
  pairs: AttributionPair[];
};

export function loadAttribution(dimension: TreasuryDimension, range: TreasuryRange): Promise<Attribution> {
  const qs = new URLSearchParams({ mode: 'attribution', dimension, range });
  return getJSON<Attribution>(`/api/treasury?${qs}`, { cache: 'no-store' });
}

// ---------------------------------------------------------------------------
// Cost basis + P&L (DR-046). `/api/pnl` is read-only; the price materialization
// is an operator/schedule action, not a client one.
// ---------------------------------------------------------------------------

export type BasisRow = {
  chain: string;
  asset: string;
  costBasisUsd: number | null;
  realizedUsd: number | null;
  unmatchedOutUsd: number;
  currentValueUsd: number;
  unrealizedUsd: number | null;
  stranded: boolean;
  lots: number;
  inUsd: number;
  outUsd: number;
  txCount: number;
};

export type PnlSummary = {
  rows: BasisRow[];
  totalCostBasisUsd: number;
  totalCurrentValueUsd: number;
  basisCurrentValueUsd: number;
  totalUnrealizedUsd: number | null;
  totalRealizedUsd: number | null;
  unbasisAssets: number;
  strandedAssets: number;
  txCount: number;
};

export type PriceCoverageRow = {
  symbol: string;
  source: string;
  points: number;
  firstTs: string | null;
  lastTs: string | null;
};

export type PriceSeries = {
  symbol: string;
  source: string;
  points: { t: string; price: number }[];
  latest: number | null;
  latestTs: string | null;
};

export function loadPnl(): Promise<PnlSummary> {
  return getJSON<PnlSummary>('/api/pnl?mode=summary', { cache: 'no-store' });
}

export function loadPriceCoverage(): Promise<{ rows: PriceCoverageRow[] }> {
  return getJSON<{ rows: PriceCoverageRow[] }>('/api/pnl?mode=coverage', { cache: 'no-store' });
}

export function loadPriceSeries(symbol: string, source = 'implied'): Promise<PriceSeries> {
  const qs = new URLSearchParams({ mode: 'prices', symbol, source });
  return getJSON<PriceSeries>(`/api/pnl?${qs}`, { cache: 'no-store' });
}

// ---------------------------------------------------------------------------
// The derived double-entry journal (DR-047). Read-only; the `journal` table has
// no writer by design, so nothing here mutates.
// ---------------------------------------------------------------------------

export type PairKind = 'fee' | 'pnl' | 'external' | 'internal';

export type JournalEntry = {
  txId: number;
  date: string;
  code: string;
  memo: string;
  debitAccount: string;
  creditAccount: string;
  amount: number | null;
  chain: string;
  asset: string | null;
  event: string;
  direction: string | null;
  kind: PairKind;
};

export type TrialRow = {
  code: string;
  name: string;
  type: string;
  statement: string;
  synthetic: boolean;
  debit: number;
  credit: number;
  net: number;
  balance: number;
};

export type TrialBalance = {
  rows: TrialRow[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
  diff: number;
  entryCount: number;
  unpriced: number;
};

export type FlowBucket = {
  key: 'operating' | 'external' | 'internal';
  label: string;
  netUsd: number;
  inflowUsd: number;
  outflowUsd: number;
  entries: number;
};

export type Flows = {
  buckets: FlowBucket[];
  netUsd: number;
  internalUnmatchedUsd: number;
  feesUsd: number;
  realizedPnlUsd: number;
  entryCount: number;
  unpriced: number;
};

export function loadJournalEntries(limit?: number): Promise<{ entries: JournalEntry[] }> {
  const qs = new URLSearchParams({ mode: 'entries' });
  if (limit && limit > 0) qs.set('limit', String(limit));
  return getJSON<{ entries: JournalEntry[] }>(`/api/journal?${qs}`, { cache: 'no-store' });
}

export function loadTrialBalance(): Promise<TrialBalance> {
  return getJSON<TrialBalance>('/api/journal?mode=trial', { cache: 'no-store' });
}

export function loadFlows(): Promise<Flows> {
  return getJSON<Flows>('/api/journal?mode=flows', { cache: 'no-store' });
}

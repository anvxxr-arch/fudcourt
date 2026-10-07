/**
 * pnl.ts — cost basis and P&L over the transaction ledger, plus the implied
 * price series (DR-046).
 *
 * TWO SOURCES, TWO HONEST LIMITS.
 *
 * 1. Cost basis comes from `transactions`. Those rows carry a signed
 *    `amount_usd` and an `IN`/`OUT` direction, but no per-unit quantity — so
 *    the basis is computed in USD, not in coin lots: an `IN` opens a lot at its
 *    USD cost, an `OUT` consumes lots first-in-first-out and books
 *    `proceeds − consumed_cost` as realized P&L. This is a USD-level FIFO, and
 *    it is the strongest statement the data supports.
 *
 * 2. Prices come from `asset_history`, which already stores each holding's
 *    `quantity` and `value_usd` per sync. Their ratio IS a unit price
 *    (`value_usd / quantity`), so `price_history` can be materialized from data
 *    the sync already wrote — no network call, no invented number. The rows are
 *    tagged `source = 'implied'` so a future real feed can coexist and be
 *    compared rather than overwrite.
 *
 * NEVER-FAKE. A holding with no transactions has no basis — its cost is `null`,
 * not `0`, and the board says so. When `OUT` exceeds every open lot (a sale of
 * something we never saw bought), the unmatched proceeds are reported in
 * `unmatchedOutUsd` and `realizedUsd` is `null` for that asset, because a
 * realized figure computed against a missing basis would be a fabrication.
 */
import 'server-only';
import { query, type Row } from './db';

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const round2 = (v: number): number => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Price materialization
// ---------------------------------------------------------------------------

/**
 * Materialize implied unit prices from `asset_history` into `price_history`.
 *
 * Idempotent: the unique index on `(symbol, ts, source)` plus `ON CONFLICT DO
 * NOTHING` means re-running after a sync inserts only the new observations, so
 * this is safe to call on a schedule. Rows with no quantity or no value are
 * skipped — a price needs both a numerator and a denominator.
 */
export async function backfillImpliedPrices(): Promise<{ inserted: number }> {
  const rows = await query(
    `WITH ins AS (
       INSERT INTO price_history (ts, symbol, source, price)
       SELECT ts, asset, 'implied', (value_usd / quantity)::float8
       FROM asset_history
       WHERE quantity IS NOT NULL AND quantity > 0
         AND value_usd IS NOT NULL AND value_usd > 0
       ON CONFLICT (symbol, ts, source) DO NOTHING
       RETURNING 1
     )
     SELECT count(*)::int AS n FROM ins`,
  );
  return { inserted: Number(((rows[0] ?? {}) as Row).n ?? 0) };
}

export type PricePoint = { t: string; price: number };

export type PriceSeries = {
  symbol: string;
  source: string;
  points: PricePoint[];
  latest: number | null;
  latestTs: string | null;
};

/** The materialized price series for one symbol, newest last. */
export async function priceSeries(symbol: string, source = 'implied'): Promise<PriceSeries> {
  const rows = await query(
    `SELECT ts, price::float8 AS price FROM price_history
     WHERE symbol = ? AND source = ?
     ORDER BY ts ASC`,
    [symbol, source],
  );
  const points: PricePoint[] = [];
  for (const r of rows as Row[]) {
    const p = num(r.price);
    if (p === null) continue;
    points.push({ t: new Date(String(r.ts)).toISOString(), price: p });
  }
  const last = points[points.length - 1] ?? null;
  return {
    symbol,
    source,
    points,
    latest: last ? last.price : null,
    latestTs: last ? last.t : null,
  };
}

/** Which symbols have a materialized price series, and how deep. */
export async function priceCoverage(): Promise<{ symbol: string; source: string; points: number; firstTs: string | null; lastTs: string | null }[]> {
  const rows = await query(
    `SELECT symbol, source, count(*)::int AS n, min(ts) AS first_ts, max(ts) AS last_ts
     FROM price_history GROUP BY symbol, source ORDER BY n DESC`,
  );
  return (rows as Row[]).map((r) => ({
    symbol: String(r.symbol),
    source: String(r.source),
    points: Number(r.n ?? 0),
    firstTs: r.first_ts === null || r.first_ts === undefined ? null : new Date(String(r.first_ts)).toISOString(),
    lastTs: r.last_ts === null || r.last_ts === undefined ? null : new Date(String(r.last_ts)).toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Cost basis / P&L
// ---------------------------------------------------------------------------

export type BasisRow = {
  chain: string;
  asset: string;
  /** USD still invested in the open lots (FIFO remainder). */
  costBasisUsd: number | null;
  /** USD realized on closed lots. Null when any OUT had no matching lot. */
  realizedUsd: number | null;
  /** Proceeds from OUTs that matched no open lot — the reason realized is null. */
  unmatchedOutUsd: number;
  /** Current market value of the holding (`assets.value_usd`). */
  currentValueUsd: number;
  /**
   * currentValueUsd − costBasisUsd, or null. Null when there is no basis, and
   * also when there is no OPEN position (current value 0): a basis with nothing
   * left to mark is not an unrealized loss — the position left the venue, and
   * whether that was a sale or a transfer is not something this ledger records.
   */
  unrealizedUsd: number | null;
  /** True when a basis exists but the holding is no longer on the books. */
  stranded: boolean;
  lots: number;
  inUsd: number;
  outUsd: number;
  txCount: number;
};

export type PnlSummary = {
  rows: BasisRow[];
  totalCostBasisUsd: number;
  /** Current value of the WHOLE portfolio (every holding row). */
  totalCurrentValueUsd: number;
  /** Current value of only the holdings that have a basis. */
  basisCurrentValueUsd: number;
  /** basisCurrentValueUsd − totalCostBasisUsd, or null with no basis at all. */
  totalUnrealizedUsd: number | null;
  totalRealizedUsd: number | null;
  /** Holdings with a current value but no transaction history at all. */
  unbasisAssets: number;
  /** Holdings whose basis is known but which no longer hold a position. */
  strandedAssets: number;
  txCount: number;
};

type Tx = { date: string; chain: string; asset: string; amount_usd: number | null; direction: string | null; id: number };

/**
 * FIFO over one asset's transactions. Lots are USD cost buckets; an OUT walks
 * them oldest-first and books the difference. Returns the open-lot remainder,
 * the realized total, and the proceeds that matched nothing.
 */
function fifoLots(txs: Tx[]): { remaining: number; realized: number; unmatched: number; lots: number } {
  const lots: number[] = [];
  let realized = 0;
  let unmatched = 0;
  let opened = 0;
  for (const t of txs) {
    const amt = t.amount_usd ?? 0;
    if (t.direction === 'IN') {
      const cost = Math.abs(amt);
      if (cost > 0) {
        lots.push(cost);
        opened += 1;
      }
    } else if (t.direction === 'OUT') {
      let proceeds = Math.abs(amt);
      while (proceeds > 1e-9 && lots.length > 0) {
        const head = lots[0];
        if (head <= proceeds + 1e-9) {
          realized += proceeds - head;
          proceeds -= head;
          lots.shift();
        } else {
          lots[0] = head - proceeds;
          proceeds = 0;
        }
      }
      if (proceeds > 1e-9) unmatched += proceeds;
    }
  }
  return { remaining: lots.reduce((a, b) => a + b, 0), realized, unmatched, lots: lots.length };
}

/**
 * The P&L summary: every `(chain, asset)` that has either a transaction history
 * or a current holding. Rows are keyed by chain+asset (the granularity the
 * ledger and the holdings table share) and sorted by current value, so the
 * biggest position leads.
 */
export async function pnlSummary(): Promise<PnlSummary> {
  const txRows = (await query(
    `SELECT id, date, chain, asset, amount_usd::float8 AS amount_usd, direction
     FROM transactions
     WHERE asset IS NOT NULL AND asset <> ''
     ORDER BY date ASC, id ASC`,
  )) as Row[];

  const holdRows = (await query(
    `SELECT chain, asset, sum(value_usd)::float8 AS value
     FROM assets GROUP BY chain, asset`,
  )) as Row[];

  const groups = new Map<string, Tx[]>();
  const key = (chain: string, asset: string) => `${chain}\u0000${asset}`;
  for (const r of txRows) {
    const t: Tx = {
      id: Number(r.id),
      date: String(r.date),
      chain: String(r.chain),
      asset: String(r.asset),
      amount_usd: num(r.amount_usd),
      direction: r.direction === null || r.direction === undefined ? null : String(r.direction),
    };
    const k = key(t.chain, t.asset);
    const arr = groups.get(k) ?? [];
    arr.push(t);
    groups.set(k, arr);
  }

  const valueByKey = new Map<string, number>();
  for (const r of holdRows as Row[]) valueByKey.set(key(String(r.chain), String(r.asset)), Number(r.value ?? 0));

  const allKeys = new Set<string>([...groups.keys(), ...valueByKey.keys()]);

  const rows: BasisRow[] = [];
  for (const k of allKeys) {
    const [chain, asset] = k.split('\u0000');
    const txs = groups.get(k) ?? [];
    const { remaining, realized, unmatched, lots } = fifoLots(txs);
    const inUsd = txs.filter((t) => t.direction === 'IN').reduce((a, t) => a + Math.abs(t.amount_usd ?? 0), 0);
    const outUsd = txs.filter((t) => t.direction === 'OUT').reduce((a, t) => a + Math.abs(t.amount_usd ?? 0), 0);
    const currentValueUsd = valueByKey.get(k) ?? 0;
    // A basis exists only if we actually saw an acquisition; otherwise null.
    const hasBasis = inUsd > 0;
    const costBasisUsd = hasBasis ? round2(remaining) : null;
    const realizedUsd = hasBasis && unmatched <= 1e-9 ? round2(realized) : null;
    // An open position is one still worth something. A basis with zero current
    // value is a position that left the venue — no unrealized figure is honest
    // for it, so mark it stranded instead of booking a phantom loss.
    const stranded = hasBasis && currentValueUsd <= 1e-9;
    rows.push({
      chain,
      asset,
      costBasisUsd,
      realizedUsd,
      unmatchedOutUsd: round2(unmatched),
      currentValueUsd: round2(currentValueUsd),
      unrealizedUsd: costBasisUsd === null || stranded ? null : round2(currentValueUsd - costBasisUsd),
      stranded,
      lots,
      inUsd: round2(inUsd),
      outUsd: round2(outUsd),
      txCount: txs.length,
    });
  }

  rows.sort((a, b) => b.currentValueUsd - a.currentValueUsd || (b.costBasisUsd ?? 0) - (a.costBasisUsd ?? 0));

  const basisRows = rows.filter((r) => r.costBasisUsd !== null);
  const openBasisRows = basisRows.filter((r) => !r.stranded);
  const totalCostBasisUsd = round2(openBasisRows.reduce((a, r) => a + (r.costBasisUsd ?? 0), 0));
  // Unrealized is computed over the OPEN basis rows only. Comparing the whole
  // portfolio's current value against the cost of the few holdings that have a
  // basis would book every basis-less holding's value as pure profit — a
  // number that looks like a gain and means nothing. Stranded rows (basis but
  // no position) are excluded too: their basis is real money, but it is no
  // longer marked to anything, so it belongs in neither unrealized nor a loss.
  const basisCurrentValueUsd = round2(openBasisRows.reduce((a, r) => a + r.currentValueUsd, 0));
  const totalCurrentValueUsd = round2(rows.reduce((a, r) => a + r.currentValueUsd, 0));
  const totalRealizedUsd = round2(rows.reduce((a, r) => a + (r.realizedUsd ?? 0), 0));
  const anyUnmatched = rows.some((r) => r.unmatchedOutUsd > 1e-9);

  return {
    rows,
    totalCostBasisUsd,
    totalCurrentValueUsd,
    basisCurrentValueUsd,
    totalUnrealizedUsd: openBasisRows.length > 0 ? round2(basisCurrentValueUsd - totalCostBasisUsd) : null,
    totalRealizedUsd: anyUnmatched ? null : totalRealizedUsd,
    unbasisAssets: rows.filter((r) => r.costBasisUsd === null && r.currentValueUsd > 0).length,
    strandedAssets: rows.filter((r) => r.stranded).length,
    txCount: txRows.length,
  };
}

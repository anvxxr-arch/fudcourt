/**
 * treasury.ts — the time-series read layer over `asset_history` (DR-040).
 *
 * SESSIONIZATION IS THE WHOLE POINT. `asset_history` looks like a portfolio
 * snapshot table, but the `assets_snapshot` trigger fires PER ROW: every row of
 * one sync run carries that row's own `updated_at`, so a single 5-minute sync
 * writes ~16 rows at ~16 distinct `ts` values one second apart. Grouping the
 * table by `ts` therefore yields one-asset "snapshots" (total $0.11, the ETH
 * dust row) — the wrong answer, and the reason a naive SUM/GROUP BY read here
 * reports a portfolio worth pennies.
 *
 * The real observation is a RUN: consecutive rows within a 60-second gap are one
 * sync. `sessionize()` walks the window ordered by `ts`, flags a new run when the
 * gap exceeds 60s, and numbers the runs; summing a run's rows gives the true
 * portfolio at that observation (≈$141–$170 for the live data — coherent for the
 * whole 90-day retention, with no empty snapshots). Every read below is built on
 * that CTE, and each returns `observations` so the caller can see the true sample
 * count rather than the row count.
 *
 * BUCKETING IS NOT SUMMING. A bucket spans many runs, so a bucket's value is the
 * LAST run inside it (`last(v, t)`), never the sum — summing a 5-minute series
 * into a 1-hour bucket would multiply the portfolio by the number of runs.
 *
 * NEVER-FAKE. A range with no rows returns empty series / null metrics — never a
 * fabricated 0. A window with a single observation cannot yield a change, so
 * `changeUsd`/`changePct` are null and render `—`.
 *
 * Validation is allowlist-only and never clamps: an unknown `range`/`bucket`/
 * `group` returns null from the parser and the route answers 400 (house rule).
 * The interval literals interpolated into SQL come from the frozen maps below,
 * so no request text ever reaches a query.
 */
import 'server-only';
import { buildAttribution, pairInputsFromRows, type AttrDimension, type AttributionResult } from '@/lib/attribution';
import { query, type Row } from './db';

export type RangeKey = '24h' | '7d' | '30d' | '90d';
export type BucketKey = '5m' | '15m' | '1h' | '6h' | '1d';
export type GroupKey = 'total' | 'chain' | 'wallet' | 'asset';

/** Window length -> Postgres interval literal. The 90d cap matches the prune. */
const RANGES: Record<RangeKey, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
};

/** Bucket width -> Postgres interval literal. */
const BUCKETS: Record<BucketKey, string> = {
  '5m': '5 minutes',
  '15m': '15 minutes',
  '1h': '1 hour',
  '6h': '6 hours',
  '1d': '1 day',
};

/**
 * The grouping expression per dimension, over the `r`-aliased run CTE. `total`
 * has NO expression: a string constant cannot appear in GROUP BY in Postgres
 * ("non-integer constant in GROUP BY"), so the total path selects a literal in
 * the projection and groups by time alone (see `history`). A NULL wallet is
 * coalesced to a label rather than dropped — a wallet-less holding is real.
 */
const GROUPS: Record<Exclude<GroupKey, 'total'>, string> = {
  chain: 'r.chain',
  wallet: "coalesce(r.wallet, 'Unassigned')",
  asset: 'r.asset',
};

/** Two rows further apart than this are different sync runs, not one snapshot. */
const RUN_GAP = "INTERVAL '60 seconds'";

/** The allowlisted dimension names, as a frozen map for `pick`. */
const GROUP_KEYS: Record<GroupKey, 1> = { total: 1, chain: 1, wallet: 1, asset: 1 };

/**
 * The dimension allowlist. A `GroupKey` minus `total`: "total" is a chart
 * grouping, not a dimension anything can be broken down BY, so it is not a
 * legal `dimension=` value. It is exported as the ORDERED list because the
 * route's 400 message must name the same set the parser enforces — one list,
 * not two, so a message can never advertise a dimension the parser rejects.
 */
export const DIMENSIONS = ['chain', 'wallet', 'asset'] as const;
const DIM_KEYS: Record<(typeof DIMENSIONS)[number], 1> = { chain: 1, wallet: 1, asset: 1 };

/** An allowlisted key, or `null` for a supplied-but-unknown value (never clamped). */
function pick<K extends string>(value: string | null, allowed: Record<K, unknown>, fallback: K): K | null {
  if (value === null || value === '') return fallback;
  return Object.prototype.hasOwnProperty.call(allowed, value) ? (value as K) : null;
}

export const parseRange = (v: string | null): RangeKey | null => pick(v, RANGES, '7d');
export const parseBucket = (v: string | null): BucketKey | null => pick(v, BUCKETS, '1h');
export const parseGroup = (v: string | null): GroupKey | null => pick(v, GROUP_KEYS, 'chain');
/** A dimension for the breakdown and attribution modes; `total` is not one. */
export const parseDimension = (v: string | null): Exclude<GroupKey, 'total'> | null =>
  pick(v, DIM_KEYS, 'chain');

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(String(v)).toISOString());

/**
 * The shared sessionization CTEs. `ordered` flags a new run whenever the gap to
 * the previous row exceeds `RUN_GAP`; `run` numbers them; `obs` collapses each
 * run to its first `ts` (`obs_ts`) — the observation time. Rows are read once,
 * in `ts` order, so the run boundaries are global across chains and assets.
 *
 * `quantity` rides along because the attribution mode needs it beside
 * `value_usd` to tell a reprice from a buy. Every consumer of `run`/`ordered`
 * names the columns it wants, so carrying one more is additive.
 */
function sessionize(range: RangeKey): string {
  return `ordered AS (
      SELECT ts, chain, asset, wallet, quantity, value_usd,
             CASE WHEN lag(ts) OVER (ORDER BY ts) IS NULL
                    OR ts - lag(ts) OVER (ORDER BY ts) > ${RUN_GAP}
                  THEN 1 ELSE 0 END AS is_new
      FROM asset_history
      WHERE ts >= now() - INTERVAL '${RANGES[range]}'
    ),
    run AS (
      SELECT ts, chain, asset, wallet, quantity, value_usd,
             SUM(is_new) OVER (ORDER BY ts) AS run_id
      FROM ordered
    ),
    obs AS (SELECT run_id, min(ts) AS obs_ts FROM run GROUP BY run_id),
    obs_v AS (
      SELECT o.obs_ts AS t, SUM(r.value_usd)::float8 AS v
      FROM run r JOIN obs o ON o.run_id = r.run_id
      GROUP BY o.obs_ts
    )`;
}

/** How many true observations the window holds, and their span. */
async function observations(range: RangeKey): Promise<number> {
  const rows = await query(`WITH ${sessionize(range)} SELECT count(*)::int AS n FROM obs`);
  return Number(((rows[0] ?? {}) as Row).n ?? 0);
}

export type HistoryPoint = { t: string; key: string; v: number };
export type HistoryResult = {
  range: RangeKey;
  bucket: BucketKey;
  group: GroupKey;
  keys: string[];
  points: HistoryPoint[];
  /** Distinct buckets the series spans. */
  buckets: number;
  /** True sync observations in the window (runs, not rows). */
  observations: number;
};

/**
 * A bucketed series. Each run is summed to one value per dimension key first,
 * then `last(v, t)` picks the closing value of each bucket — so a bucket's value
 * is the portfolio as it stood at the end of the bucket, never a sum of the
 * observations inside it.
 */
export async function treasuryHistory(
  group: GroupKey,
  range: RangeKey,
  bucket: BucketKey,
): Promise<HistoryResult> {
  const dim = group === 'total' ? null : GROUPS[group];
  const perObs = dim
    ? `SELECT o.obs_ts AS t, ${dim} AS key, SUM(r.value_usd)::float8 AS v
       FROM run r JOIN obs o ON o.run_id = r.run_id
       GROUP BY o.obs_ts, ${dim}`
    : `SELECT o.obs_ts AS t, SUM(r.value_usd)::float8 AS v FROM run r JOIN obs o ON o.run_id = r.run_id GROUP BY o.obs_ts`;
  const keySel = dim ? 'key' : "'total' AS key";
  const groupBy = dim ? 'GROUP BY bucket, key' : 'GROUP BY bucket';

  const rows = await query(
    `WITH ${sessionize(range)},
     per_obs AS (${perObs})
     SELECT time_bucket(INTERVAL '${BUCKETS[bucket]}', t) AS bucket,
            ${keySel},
            last(v, t) AS value
     FROM per_obs
     ${groupBy}
     ORDER BY bucket ASC, key ASC`,
  );

  const points: HistoryPoint[] = [];
  const keys = new Set<string>();
  const buckets = new Set<string>();
  for (const r of rows as Row[]) {
    const t = iso(r.bucket);
    const v = num(r.value);
    if (t === null || v === null) continue;
    const key = String(r.key);
    keys.add(key);
    buckets.add(t);
    points.push({ t, key, v });
  }
  return {
    range,
    bucket,
    group,
    keys: [...keys].sort(),
    points,
    buckets: buckets.size,
    observations: await observations(range),
  };
}

export type TotalAnalytics = {
  range: RangeKey;
  /** True sync observations in the window (runs, not rows). */
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
  /** Daily-return standard deviation, percent. Null under two observations. */
  volatilityDailyPct: number | null;
};

/**
 * Window statistics for the total. The ordered-array picks give first/last/ATH/
 * low in one pass over the observations, so there is no second query to drift.
 */
export async function treasuryAnalytics(range: RangeKey): Promise<TotalAnalytics> {
  const stats = await query(
    `WITH ${sessionize(range)}
     SELECT count(*)::int AS n,
            (array_agg(v ORDER BY t ASC))[1]  AS first_v,
            (array_agg(v ORDER BY t DESC))[1] AS last_v,
            (array_agg(t ORDER BY t DESC))[1] AS last_ts,
            (array_agg(t ORDER BY t ASC))[1]  AS first_ts,
            max(v) AS ath,
            (array_agg(t ORDER BY v DESC))[1] AS ath_ts,
            min(v) AS low,
            (array_agg(t ORDER BY v ASC))[1]  AS low_ts
     FROM obs_v`,
  );

  const vol = await query(
    `WITH ${sessionize(range)},
     daily AS (
       SELECT time_bucket(INTERVAL '1 day', t) AS b, last(v, t) AS v FROM obs_v GROUP BY b
     ),
     ret AS (
       -- NULLIF: a zero-valued day would otherwise divide by zero.
       SELECT v / NULLIF(lag(v) OVER (ORDER BY b), 0) - 1 AS r FROM daily
     )
     SELECT stddev_samp(r)::float8 * 100 AS vol_pct FROM ret`,
  );

  const s = (stats[0] ?? {}) as Row;
  const n = Number(s.n ?? 0);
  const current = num(s.last_v);
  const first = num(s.first_v);
  const ath = num(s.ath);
  const volPct = num(((vol[0] ?? {}) as Row).vol_pct);

  return {
    range,
    observations: n,
    firstTs: iso(s.first_ts),
    lastTs: iso(s.last_ts),
    current,
    first,
    changeUsd: current !== null && first !== null ? current - first : null,
    changePct: current !== null && first !== null && first !== 0 ? ((current - first) / first) * 100 : null,
    ath,
    athTs: iso(s.ath_ts),
    low: num(s.low),
    lowTs: iso(s.low_ts),
    // Distance from the peak to now, percent. 0 at the peak, negative below it.
    drawdownPct: current !== null && ath !== null && ath !== 0 ? ((current - ath) / ath) * 100 : null,
    volatilityDailyPct: n >= 2 ? volPct : null,
  };
}

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
  range: RangeKey;
  dimension: 'chain' | 'wallet' | 'asset';
  observations: number;
  fromTs: string | null;
  toTs: string | null;
  totalCurrent: number;
  totalFirst: number;
  rows: BreakdownRow[];
};

/**
 * Per-dimension current vs window-start, with deltas and share.
 *
 * `wallets` is joined for the display alias/emoji/colour so the board shows the
 * same identity the rest of the treasury does; a chain or asset has no wallet
 * row, so those dimensions carry null identity fields.
 */
export async function treasuryBreakdown(
  dimension: 'chain' | 'wallet' | 'asset',
  range: RangeKey,
): Promise<BreakdownResult> {
  const dim = GROUPS[dimension];
  const rows = await query(
    `WITH ${sessionize(range)},
     dim AS (
       SELECT o.obs_ts AS t, ${dim} AS key, SUM(r.value_usd)::float8 AS v
       FROM run r JOIN obs o ON o.run_id = r.run_id
       GROUP BY o.obs_ts, ${dim}
     ),
     bounds AS (SELECT min(t) AS t0, max(t) AS t1 FROM dim),
     at_start AS (SELECT key, v FROM dim, bounds WHERE t = t0),
     at_end   AS (SELECT key, v FROM dim, bounds WHERE t = t1),
     peak AS (
       SELECT key, max(v) AS peak, (array_agg(t ORDER BY v DESC))[1] AS peak_ts
       FROM dim GROUP BY key
     )
     SELECT coalesce(e.key, s.key) AS key,
            coalesce(e.v, 0)::float8 AS cur,
            coalesce(s.v, 0)::float8 AS start_v,
            p.peak::float8 AS peak,
            p.peak_ts AS peak_ts
     FROM at_end e
     FULL OUTER JOIN at_start s ON s.key = e.key
     JOIN peak p ON p.key = coalesce(e.key, s.key)
     ORDER BY cur DESC`,
  );

  const identity = await query(`SELECT label, alias, emoji, color FROM wallets`);
  const byLabel = new Map<string, Row>();
  for (const w of identity as Row[]) byLabel.set(String(w.label), w);

  const totalCurrent = (rows as Row[]).reduce((a, r) => a + Number(r.cur ?? 0), 0);
  const totalFirst = (rows as Row[]).reduce((a, r) => a + Number(r.start_v ?? 0), 0);
  const bounds = await query(
    `WITH ${sessionize(range)}, dim AS (
       SELECT o.obs_ts AS t, ${dim} AS key FROM run r JOIN obs o ON o.run_id = r.run_id GROUP BY o.obs_ts, ${dim}
     ) SELECT (SELECT min(t) FROM dim) AS t0, (SELECT max(t) FROM dim) AS t1`,
  );
  const bt = (bounds[0] ?? {}) as Row;

  const out: BreakdownRow[] = (rows as Row[]).map((r) => {
    const key = String(r.key);
    const cur = Number(r.cur ?? 0);
    const start = Number(r.start_v ?? 0);
    const w = byLabel.get(key);
    return {
      key,
      label: w ? String(w.alias || w.label) : key,
      color: w ? String(w.color) : null,
      emoji: w ? String(w.emoji) : null,
      current: cur,
      first: start,
      changeUsd: cur - start,
      changePct: start !== 0 ? ((cur - start) / start) * 100 : null,
      sharePct: totalCurrent !== 0 ? (cur / totalCurrent) * 100 : null,
      peak: Number(r.peak ?? 0),
      peakTs: iso(r.peak_ts),
    };
  });

  return {
    range,
    dimension,
    observations: await observations(range),
    fromTs: iso(bt.t0),
    toTs: iso(bt.t1),
    totalCurrent,
    totalFirst,
    rows: out,
  };
}

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
  range: RangeKey;
  fromTs: string | null;
  toTs: string | null;
  observations: number;
  rows: DiffRow[];
  reasons: DiffReason[];
};

/**
 * What moved between the first and last observation in the window, plus the
 * transactions recorded over the same span as the explanation.
 *
 * The diff is a FULL OUTER JOIN so a holding that appeared or vanished shows
 * with its full delta rather than being dropped — a position going to zero is
 * the single most interesting row on this board.
 *
 * `transactions.date` is TEXT in `YYYY-MM-DD` form, so the window filter is a
 * string comparison against `to_char(...)` rather than a cast: lexicographic
 * order on that format is chronological, and a cast would throw on any row
 * carrying a non-date.
 */
export async function treasuryDiff(range: RangeKey): Promise<DiffResult> {
  const rows = await query(
    `WITH ${sessionize(range)},
     dim AS (
       SELECT o.obs_ts AS t, r.chain, r.asset, coalesce(r.wallet, '') AS wallet,
              SUM(r.value_usd)::float8 AS v
       FROM run r JOIN obs o ON o.run_id = r.run_id
       GROUP BY o.obs_ts, r.chain, r.asset, r.wallet
     ),
     bounds AS (SELECT min(t) AS t0, max(t) AS t1 FROM dim),
     a AS (SELECT chain, asset, wallet, v FROM dim, bounds WHERE t = t0),
     b AS (SELECT chain, asset, wallet, v FROM dim, bounds WHERE t = t1)
     SELECT coalesce(b.chain, a.chain)   AS chain,
            coalesce(b.asset, a.asset)   AS asset,
            coalesce(b.wallet, a.wallet) AS wallet,
            coalesce(a.v, 0)::float8     AS from_v,
            coalesce(b.v, 0)::float8     AS to_v
     FROM a FULL OUTER JOIN b
       ON a.chain = b.chain AND a.asset = b.asset AND a.wallet = b.wallet
     WHERE abs(coalesce(b.v, 0) - coalesce(a.v, 0)) > 0.000001
     ORDER BY abs(coalesce(b.v, 0) - coalesce(a.v, 0)) DESC`,
  );

  const reasons = await query(
    `SELECT date, chain, asset, event, amount_usd::float8 AS amount_usd, direction, memo, hash, url, source
     FROM transactions
     WHERE date >= to_char(now() - INTERVAL '${RANGES[range]}', 'YYYY-MM-DD')
     ORDER BY date DESC, id DESC
     LIMIT 100`,
  );

  const bounds = await query(
    `WITH ${sessionize(range)},
     dim AS (SELECT o.obs_ts AS t FROM run r JOIN obs o ON o.run_id = r.run_id GROUP BY o.obs_ts)
     SELECT (SELECT min(t) FROM dim) AS t0, (SELECT max(t) FROM dim) AS t1`,
  );
  const bt = (bounds[0] ?? {}) as Row;

  return {
    range,
    fromTs: iso(bt.t0),
    toTs: iso(bt.t1),
    observations: await observations(range),
    rows: (rows as Row[]).map((r) => {
      const from = Number(r.from_v ?? 0);
      const to = Number(r.to_v ?? 0);
      return {
        chain: String(r.chain),
        asset: String(r.asset),
        wallet: String(r.wallet),
        from,
        to,
        delta: to - from,
        deltaPct: from !== 0 ? ((to - from) / from) * 100 : null,
      };
    }),
    reasons: (reasons as Row[]).map((r) => ({
      date: iso(r.date) ?? String(r.date),
      chain: String(r.chain ?? ''),
      asset: String(r.asset ?? ''),
      event: String(r.event ?? ''),
      amountUsd: num(r.amount_usd),
      direction: String(r.direction ?? ''),
      memo: r.memo === null || r.memo === undefined ? null : String(r.memo),
      hash: r.hash === null || r.hash === undefined ? null : String(r.hash),
      url: r.url === null || r.url === undefined ? null : String(r.url),
      source: String(r.source ?? ''),
    })),
  };
}

export type { AttrDimension, AttributionResult, AttrPair, AttrRow } from '@/lib/attribution';

/**
 * WHY the window moved — the change split into a price effect (the book as it
 * stood, repriced) and a flow effect (the book itself changing), per (key,
 * asset) and aggregated by key.
 *
 * DECOMPOSED PER ASSET, NEVER PER KEY. A chain or a wallet holds many assets, and
 * summing their quantities yields a number that is not a quantity (BTC + USDC),
 * so a key-level `value / qty` price would be a fabricated reading. Every pair
 * below is one (key, asset), so each price is a real unit price; the key's row is
 * the SUM of its assets' exact effects. `@/lib/attribution` owns that arithmetic
 * and is unit-tested offline against fixed rows.
 *
 * The endpoints are the FIRST and LAST observation in the window — the same
 * `bounds` shape `treasuryBreakdown` and `treasuryDiff` use, so all three panels
 * describe the same two instants and cannot disagree about the window. The FULL
 * OUTER JOIN is what lets a pair that appeared or vanished carry its whole delta
 * instead of being dropped.
 */
export async function treasuryAttribution(
  dimension: AttrDimension,
  range: RangeKey,
): Promise<AttributionResult> {
  // `dimension` is an allowlist key (the route validates it before calling), and
  // the expression comes from the frozen GROUPS map — no request text reaches SQL.
  const dim = GROUPS[dimension];

  // One pass. The endpoints are `t0`/`t1` — the first and last observation in the
  // window — pulled as scalar subqueries and carried on every row, so the bounds
  // and the pairs arrive together instead of sessionizing the table twice. The
  // FULL OUTER JOIN is what makes an OPENED pair (`a` missing) and a CLOSED one
  // (`b` missing) first-class rows rather than silently-dropped inner-join misses.
  const rows = await query(
    `WITH ${sessionize(range)},
     obs_pair AS (
       SELECT o.obs_ts AS t, ${dim} AS key, r.asset AS asset,
              SUM(r.quantity)::float8 AS qty,
              SUM(r.value_usd)::float8 AS v
       FROM run r JOIN obs o ON o.run_id = r.run_id
       GROUP BY o.obs_ts, ${dim}, r.asset
     )
     SELECT coalesce(a.key, b.key)     AS key,
            coalesce(a.asset, b.asset) AS asset,
            a.qty::float8 AS q0, a.v::float8 AS v0,
            b.qty::float8 AS q1, b.v::float8 AS v1,
            (SELECT min(t) FROM obs_pair) AS t0,
            (SELECT max(t) FROM obs_pair) AS t1
     FROM (SELECT key, asset, qty, v FROM obs_pair
            WHERE t = (SELECT min(t) FROM obs_pair)) a
     FULL OUTER JOIN (SELECT key, asset, qty, v FROM obs_pair
                       WHERE t = (SELECT max(t) FROM obs_pair)) b
       ON a.key = b.key AND a.asset = b.asset
     ORDER BY abs(coalesce(b.v, 0) - coalesce(a.v, 0)) DESC, key ASC, asset ASC`,
  );

  const first = (rows[0] ?? {}) as Row;

  return buildAttribution({
    dimension,
    range,
    observations: await observations(range),
    fromTs: iso(first.t0),
    toTs: iso(first.t1),
    pairs: pairInputsFromRows(rows as Record<string, unknown>[]),
  });
}

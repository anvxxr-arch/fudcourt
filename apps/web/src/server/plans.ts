/**
 * plans.ts — the paper-plan ledger over `signal_plans` (DR-050).
 *
 * WHAT THIS IS. `scripts/tools/signal-pipeline.py` reads the surfaced signals
 * from our own `/api/signals` route and records a RISK-SIZED plan per token in
 * `signal_plans`, keyed `(chain, mint)` — the bridge between "this token was
 * flagged" and "this is the position a disciplined budget would take" (DR-050).
 * It runs on `fudcourt-signals.timer` every 5 minutes. Until this module the
 * table had a WRITER and no READER: the plans were "recorded for audit" with
 * nothing to audit them from. This is that read.
 *
 * WHY A PLAIN READ AND NOT A RE-DERIVATION. The row IS the record — the sizing
 * already happened once, against a settled equity figure, in the executor's own
 * vocabulary (`risk_usd = equity × risk_pct`, `quantity = risk_usd / (entry −
 * stop)`). Recomputing it here would mint a second source of truth for how big
 * a position is, which DR-050 explicitly forbids. The board shows the stored
 * plan verbatim.
 *
 * NEVER-FAKE. Every numeric column is nullable at the schema level, so it is
 * typed `| null` and rendered `—` by the board — a plan with no target, or a
 * `skipped` row with no entry, is a gap, never a fabricated 0. `mode` is always
 * `paper` by construction (DR-050: the pipeline never records a live plan), and
 * the board states that rather than implying a live order.
 */
import { query, type Row } from './db';

/** One stored plan, exactly as `signal_plans` ships it. */
export type SignalPlan = {
  chain: string;
  mint: string;
  symbol: string | null;
  decision: string | null;
  score: number | null;
  entry_usd: number | null;
  stop_usd: number | null;
  target_usd: number | null;
  quantity: number | null;
  notional_usd: number | null;
  risk_usd: number | null;
  risk_pct: number | null;
  equity_usd: number | null;
  stop_pct: number | null;
  capped: boolean;
  mode: string;
  status: string;
  reason: string | null;
  planned_at: string;
};

export type PlanLedger = {
  /** The newest `limit` plans, newest first. */
  plans: SignalPlan[];
  /** The true row count in the table — never the length of the slice above. */
  total: number;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

/**
 * `timestamptz` arrives as a JS `Date` from the driver, and `String(date)` is
 * `"Thu Oct 08 2026 07:37:55 GMT+0000 (…)"` — a form that does NOT sort
 * lexicographically in time order. The board orders by this field, so it is
 * normalised to ISO-8601, where string order IS time order. A driver that
 * already hands back a string is passed through untouched.
 */
const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : String(v);

const toPlan = (r: Row): SignalPlan => ({
  chain: String(r.chain),
  mint: String(r.mint),
  symbol: str(r.symbol),
  decision: str(r.decision),
  score: num(r.score),
  entry_usd: num(r.entry_usd),
  stop_usd: num(r.stop_usd),
  target_usd: num(r.target_usd),
  quantity: num(r.quantity),
  notional_usd: num(r.notional_usd),
  risk_usd: num(r.risk_usd),
  risk_pct: num(r.risk_pct),
  equity_usd: num(r.equity_usd),
  stop_pct: num(r.stop_pct),
  capped: r.capped === true || r.capped === 't' || r.capped === 1,
  mode: String(r.mode),
  status: String(r.status),
  reason: str(r.reason),
  planned_at: iso(r.planned_at),
});

/**
 * The plan ledger, newest first, capped at `limit` for the board — with the
 * table's TRUE count reported separately so a truncated slice can never read as
 * the whole. The totals the board shows are computed in the pure model over the
 * rows it actually received (never over a count it did not read).
 */
export async function listPlans(limit = 500): Promise<PlanLedger> {
  const capped = Math.max(1, Math.min(2000, Math.floor(limit)));
  const rows = (await query(
    `SELECT chain, mint, symbol, decision, score,
            entry_usd::float8   AS entry_usd,
            stop_usd::float8    AS stop_usd,
            target_usd::float8  AS target_usd,
            quantity::float8    AS quantity,
            notional_usd::float8 AS notional_usd,
            risk_usd::float8    AS risk_usd,
            risk_pct::float8    AS risk_pct,
            equity_usd::float8  AS equity_usd,
            stop_pct::float8    AS stop_pct,
            capped, mode, status, reason, planned_at
     FROM signal_plans
     ORDER BY planned_at DESC, mint ASC
     LIMIT ?`,
    [capped],
  )) as Row[];

  const countRows = (await query(`SELECT count(*)::float8 AS total FROM signal_plans`)) as Row[];
  const total = num(countRows[0]?.total) ?? 0;

  return { plans: rows.map(toPlan), total };
}

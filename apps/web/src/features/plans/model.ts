/**
 * The paper-plan ledger's domain model — the one read of `signal_plans`, and
 * nothing else.
 *
 * WHAT THE TABLE IS. `scripts/tools/signal-pipeline.py` runs on
 * `fudcourt-signals.timer` every 5 minutes: it reads the surfaced signals from
 * our own `/api/signals` route and, for each token, records a RISK-SIZED plan
 * keyed `(chain, mint)` — entry, stop, target, the quantity a fixed-risk budget
 * would carry, and the equity snapshot it was sized against (DR-050). That
 * makes the table the bridge between "this token was flagged" and "this is the
 * position a disciplined budget would take". Until this board it had a writer
 * and no reader.
 *
 * THE ONE RULE — a gap is a gap. Every numeric column is nullable at the schema
 * level, so a plan with no target, or a `skipped` row with no entry, renders the
 * em-dash `—` and is COUNTED as a gap in the headline, never printed as `0`. A
 * `0` is a measurement the pipeline did not make.
 *
 * PAPER, AND NAMED SO. `mode` is `paper` by construction — the pipeline never
 * records a live plan (DR-050) — so the board states "paper" in the header
 * rather than letting a plan read as an order that exists somewhere.
 *
 * THE SLICE IS STATED, NOT IMPLIED. The route caps the read at `limit`; `total`
 * is the table's TRUE count reported separately, so `shown` and `total` are both
 * on screen and a truncated slice can never read as the whole.
 *
 * PURE: no network, no clock (`nowSec` is a parameter where needed), no I/O — so
 * every rule above is unit-tested offline against fixed rows.
 */

/** One stored plan, exactly as `/api/plans` ships it. */
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

/** The route's payload: a capped slice plus the table's true row count. */
export type PlanLedger = {
  plans: SignalPlan[];
  total: number;
};

/** The headline the board renders — every figure derived from the rows it read. */
export type PlansBoard = {
  /** Rows in the slice actually received. */
  shown: number;
  /** The table's true count, as the route reported it. */
  total: number;
  /** `status === 'planned'` — a plan the pipeline would act on. */
  planned: number;
  /** Any other status (`skipped`, …) — recorded, not actionable. */
  skipped: number;
  /** Distinct symbols across the slice. */
  symbols: number;
  /** Distinct chains across the slice, sorted. */
  chains: string[];
  /** Rows the risk budget capped (the notional hit a ceiling). */
  capped: number;
  /** The equity snapshot the plans were sized against — null if unread. */
  equityUsd: number | null;
  /** Newest / oldest `planned_at` in the slice (ISO), or null when empty. */
  newestAt: string | null;
  oldestAt: string | null;
};

const distinct = <T,>(items: T[]): number => new Set(items).size;

/**
 * Fold the ledger into the board headline. Pure over the slice it is given: the
 * counts describe the rows received, and `total` is carried through verbatim
 * from the route (never recomputed as `plans.length`, which would hide the cap).
 */
export function readPlansBoard(ledger: PlanLedger): PlansBoard {
  const plans = ledger.plans;
  const equity = plans.find((p) => p.equity_usd !== null)?.equity_usd ?? null;
  let newestAt: string | null = null;
  let oldestAt: string | null = null;
  for (const p of plans) {
    if (newestAt === null || p.planned_at > newestAt) newestAt = p.planned_at;
    if (oldestAt === null || p.planned_at < oldestAt) oldestAt = p.planned_at;
  }
  return {
    shown: plans.length,
    total: ledger.total,
    planned: plans.filter((p) => p.status === 'planned').length,
    skipped: plans.filter((p) => p.status !== 'planned').length,
    symbols: distinct(plans.map((p) => p.symbol ?? p.mint)),
    chains: Array.from(new Set(plans.map((p) => p.chain))).sort(),
    capped: plans.filter((p) => p.capped).length,
    equityUsd: equity,
    newestAt,
    oldestAt,
  };
}

/**
 * The plan's implied reward:risk, from entry/stop/target alone. `null` when any
 * leg is missing or the risk leg is zero — a ratio with no denominator is not a
 * number, and printing one would invent a signal the row does not carry.
 */
export function rewardRisk(p: SignalPlan): number | null {
  const { entry_usd: e, stop_usd: s, target_usd: t } = p;
  if (e === null || s === null || t === null) return null;
  const risk = Math.abs(e - s);
  if (risk === 0) return null;
  return Math.abs(t - e) / risk;
}

/**
 * A USD figure, or the em-dash for an absent one. A real `0` prints `$0.00`;
 * every other value prints with enough precision that it can NEVER round to a
 * fake zero — the memecoin plans here carry entries as small as `1.485e-07`, and
 * an 8-dp fixed format would print those as `$0.00000000`, asserting a price the
 * plan does not have. Precision follows the house `fmtPrice` convention (2dp at
 * ≥1, 4dp at ≥0.01, 8dp at ≥1e-6) and extends adaptively below that.
 */
export function usd(v: number | null): string {
  if (v === null) return '—';
  const abs = Math.abs(v);
  const digits = abs === 0 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : abs >= 1e-6 ? 8 : Math.min(16, -Math.floor(Math.log10(abs)) + 3);
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** A percent (the value is already in percent units, e.g. `25` for 25%), or `—`. */
export function pct(v: number | null): string {
  if (v === null) return '—';
  return `${v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`;
}

/** A score with one decimal, or `—`. */
export function score(v: number | null): string {
  if (v === null) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
}

/**
 * A plan timestamp as `MM-DD HH:MM` (UTC), or `—`. The raw ISO is kept as the
 * cell's `title`, so the exact instant is one hover away and the board never
 * rounds a time into a claim.
 */
export function planTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

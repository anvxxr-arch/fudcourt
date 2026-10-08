'use client';

/**
 * plans.tsx — the paper-plan ledger board, `/team/plans`.
 *
 * WHAT THIS BOARD IS. The read side of `signal_plans` (DR-050): the plans
 * `scripts/tools/signal-pipeline.py` records every 5 minutes from the surfaced
 * signals. Until this board the table had a writer and no reader — the plans
 * were "recorded for audit" with nothing to audit them from.
 *
 * WHAT IT MUST NOT DO.
 *  - It must never print `0` where the plan carries no figure. Every nullable
 *    column renders the em-dash `—` (`usd`/`pct`/`score` in `./model`), and the
 *    headline COUNTS the gaps rather than folding them into a low.
 *  - It must never read a plan as a live order. `mode` is `paper` by
 *    construction; the header says "paper" and the footnote says a plan is a
 *    proposal, not a fill.
 *  - It must never let a capped slice read as the whole. The route caps at
 *    `limit`; `shown` and the table's true `total` are both on screen.
 *  - It must never blank the board because the read failed. A failed read is an
 *    ErrorState; an empty-but-200 ledger is its OWN distinct state ("nothing
 *    recorded yet"), not the same thing.
 *
 * The reading itself lives in `./model.ts` and is pure, so every rule above is
 * unit-tested offline against fixed rows.
 */
import { useCallback, useEffect, useState } from 'react';
import { themeColor, fontSize, lineHeight, space } from '@/styles/tokens';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { ErrorState, Loading } from '@/ui/feedback';
import { Stat } from '@/ui/stat';
import { fetchPlans, type Source } from './client';
import { planTime, pct, readPlansBoard, rewardRisk, score, usd, type PlanLedger, type SignalPlan } from './model';

/**
 * The board's table columns, in order — **mobile-first**, which means the
 * columns a phone's ~316px window shows first are the ones that carry the plan
 * (entry/stop/target), not the ones that merely classify it (chain/score).
 *
 * Measured at a 390px viewport before this order: the fold showed
 * `Symbol | Chain | Score` and every payload column sat off-screen, so the
 * board's own figure — the plan — was the part you had to scroll to find.
 * Desktop is unaffected by the reorder: all twelve columns still render, in a
 * reading order that leads with the plan and trails into its provenance.
 */
const HEAD = ['Symbol', 'Entry', 'Stop', 'Target', 'R:R', 'Notional', 'Stop %', 'Risk %', 'Status', 'Planned', 'Score', 'Chain'] as const;

/** One plan as a row of cells, in `HEAD` order, gaps rendered `—` by the pure formatters. */
function rowCells(p: SignalPlan) {
  const rr = rewardRisk(p);
  return [
    p.symbol ?? <span title={p.mint} style={{ color: themeColor.labelTertiary }}>{p.mint.slice(0, 6)}…{p.mint.slice(-4)}</span>,
    usd(p.entry_usd),
    usd(p.stop_usd),
    usd(p.target_usd),
    rr === null ? '—' : `${rr.toFixed(2)}×`,
    usd(p.notional_usd),
    pct(p.stop_pct),
    pct(p.risk_pct),
    <span key="s" title={p.reason ?? undefined} style={{ color: p.status === 'planned' ? themeColor.green : themeColor.labelSecondary }}>{p.status}</span>,
    <span key="t" title={p.planned_at} style={{ color: themeColor.labelSecondary }}>{planTime(p.planned_at)}</span>,
    score(p.score),
    p.chain,
  ];
}

export default function PlansPanel() {
  const [src, setSrc] = useState<Source<PlanLedger> | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setSrc(await fetchPlans());
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (src === null || (loading && src.data === null && src.error === null)) {
    return <Loading label="Reading the plan ledger…" what="signal_plans" />;
  }

  if (src.error !== null) {
    return <ErrorState title="The plan ledger could not be read" detail={src.error} />;
  }

  const ledger = src.data as PlanLedger;
  const board = readPlansBoard(ledger);

  if (board.total === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: space[16] }}>
        <Card title="Paper plan ledger" subtitle="signal_plans · written by fudcourt-signals.timer">
          <div style={{ color: themeColor.labelSecondary, fontSize: fontSize[13] }}>
            Nothing recorded yet. The pipeline writes a plan per surfaced signal every 5 minutes; the ledger is empty, which is a fact about the
            pipeline, not a failed read.
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[16] }}>
      {/*
        Mobile-first KPI cluster: an intrinsic grid, NOT a wrapping flex row.
        A flex row sizes every tile to its own content, so on a phone the six
        tiles landed as four ragged rows of unequal width (measured at 390px:
        141/98 | 134/171 | 279 | 172, with 103px and 178px of dead space in the
        first and last rows). `auto-fit` + `minmax` gives every tile in a column
        the SAME width and recomputes the column count from the container alone —
        2 columns at 350px, 4 at 728px, 6 at 1160px — so a partial last row still
        lines up. No media query is used or available: inline styles cannot carry
        one, and `--fc-grid-cols-*` has no stylesheet consumer in this tree.
      */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: space[8] }}>
        <Stat label="Plans recorded" value={String(board.total)} hint={board.shown < board.total ? `${board.shown} shown` : 'all shown'} />
        <Stat label="Planned" value={String(board.planned)} hint="actionable" tone="positive" />
        <Stat label="Not planned" value={String(board.skipped)} hint="skipped / other" tone={board.skipped > 0 ? 'negative' : 'neutral'} />
        <Stat label="Symbols" value={String(board.symbols)} hint={`${board.chains.join(', ') || '—'} · ${board.capped} capped`} />
        <Stat label="Equity snapshot" value={usd(board.equityUsd)} hint="the figure plans were sized against" />
        <Stat label="Newest plan" value={planTime(board.newestAt)} hint={board.oldestAt ? `oldest ${planTime(board.oldestAt)}` : undefined} />
      </div>

      <Card
        title="Paper plan ledger"
        subtitle="signal_plans · written by fudcourt-signals.timer"
        right={<span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>paper · {loading ? '⟳' : 'live'}</span>}
      >
        <DataTable head={HEAD} rows={ledger.plans.map((p) => ({ cells: rowCells(p) }))} />
        <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginTop: space[8], lineHeight: lineHeight.normal }}>
          Every row is a <strong>paper</strong> plan — a proposal the pipeline recorded, never a live order (DR-050). Sizing is fixed-risk: the risk
          leg is a fraction of the equity snapshot above, quantity = risk ÷ (entry − stop). A <strong>—</strong> is a figure the plan does not carry,
          never a zero. <strong>R:R</strong> is derived here from entry/stop/target alone. {board.shown < board.total
            ? `Showing the newest ${board.shown} of ${board.total} rows.`
            : `All ${board.total} rows shown.`}
        </div>
      </Card>
    </div>
  );
}

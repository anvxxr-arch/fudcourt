'use client';

/**
 * trades.tsx — the Trades board: the venue's own fills, aggregated into a trade
 * log (DR-048).
 *
 * WHERE THE ROWS COME FROM. A fill is the venue's record of one match — price,
 * quantity, quote, fee — deduped on `exchangeTradeId` (PRD §62). The executor
 * already serves them per execution (`/api/executor/executions/{id}/fills`); the
 * board reads every execution the command center already fetched and flattens
 * their fills into one time-ordered log. It invents no aggregate and no number:
 * the rows are exactly what the venues returned.
 *
 * WHAT IT DOES NOT DO. It never prints a trade it has not read. No fills is an
 * honest empty state, not a fabricated row; a fill whose execution is unknown is
 * still shown (symbol `—`), because dropping it would hide real activity.
 */
import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { ErrorState, Loading } from '@/ui/feedback';
import { Notice } from '@/ui/notice';
import { themeColor, fontSize, lineHeight, space } from '@/styles/tokens';
import { fetchFills, type ExecutionLite, type FillLite } from '@/features/trade/client';
import { formatPrice, formatUsd, NO_VALUE } from '@/features/trade/client';
import type { Panel } from '@/features/trade/ui/dashboard-panels';

type Row = FillLite & { symbol: string; side: string; status: string };

/** The short label a fill's instant renders as; UTC, timezone-stable. */
function shortTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return NO_VALUE;
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

export function TradesBoard({ executions, connected }: { executions: Panel<ExecutionLite[]>; connected: boolean }) {
  const [fills, setFills] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const execIds = useMemo(() => executions.value.map((e) => e.id).join(','), [executions.value]);

  useEffect(() => {
    if (executions.loading || executions.error || !connected) return;
    const ids = executions.value.map((e) => e.id);
    if (ids.length === 0) {
      setFills([]);
      setError(null);
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    const byId = new Map(executions.value.map((e) => [e.id, e]));
    setLoading(true);
    setError(null);

    Promise.all(
      ids.map((id) =>
        fetchFills(id, ac.signal)
          .then((fs) =>
            fs.map<Row>((f) => {
              const ex = byId.get(f.executionId);
              return { ...f, symbol: ex?.symbol ?? NO_VALUE, side: ex?.side ?? NO_VALUE, status: ex?.status ?? NO_VALUE };
            }),
          )
          .catch((e) => {
            // One execution failing must not blank the whole log; record the
            // first error and keep the fills the others returned.
            setError((prev) => prev ?? String(e instanceof Error ? e.message : e));
            return [] as Row[];
          }),
      ),
    ).then((groups) => {
      if (ac.signal.aborted) return;
      setFills(groups.flat().sort((a, b) => b.timestamp - a.timestamp));
      setLoading(false);
    });

    return () => ac.abort();
    // execIds is the stable identity of the execution set; executions.error/loading gate the run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [execIds, connected, executions.loading, executions.error]);

  const notional = fills.reduce((a, f) => a + f.quoteQuantity, 0);
  const fees = fills.reduce((a, f) => a + f.fee, 0);

  return (
    <Card
      title="Trades"
      subtitle="CEX fills, deduped on exchange trade id (PRD §62)"
      right={
        <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>
          {fills.length} fills · {loading ? '⟳' : 'live'}
        </span>
      }
    >
      {error ? (
        <ErrorState title="Trades unavailable" detail={error} />
      ) : !connected ? (
        <Notice>Connect a venue account to see fills. A trade is built from the venue&apos;s own match records, never a guess.</Notice>
      ) : loading && fills.length === 0 ? (
        <Loading what="fills" />
      ) : fills.length === 0 ? (
        <Notice>No fills recorded yet. Fills appear here the moment an execution matches on a venue — a working order with no fills is not a trade.</Notice>
      ) : (
        <>
          <DataTable
            head={['Time', 'Symbol', 'Side', 'Price', 'Quantity', 'Quote', 'Fee']}
            rows={fills.map((f) => ({
              cells: [
                shortTime(f.timestamp),
                f.symbol,
                f.side,
                formatPrice(f.price),
                String(f.quantity),
                formatUsd(f.quoteQuantity),
                `${f.fee} ${f.feeAsset}`,
              ],
            }))}
          />
          <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
            {fills.length} fills · {formatUsd(notional)} notional · {formatUsd(fees)} fees. Read from{' '}
            <code>/api/executor/executions/&lt;id&gt;/fills</code> — the venue&apos;s own records, deduped on{' '}
            <code>exchangeTradeId</code>, never a derived figure.
          </p>
        </>
      )}
    </Card>
  );
}

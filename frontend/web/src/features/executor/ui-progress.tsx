'use client';
/**
 * ui-progress.tsx — ExecutorProgress + progress tables (PRD §85, §86).
 * Split from ui.tsx; re-exported through ./ui.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { color, fontFamily, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { Button, Card } from '@/ui/primitives';
import { Meter } from '@/ui/meter';
import { Banner } from '@/ui/banner';
import { Row } from '@/ui/row';
import { StatusPill } from '@/ui/status-pill';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';
import {
  isTerminalExecution,
  type ChildOrderRecord,
  type ExecutionEventRecord,
  type ExecutionRecord,
  type FillRecord,
} from '@/lib/executor';
import {
  formatCompletionPct,
  formatDuration,
  formatMoney,
  formatPrice,
  formatQty,
  formatTimestamp,
} from './shapers';
import {
  cancelExecution,
  errorMessage,
  getExecution,
  listEvents,
  listFills,
  listOrders,
  pauseExecution,
  resumeExecution,
  startExecution,
} from './client';
import { diff, h3Style, noteStyle, tdStyle, thStyle } from './ui-shared';

// ---------------------------------------------------------------------------
// ExecutorProgress — §85, §86
// ---------------------------------------------------------------------------

/** Progress as a fraction, only when a planned quantity exists (§86's bar). */
function fillFraction(execution: ExecutionRecord): number | null {
  return execution.plannedQuantity > 0 ? execution.actualQuantity / execution.plannedQuantity : null;
}

/** Elapsed / remaining from the record's own timestamps and configured duration. */
function ElapsedRows({ execution }: { execution: ExecutionRecord }) {
  const config = execution.executionConfig;
  const plannedDuration = config.type === 'twap' || config.type === 'adaptive_twap' ? config.durationMs : null;
  const elapsed = execution.startedAt === null ? null : Date.now() - execution.startedAt;
  const remaining = plannedDuration === null || elapsed === null ? null : Math.max(0, plannedDuration - elapsed);
  return (
    <>
      <Row label="Elapsed" value={formatDuration(elapsed)} />
      <Row label="Remaining" value={formatDuration(remaining)} />
    </>
  );
}

function ChildOrderTable({ orders }: { orders: ChildOrderRecord[] }) {
  return (
    <Card>
      <h3 style={h3Style}>CHILD ORDERS · {orders.length}</h3>
      {orders.length === 0 && <p style={noteStyle}>no child orders yet — the worker plans them when the execution starts</p>}
      {orders.length > 0 && (
        <Table>
          <THead>
            <TR>
              <TH style={thStyle}>Client Order Id</TH>
              <TH style={thStyle}>Status</TH>
              <TH style={thStyle}>Side</TH>
              <TH style={thStyle}>Type</TH>
              <TH align="right" style={thStyle}>Price</TH>
              <TH align="right" style={thStyle}>Qty</TH>
              <TH align="right" style={thStyle}>Filled</TH>
              <TH style={thStyle}>Leg</TH>
            </TR>
          </THead>
          <TBody>
            {orders.map((order) => (
              <TR key={order.id}>
                <TD style={{ ...tdStyle, color: color.labelTertiary }}>{order.clientOrderId}</TD>
                <TD style={tdStyle}><StatusPill status={order.status} /></TD>
                <TD style={{ ...tdStyle, color: order.side === 'buy' ? color.blue : color.red }}>{order.side.toUpperCase()}</TD>
                <TD style={tdStyle}>{order.type}</TD>
                <TD align="right" mono style={tdStyle}>{formatPrice(order.price)}</TD>
                <TD align="right" mono style={tdStyle}>{formatQty(order.quantity)}</TD>
                <TD align="right" mono style={tdStyle}>{formatQty(order.filledQuantity)}</TD>
                <TD style={{ ...tdStyle, color: order.isExit ? color.blue : color.labelTertiary }}>{order.isExit ? 'exit' : 'entry'}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

function FillTable({ fills }: { fills: FillRecord[] }) {
  return (
    <Card>
      <h3 style={h3Style}>FILLS · {fills.length}</h3>
      {fills.length === 0 && <p style={noteStyle}>no fills recorded</p>}
      {fills.length > 0 && (
        <Table>
          <THead>
            <TR>
              <TH style={thStyle}>Time</TH>
              <TH align="right" style={thStyle}>Price</TH>
              <TH align="right" style={thStyle}>Qty</TH>
              <TH align="right" style={thStyle}>Quote</TH>
              <TH align="right" style={thStyle}>Fee</TH>
              <TH style={thStyle}>Trade Id</TH>
            </TR>
          </THead>
          <TBody>
            {fills.map((fill) => (
              <TR key={fill.id}>
                <TD style={{ ...tdStyle, color: color.labelTertiary }}>{formatTimestamp(fill.timestamp)}</TD>
                <TD align="right" mono style={tdStyle}>{formatPrice(fill.price)}</TD>
                <TD align="right" mono style={tdStyle}>{formatQty(fill.quantity)}</TD>
                <TD align="right" mono style={tdStyle}>{formatMoney(fill.quoteQuantity)}</TD>
                <TD align="right" mono style={tdStyle}>{formatMoney(fill.fee)} {fill.feeAsset}</TD>
                <TD style={{ ...tdStyle, color: color.labelTertiary }}>{fill.exchangeTradeId}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

function EventTable({ events }: { events: ExecutionEventRecord[] }) {
  return (
    <Card>
      <h3 style={h3Style}>EVENT LOG · {events.length}</h3>
      {events.length === 0 && <p style={noteStyle}>no events recorded</p>}
      {events.length > 0 && (
        <Table>
          <THead>
            <TR>
              <TH style={thStyle}>Time</TH>
              <TH style={thStyle}>Event</TH>
              <TH style={thStyle}>Payload</TH>
            </TR>
          </THead>
          <TBody>
            {events.map((event) => (
              <TR key={event.id}>
                <TD style={{ ...tdStyle, color: color.labelTertiary }}>{formatTimestamp(event.createdAt)}</TD>
                <TD style={{ ...tdStyle, color: color.blue, fontWeight: fontWeight.bold }}>{event.name}</TD>
                <TD mono style={{ ...tdStyle, color: color.labelTertiary }}>{JSON.stringify(event.payload)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

export function ExecutorProgress({ executionId }: { executionId: string }) {
  const [execution, setExecution] = useState<ExecutionRecord | null>(null);
  const [orders, setOrders] = useState<ChildOrderRecord[]>([]);
  const [fills, setFills] = useState<FillRecord[]>([]);
  const [events, setEvents] = useState<ExecutionEventRecord[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  // The record and its three sub-resources load independently: an orders or
  // events failure must not blank the progress figures the record already
  // answers, so each one is applied (or reported) on its own.
  const load = useCallback(async () => {
    setError('');
    const failures: string[] = [];
    const detail = await getExecution(executionId).catch((err: unknown) => {
      failures.push(errorMessage(err));
      return null;
    });
    if (detail !== null) setExecution(detail.execution);
    const [ordersResult, fillsResult, eventsResult] = await Promise.allSettled([
      listOrders(executionId),
      listFills(executionId),
      listEvents(executionId),
    ]);
    if (ordersResult.status === 'fulfilled') setOrders(ordersResult.value.childOrders);
    else failures.push(`child orders: ${errorMessage(ordersResult.reason)}`);
    if (fillsResult.status === 'fulfilled') setFills(fillsResult.value.fills);
    else failures.push(`fills: ${errorMessage(fillsResult.reason)}`);
    if (eventsResult.status === 'fulfilled') setEvents(eventsResult.value.events);
    else failures.push(`events: ${errorMessage(eventsResult.reason)}`);
    if (failures.length > 0) setError(failures.join('\n'));
  }, [executionId]);

  useEffect(() => { load(); }, [load]);

  const act = useCallback(async (op: 'start' | 'pause' | 'resume' | 'cancel') => {
    setBusy(true);
    setError('');
    try {
      if (op === 'start') await startExecution(executionId);
      else if (op === 'pause') await pauseExecution(executionId);
      else if (op === 'resume') await resumeExecution(executionId);
      else await cancelExecution(executionId);
      setConfirmingCancel(false);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [executionId, load]);

  if (execution === null) {
    return (
      <Card>
        {error !== '' && <Banner variant="error" style={{ margin: `0 0 ${space[8]}px`, whiteSpace: 'pre-wrap', fontWeight: fontWeight.bold }}>⚠ {error}</Banner>}
        {error === '' && <p style={noteStyle}>loading execution {executionId}…</p>}
        <Link href="/executor/history" style={{ color: color.blue, fontSize: fontSize[11] }}>← back to history</Link>
      </Card>
    );
  }

  const terminal = isTerminalExecution(execution.status);
  const remainingQuantity = execution.plannedQuantity - execution.actualQuantity;
  const remainingRisk = diff(execution.plannedRisk, execution.currentRisk);
  const targets = execution.takeProfitDefinition.map((tp) => formatPrice(tp.price)).join(' · ');

  return (
    <>
      <Card style={{ borderColor: color.blue }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: space[8], flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ ...h3Style, margin: 0 }}>{execution.executionStrategy.toUpperCase()} · {execution.status}</h3>
            <p style={{ ...noteStyle, marginTop: space[4] }}>
              {execution.symbol} · {execution.side.toUpperCase()} · {execution.intent} · {execution.mode.toUpperCase()}
              {' · '}{execution.exchange} · <span style={{ color: color.labelTertiary }}>{execution.id}</span>
            </p>
          </div>
          <div style={{ display: 'flex', gap: space[8], flexWrap: 'wrap' }}>
            <Button onClick={load} disabled={busy}>↻ Refresh</Button>
            <Button onClick={() => act('start')} disabled={busy || execution.status !== 'READY'} variant="primary">Start</Button>
            <Button
              onClick={() => act('pause')}
              disabled={busy || (execution.status !== 'RUNNING' && execution.status !== 'PARTIALLY_FILLED' && execution.status !== 'RECONCILING')}
            >
              Pause
</Button>
            <Button onClick={() => act('resume')} disabled={busy || execution.status !== 'PAUSED'} variant="primary">Resume</Button>
            <Button
              onClick={() => setConfirmingCancel(true)}
              disabled={busy || terminal || execution.status === 'CANCEL_REQUESTED' || execution.status === 'DRAFT'}
              variant="danger"
            >
              Cancel
</Button>
          </div>
        </div>

        {confirmingCancel && (
          <div style={{ marginTop: space[8], border: `1px solid ${color.red}`, borderRadius: radius[8], padding: space[8] }}>
            <p style={{ color: color.labelPrimary, fontSize: fontSize[11], margin: `0 0 ${space[8]}px` }}>
              Cancel this execution and the child orders it manages? It cancels open orders — it does <b>not</b> close
              a position that has already opened (PRD §75); closing is a separate, explicit action.
            </p>
            <div style={{ display: 'flex', gap: space[8] }}>
              <Button onClick={() => setConfirmingCancel(false)} disabled={busy}>Keep it running</Button>
              <Button onClick={() => act('cancel')} disabled={busy} variant="danger">Yes, cancel</Button>
            </div>
          </div>
        )}

        {error !== '' && <Banner variant="error" style={{ margin: `0 0 ${space[8]}px`, whiteSpace: 'pre-wrap', fontWeight: fontWeight.bold }}>⚠ {error}</Banner>}

        <div style={{ marginTop: space[12] }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: space[8], margin: `0 0 ${space[4]}px` }}>
            <Meter
              parts={[
                { label: 'filled', value: Math.max(0, fillFraction(execution) ?? 0), color: color.blue },
                { label: 'remaining', value: Math.max(0, 1 - (fillFraction(execution) ?? 0)), color: color.separator },
              ]}
              style={{ flex: 1, minWidth: 120 }}
            />
            <span style={{ color: color.blue, fontWeight: fontWeight.bold, fontSize: fontSize[12] }}>
              {formatCompletionPct(fillFraction(execution))}
            </span>
          </div>
          <div style={{ marginTop: space[8] }}>
            <Row label="Filled / Planned" value={`${formatQty(execution.actualQuantity)} / ${formatQty(execution.plannedQuantity)}`} />
            <Row label="Remaining Quantity" value={formatQty(remainingQuantity)} />
            <Row label="Average Fill" value={formatPrice(execution.averageFillPrice)} />
            <Row label="Notional (actual / planned)" value={`${formatMoney(execution.actualNotional)} / ${formatMoney(execution.plannedNotional)}`} />
            <ElapsedRows execution={execution} />
            <Row label="Planned Risk" value={formatMoney(execution.plannedRisk)} />
            <Row
              label="Current Projected Risk"
              value={formatMoney(execution.currentRisk)}
              tone={execution.currentRisk === null ? undefined : 'good'}
            />
            <Row label="Remaining Risk Budget" value={formatMoney(remainingRisk)} />
            <Row label="Fees (actual / estimated)" value={`${formatMoney(execution.actualFees)} / ${formatMoney(execution.estimatedFees)}`} />
            <Row
              label="Stop / Targets"
              value={`${formatPrice(execution.stopDefinition?.price ?? null)}${targets === '' ? '' : ` · ${targets}`}`}
            />
            <Row
              label="Created / Started / Completed"
              value={`${formatTimestamp(execution.createdAt)} · ${formatTimestamp(execution.startedAt)} · ${formatTimestamp(execution.completedAt)}`}
            />
          </div>
        </div>
      </Card>

      <ChildOrderTable orders={orders} />
      <FillTable fills={fills} />
      <EventTable events={events} />
    </>
  );
}

'use client';
/**
 * ui-history.tsx — ExecutorHistory (§22) + ExecutorOverview (area landing).
 * Split from ui-manage.tsx; re-exported through ./ui-manage and ./ui.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { color, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { Button, Card, Select } from '@/ui/primitives';
import { Banner } from '@/ui/banner';
import { StatusPill } from '@/ui/status-pill';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';
import {
  type ExecutionRecord,
  type ExecutionStatus,
} from '@/lib/executor';
import { formatAgo, formatMoney, formatQty } from './shapers';
import { errorMessage, listExecutions } from './client';
import { h3Style, noteStyle, tdStyle, thStyle } from './ui-shared';

// ---------------------------------------------------------------------------
// ExecutorHistory — §22
// ---------------------------------------------------------------------------

const STATUS_FILTERS: ReadonlyArray<{ value: ExecutionStatus | ''; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'RUNNING', label: 'Running' },
  { value: 'PARTIALLY_FILLED', label: 'Partially filled' },
  { value: 'PAUSED', label: 'Paused' },
  { value: 'READY', label: 'Ready' },
  { value: 'FILLED', label: 'Filled' },
  { value: 'CANCEL_REQUESTED', label: 'Cancel requested' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'RISK_STOPPED', label: 'Risk stopped' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'STOPPED', label: 'Stopped' },
  { value: 'RECONCILING', label: 'Reconciling' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'CALCULATED', label: 'Calculated' },
  { value: 'VALIDATED', label: 'Validated' },
];

export function ExecutorHistory() {
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [status, setStatus] = useState<ExecutionStatus | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const body = await listExecutions(status === '' ? undefined : status);
      setExecutions(body.executions);
    } catch (err) {
      setError(errorMessage(err));
      setExecutions([]);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div style={{ display: 'flex', gap: space[8], alignItems: 'center', flexWrap: 'wrap', marginBottom: space[8] }}>
        <h3 style={{ ...h3Style, margin: 0 }}>EXECUTIONS · §22</h3>
        <Select
 value={status} onChange={(s) => setStatus(s as typeof status)} options={STATUS_FILTERS} />
        <Button onClick={load} disabled={loading}>↻ Refresh</Button>
        <Link
          href="/executor/new"
          style={{ background: color.blue, color: color.labelOnAccent, padding: `${space[8]}px ${space[12]}px`, borderRadius: radius[8], fontSize: fontSize[11], fontWeight: fontWeight.bold, textDecoration: 'none' }}
        >
          + New execution
        </Link>
        <span style={{ color: color.labelTertiary, fontSize: fontSize[11] }}>{loading ? 'loading…' : `${executions.length} shown`}</span>
      </div>
      {error !== '' && <Banner variant="error" style={{ margin: `0 0 ${space[8]}px`, whiteSpace: 'pre-wrap', fontWeight: fontWeight.bold }}>⚠ {error}</Banner>}
      <Card>
        {executions.length === 0 && !loading && <p style={noteStyle}>no executions recorded for this account yet</p>}
        {executions.length > 0 && (
          <Table>
            <THead>
              <TR>
                <TH style={thStyle}>Created</TH>
                <TH style={thStyle}>Status</TH>
                <TH style={thStyle}>Mode</TH>
                <TH style={thStyle}>Symbol</TH>
                <TH style={thStyle}>Side</TH>
                <TH style={thStyle}>Strategy</TH>
                <TH align="right" style={thStyle}>Planned Qty</TH>
                <TH align="right" style={thStyle}>Filled Qty</TH>
                <TH align="right" style={thStyle}>Risk Budget</TH>
                <TH align="right" style={thStyle}>Projected Risk</TH>
                <TH style={thStyle}></TH>
              </TR>
            </THead>
            <TBody>
              {executions.map((execution) => (
                <TR key={execution.id}>
                  <TD style={{ ...tdStyle, color: color.labelTertiary }}>{formatAgo(execution.createdAt)}</TD>
                  <TD style={tdStyle}><StatusPill status={execution.status} /></TD>
                  <TD style={{ ...tdStyle, color: execution.mode === 'live' ? color.red : color.labelTertiary }}>{execution.mode}</TD>
                  <TD style={tdStyle}>{execution.symbol}</TD>
                  <TD style={{ ...tdStyle, color: execution.side === 'buy' ? color.blue : color.red }}>{execution.side.toUpperCase()}</TD>
                  <TD style={tdStyle}>{execution.executionStrategy}</TD>
                  <TD align="right" mono style={tdStyle}>{formatQty(execution.plannedQuantity)}</TD>
                  <TD align="right" mono style={tdStyle}>{formatQty(execution.actualQuantity)}</TD>
                  <TD align="right" mono style={tdStyle}>{formatMoney(execution.riskBudget)}</TD>
                  <TD align="right" mono style={tdStyle}>{formatMoney(execution.currentRisk)}</TD>
                  <TD style={tdStyle}>
                    <Link href={`/executor/${execution.id}`} style={{ color: color.blue, fontSize: fontSize[11] }}>open →</Link>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
// ---------------------------------------------------------------------------
// ExecutorOverview — the area landing: status counts + recent executions
// ---------------------------------------------------------------------------
/**
 * `/executor`'s summary: the same executions feed the history page renders in
 * full, but shaped for an at-a-glance landing — a status histogram and one
 * recent-execution row per status group, never a verbatim table copy.
 */
export function ExecutorOverview() {
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const body = await listExecutions();
      setExecutions(body.executions);
    } catch (err) {
      setError(errorMessage(err));
      setExecutions([]);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  const counts = new Map<ExecutionStatus, number>();
  for (const e of executions) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  const recent = [...executions].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  return (
    <>
      <div style={{ display: 'flex', gap: space[8], alignItems: 'center', flexWrap: 'wrap', marginBottom: space[8] }}>
        <h3 style={{ ...h3Style, margin: 0 }}>EXECUTIONS · OVERVIEW</h3>
        <Button onClick={load} disabled={loading}>↻ Refresh</Button>
        <Link
          href="/executor/new"
          style={{ background: color.blue, color: color.labelOnAccent, padding: `${space[8]}px ${space[12]}px`, borderRadius: radius[8], fontSize: fontSize[11], fontWeight: fontWeight.bold, textDecoration: 'none' }}
        >
          + New execution
        </Link>
        <span style={{ color: color.labelTertiary, fontSize: fontSize[11] }}>{loading ? 'loading…' : `${executions.length} total`}</span>
      </div>
      {error !== '' && <Banner variant="error" style={{ margin: `0 0 ${space[8]}px`, whiteSpace: 'pre-wrap', fontWeight: fontWeight.bold }}>⚠ {error}</Banner>}
      {executions.length === 0 && !loading && !error ? (
        <Card>
          <p style={noteStyle}>no executions recorded for this account yet</p>
        </Card>
      ) : (
        <>
          <Card>
            <h3 style={h3Style}>STATUS COUNTS</h3>
            <div style={{ display: 'flex', gap: space[8], flexWrap: 'wrap' }}>
              {[...counts.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([status, n]) => (
                  <div
                    key={status}
                    style={{ background: color.bgSecondary, border: `1px solid ${color.separator}`, borderRadius: radius[8], padding: `${space[8]}px ${space[12]}px`, fontSize: fontSize[11] }}
                  >
                    <span style={{ color: color.labelTertiary }}>{status}</span>{' '}
                    <span style={{ color: color.blue, fontWeight: fontWeight.bold }}>{n}</span>
                  </div>
                ))}
            </div>
          </Card>
          <Card>
            <h3 style={h3Style}>RECENT EXECUTIONS</h3>
            {recent.length === 0 && !loading ? (
              <p style={noteStyle}>no executions recorded for this account yet</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH style={thStyle}>Created</TH>
                    <TH style={thStyle}>Status</TH>
                    <TH style={thStyle}>Symbol</TH>
                    <TH style={thStyle}>Side</TH>
                    <TH align="right" style={thStyle}>Filled / Planned</TH>
                    <TH style={thStyle}></TH>
                  </TR>
                </THead>
                <TBody>
                  {recent.map((e) => (
                    <TR key={e.id}>
                      <TD style={{ ...tdStyle, color: color.labelTertiary }}>{formatAgo(e.createdAt)}</TD>
                      <TD style={tdStyle}><StatusPill status={e.status} /></TD>
                      <TD style={tdStyle}>{e.symbol}</TD>
                      <TD style={{ ...tdStyle, color: e.side === 'buy' ? color.blue : color.red }}>{e.side.toUpperCase()}</TD>
                      <TD align="right" mono style={tdStyle}>
                        {formatQty(e.actualQuantity)} / {formatQty(e.plannedQuantity)}
                      </TD>
                      <TD style={tdStyle}>
                        <Link href={`/executor/${e.id}`} style={{ color: color.blue, fontSize: fontSize[11] }}>open →</Link>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
          <p style={noteStyle}>
            Full sortable history → <Link href="/executor/history" style={{ color: color.blue }}>/executor/history</Link>
          </p>
        </>
      )}
    </>
  );
}

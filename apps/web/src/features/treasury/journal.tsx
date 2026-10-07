'use client';

import { useCallback, useEffect, useState } from 'react';
import { themeColor, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { Loading } from '@/ui/feedback';
import { Banner } from '@/ui/banner';
import { loadFlows, loadJournalEntries, loadTrialBalance, type Flows, type JournalEntry, type TrialBalance } from './client';
import { DASH, toneOf, usd } from './format';
import { Board, Td, Th } from './parts';

/**
 * journal.tsx — the derived double-entry journal board (DR-047).
 *
 * Three boards over one derivation: the entries, the trial balance, and the
 * flows. The journal is READ from `transactions`, not written to the dead
 * `journal` table, so this board never mutates and cannot drift from the ledger
 * it is computed from.
 *
 * The board is built to show the derivation's own limits: a source row with no
 * amount becomes an `unpriced` entry with an em dash, excluded from every total;
 * and the `1900 Internal clearing` balance — the size of the unmatched internal
 * movement — is shown in the header, not smoothed away. `3000 External flows`
 * and `1900` are labelled as derived accounts, because they are not in the
 * chart of accounts and a reader should know that.
 */

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ background: themeColor.bgSecondary, border: `1px solid ${themeColor.separator}`, borderRadius: radius[8], padding: space[12], minWidth: 148 }}>
      <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], textTransform: 'uppercase' }}>{label}</div>
      <div style={{ color: color ?? themeColor.labelPrimary, fontSize: fontSize[20], fontWeight: fontWeight.bold, marginTop: space[4] }}>{value}</div>
      {sub && <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginTop: space[4] }}>{sub}</div>}
    </div>
  );
}

/** `1010 Cash / bank`, with a `*` for a derived (non-chart) account. */
function Account({ code, name }: { code: string; name: string }) {
  return (
    <span>
      <span style={{ color: themeColor.labelTertiary }}>{code}</span> {name}
      {code === '1900' || code === '3000' ? <span style={{ color: themeColor.orange }}> *</span> : null}
    </span>
  );
}

export default function JournalPanel() {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [trial, setTrial] = useState<TrialBalance | null>(null);
  const [flows, setFlows] = useState<Flows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [e, t, f] = await Promise.allSettled([loadJournalEntries(200), loadTrialBalance(), loadFlows()]);
    if (e.status === 'fulfilled') setEntries(e.value.entries);
    if (t.status === 'fulfilled') setTrial(t.value);
    if (f.status === 'fulfilled') setFlows(f.value);
    const firstErr = [e, t, f].find((r) => r.status === 'rejected');
    if (firstErr && firstErr.status === 'rejected') setError(String(firstErr.reason));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[16] }}>
      {error && <Banner>Some panels failed to load: {error}</Banner>}

      {trial && flows ? (
        <>
          <div style={{ display: 'flex', gap: space[8], flexWrap: 'wrap' }}>
            <Stat
              label="Trial balance"
              value={trial.balanced ? 'balanced' : 'OUT OF BALANCE'}
              sub={`debit ${usd(trial.totalDebit)} · credit ${usd(trial.totalCredit)}`}
              color={trial.balanced ? themeColor.green : themeColor.red}
            />
            <Stat label="Entries" value={String(trial.entryCount)} sub={`${trial.unpriced} unpriced, excluded`} />
            <Stat label="Net flow" value={usd(flows.netUsd)} sub="all buckets" color={toneOf(flows.netUsd)} />
            <Stat label="Fees & funding" value={usd(flows.feesUsd)} sub="operating cost" />
            <Stat label="Realized P&L" value={usd(flows.realizedPnlUsd)} sub="trading result" color={toneOf(flows.realizedPnlUsd)} />
            <Stat
              label="Internal clearing"
              value={usd(flows.internalUnmatchedUsd)}
              sub="unmatched internal movement"
              color={Math.abs(flows.internalUnmatchedUsd) > 0.01 ? themeColor.orange : themeColor.labelPrimary}
            />
          </div>
          <FlowsBoard flows={flows} />
          <TrialBoard trial={trial} />
          <EntriesBoard entries={entries} loading={loading} nameOf={new Map(trial.rows.map((r) => [r.code, r.name]))} />
        </>
      ) : loading ? (
        <Loading label="Deriving the journal from the transaction ledger…" />
      ) : null}

      <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>
        Derived on every read from <code>transactions</code> — the <code>journal</code> table has no writer (DR-036) and posted history is immutable
        (DR-037), so this is a view, never a second copy. <span style={{ color: themeColor.orange }}>*</span> marks a derived counter-account not in the
        chart of accounts. Each entry is a balanced pair; the trial balance is computed, not assumed.
      </div>
    </div>
  );
}

function FlowsBoard({ flows }: { flows: Flows }) {
  return (
    <Board
      title="Flows — operating / external / internal"
      right={<span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>{flows.entryCount} priced entries</span>}
    >
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <Th>Bucket</Th>
              <Th right>Inflow</Th>
              <Th right>Outflow</Th>
              <Th right>Net</Th>
              <Th right>Entries</Th>
            </tr>
          </thead>
          <tbody>
            {flows.buckets.map((b) => (
              <tr key={b.key}>
                <Td>{b.label}</Td>
                <Td right color={themeColor.labelSecondary}>{usd(b.inflowUsd)}</Td>
                <Td right color={themeColor.labelSecondary}>{usd(b.outflowUsd)}</Td>
                <Td right color={toneOf(b.netUsd)}>{usd(b.netUsd)}</Td>
                <Td right color={themeColor.labelTertiary}>{String(b.entries)}</Td>
              </tr>
            ))}
            <tr>
              <Td color={themeColor.labelPrimary}>Net</Td>
              <Td right>{DASH}</Td>
              <Td right>{DASH}</Td>
              <Td right color={toneOf(flows.netUsd)}>{usd(flows.netUsd)}</Td>
              <Td right color={themeColor.labelTertiary}>{String(flows.entryCount)}</Td>
            </tr>
          </tbody>
        </table>
      </div>
      <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginTop: space[8] }}>
        Internal moves net to zero when both legs are present; the {usd(flows.internalUnmatchedUsd)} shown in the header is the size of the gap, not a
        number smoothed away.
      </div>
    </Board>
  );
}

function TrialBoard({ trial }: { trial: TrialBalance }) {
  return (
    <Board
      title="Trial balance"
      right={
        <span style={{ color: trial.balanced ? themeColor.green : themeColor.red, fontSize: fontSize[11] }}>
          {trial.balanced ? 'balanced ✓' : `OUT OF BALANCE ${usd(trial.diff)}`}
        </span>
      }
    >
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <Th>Account</Th>
              <Th>Type</Th>
              <Th>Statement</Th>
              <Th right>Debit</Th>
              <Th right>Credit</Th>
              <Th right>Balance</Th>
            </tr>
          </thead>
          <tbody>
            {trial.rows.map((r) => (
              <tr key={r.code}>
                <Td>
                  <Account code={r.code} name={r.name} />
                </Td>
                <Td color={themeColor.labelSecondary}>{r.type}</Td>
                <Td color={themeColor.labelTertiary}>{r.statement}</Td>
                <Td right color={themeColor.labelSecondary}>{r.debit !== 0 ? usd(r.debit) : DASH}</Td>
                <Td right color={themeColor.labelSecondary}>{r.credit !== 0 ? usd(r.credit) : DASH}</Td>
                <Td right color={r.balance < 0 ? themeColor.red : themeColor.labelPrimary}>{usd(r.balance)}</Td>
              </tr>
            ))}
            <tr>
              <Td color={themeColor.labelPrimary}>Total</Td>
              <Td>{DASH}</Td>
              <Td>{DASH}</Td>
              <Td right color={themeColor.labelPrimary}>{usd(trial.totalDebit)}</Td>
              <Td right color={themeColor.labelPrimary}>{usd(trial.totalCredit)}</Td>
              <Td right>{DASH}</Td>
            </tr>
          </tbody>
        </table>
      </div>
      <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginTop: space[8] }}>
        Total debits equal total credits by construction, and the equality is computed from the entries rather than assumed — a diff of {usd(trial.diff)}
        means an entry is malformed. A negative balance on a normal-side account is flagged red.
      </div>
    </Board>
  );
}

function EntriesBoard({ entries, loading, nameOf }: { entries: JournalEntry[]; loading: boolean; nameOf: Map<string, string> }) {
  return (
    <Board
      title="Journal entries"
      right={<span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>{entries.length} shown · {loading ? '⟳' : 'live'}</span>}
    >
      <div style={{ overflowX: 'auto', maxHeight: 460, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Date</Th>
              <Th>Memo</Th>
              <Th>Debit</Th>
              <Th>Credit</Th>
              <Th right>Amount</Th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.txId}>
                <Td color={themeColor.labelTertiary}>{e.code}</Td>
                <Td color={themeColor.labelSecondary}>{e.date}</Td>
                <Td>{e.memo}</Td>
                <Td>
                  <Account code={e.debitAccount} name={nameOf.get(e.debitAccount) ?? e.debitAccount} />
                </Td>
                <Td>
                  <Account code={e.creditAccount} name={nameOf.get(e.creditAccount) ?? e.creditAccount} />
                </Td>
                <Td right color={e.amount === null ? themeColor.labelTertiary : themeColor.labelPrimary}>
                  {e.amount === null ? <span title="source row had no amount">{DASH} unpriced</span> : usd(e.amount)}
                </Td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <Td>No transactions on record.</Td>
                <Td>{DASH}</Td>
                <Td>{DASH}</Td>
                <Td>{DASH}</Td>
                <Td>{DASH}</Td>
                <Td right>{DASH}</Td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Board>
  );
}


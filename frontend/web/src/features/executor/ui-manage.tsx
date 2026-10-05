'use client';
/**
 * ui-manage.tsx — ExecutorHistory (§22), ExecutorAccounts (§87),
 * ExecutorSettings (§88). Split from ui.tsx; re-exported through ./ui.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { color, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { Button, Card, Input, Label, Select } from '@/ui/primitives';
import { Banner } from '@/ui/banner';
import { Perm } from '@/ui/perm';
import { Field } from '@/ui/field';
import { StatusPill } from '@/ui/status-pill';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';
import {
  DEFAULT_RISK_PROFILE,
  type CredentialRecord,
  type ExecutionRecord,
  type ExecutionStatus,
  type RiskProfile,
} from '@/lib/executor';
import { DASH, formatAgo, formatMoney, formatQty } from './shapers';
import {
  connectAccount,
  deleteAccount,
  errorMessage,
  getSettings,
  listAccounts,
  listExecutions,
  putSettings,
  testAccount,
} from './client';
import { h3Style, noteStyle, pairStyle, tdStyle, thStyle } from './ui-shared';
import { URGENCY_OPTIONS } from './ui-composer';

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

// ---------------------------------------------------------------------------
// ExecutorAccounts — §87
// ---------------------------------------------------------------------------

const EXCHANGE_OPTIONS = [
  { value: 'binance', label: 'Binance' },
  { value: 'bybit', label: 'Bybit' },
  { value: 'mexc', label: 'MEXC' },
] as const;

function ConnectForm({ onConnected }: { onConnected: () => void }) {
  const [exchange, setExchange] = useState('binance');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const submit = useCallback(async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      // Secrets leave the browser exactly once and are cleared immediately; the
      // API only ever answers with the masked key (PRD §109).
      const body = await connectAccount({
        exchange,
        label,
        apiKey,
        apiSecret,
        ...(passphrase.trim() === '' ? {} : { passphrase }),
      });
      setApiKey('');
      setApiSecret('');
      setPassphrase('');
      setLabel('');
      setNotice(`connected ${body.account.label} on ${body.account.exchange} · key ${body.metadata.apiKeyMasked ?? DASH} · health ${body.metadata.health}`);
      onConnected();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [apiKey, apiSecret, exchange, label, onConnected, passphrase]);

  return (
    <Card>
      <h3 style={h3Style}>CONNECT AN EXCHANGE · §43</h3>
      {error !== '' && <Banner variant="error" style={{ margin: `0 0 ${space[8]}px`, whiteSpace: 'pre-wrap', fontWeight: fontWeight.bold }}>⚠ {error}</Banner>}
      {notice !== '' && <p style={{ color: color.blue, fontSize: fontSize[11], fontWeight: fontWeight.bold, margin: `0 0 ${space[8]}px` }}>✓ {notice}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: space[8] }}>
        <Field label="Exchange">
          <Select
 value={exchange} onChange={setExchange} options={EXCHANGE_OPTIONS} />
        </Field>
        <Field label="Label">
          <Input
 value={label} onChange={setLabel} placeholder="e.g. Binance Main" />
        </Field>
        <Field label="API key">
          <Input
 value={apiKey} onChange={setApiKey} placeholder="paste key" type="password" />
        </Field>
        <Field label="API secret">
          <Input
 value={apiSecret} onChange={setApiSecret} placeholder="paste secret" type="password" />
        </Field>
        <Field label="Passphrase (only if your key needs one)">
          <Input
 value={passphrase} onChange={setPassphrase} placeholder="optional" type="password" />
        </Field>
        <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 2 }}>
          <Button onClick={submit} disabled={busy} variant="primary">Connect</Button>
        </div>
      </div>
      <p style={noteStyle}>
        the key is verified on connect and refused if it grants withdrawal permission (PRD §43) · secrets are sealed
        server-side and never displayed again · FUDCourt never takes custody
      </p>
    </Card>
  );
}

export function ExecutorAccounts() {
  const [accounts, setAccounts] = useState<CredentialRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState('');
  const [confirming, setConfirming] = useState<CredentialRecord | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const body = await listAccounts();
      setAccounts(body.accounts);
    } catch (err) {
      setError(errorMessage(err));
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runTest = useCallback(async (account: CredentialRecord) => {
    setBusyId(account.id);
    setError('');
    setNotice('');
    try {
      const body = await testAccount(account.id);
      setNotice(`${body.account.label} · key ${body.metadata.apiKeyMasked ?? DASH} · health ${body.metadata.health} · account type ${body.metadata.accountType ?? DASH}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId('');
      await load();
    }
  }, [load]);

  const runDelete = useCallback(async (account: CredentialRecord) => {
    setBusyId(account.id);
    setError('');
    setNotice('');
    try {
      await deleteAccount(account.id);
      setNotice(`${account.label} revoked — its sealed key is destroyed and no execution can use it again`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId('');
      setConfirming(null);
      await load();
    }
  }, [load]);

  return (
    <>
      <div style={{ display: 'flex', gap: space[8], alignItems: 'center', flexWrap: 'wrap', marginBottom: space[8] }}>
        <h3 style={{ ...h3Style, margin: 0 }}>EXCHANGE ACCOUNTS · §87</h3>
        <Button onClick={load} disabled={loading}>↻ Refresh</Button>
        <span style={{ color: color.labelTertiary, fontSize: fontSize[11] }}>{loading ? 'loading…' : `${accounts.length} connected`}</span>
      </div>
      {error !== '' && <Banner variant="error" style={{ margin: `0 0 ${space[8]}px`, whiteSpace: 'pre-wrap', fontWeight: fontWeight.bold }}>⚠ {error}</Banner>}
      {notice !== '' && <p style={{ color: color.blue, fontSize: fontSize[11], fontWeight: fontWeight.bold, margin: `0 0 ${space[8]}px` }}>✓ {notice}</p>}

      <Card>
        {accounts.length === 0 && !loading && <p style={noteStyle}>no accounts connected yet — add one below to size a trade</p>}
        {accounts.length > 0 && (
          <Table>
            <THead>
              <TR>
                <TH style={thStyle}>Label</TH>
                <TH style={thStyle}>Exchange</TH>
                <TH style={thStyle}>Status</TH>
                <TH style={thStyle}>Key</TH>
                <TH style={thStyle}>Read</TH>
                <TH style={thStyle}>Spot</TH>
                <TH style={thStyle}>Futures</TH>
                <TH style={thStyle}>Withdraw</TH>
                <TH style={thStyle}>Last Sync</TH>
                <TH style={thStyle}>Actions</TH>
              </TR>
            </THead>
            <TBody>
              {accounts.map((account) => (
                <TR key={account.id}>
                  <TD style={tdStyle}>{account.label}</TD>
                  <TD style={tdStyle}>{account.exchange}</TD>
                  <TD style={tdStyle}>
                    <StatusPill status={account.revokedAt === null ? account.health : 'REVOKED'} />
                  </TD>
                  <TD mono style={{ ...tdStyle, color: color.labelTertiary }}>{account.apiKeyMasked}</TD>
                  <TD style={tdStyle}><Perm value={account.permissions.read} /></TD>
                  <TD style={tdStyle}><Perm value={account.permissions.spotTrade} /></TD>
                  <TD style={tdStyle}><Perm value={account.permissions.futuresTrade} /></TD>
                  <TD style={tdStyle}>
                    <Perm value={account.permissions.withdraw} />
                    {account.permissions.withdraw === true && <span style={{ color: color.red, fontWeight: fontWeight.bold }}> · remove it</span>}
                  </TD>
                  <TD style={{ ...tdStyle, color: color.labelTertiary }}>{formatAgo(account.lastUsedAt)}</TD>
                  <TD style={tdStyle}>
                    <div style={{ display: 'flex', gap: space[8] }}>
                      <Button onClick={() => runTest(account)} disabled={busyId === account.id || account.revokedAt !== null}>Test</Button>
                      <Button onClick={() => setConfirming(account)} disabled={account.revokedAt !== null} variant="danger">Delete</Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {confirming !== null && (
        <Card style={{ borderColor: color.red }}>
          <h3 style={{ ...h3Style, color: color.red }}>REVOKE {confirming.label.toUpperCase()}?</h3>
          <p style={{ color: color.labelPrimary, fontSize: fontSize[11], margin: `0 0 ${space[8]}px` }}>
            This destroys the sealed key for {confirming.exchange} ({confirming.apiKeyMasked}). Any execution that still
            needs it can no longer place or cancel orders through FUDCourt, and the secret cannot be recovered. It
            cannot be undone.
          </p>
          <div style={{ display: 'flex', gap: space[8] }}>
            <Button onClick={() => setConfirming(null)} disabled={busyId === confirming.id}>Keep it</Button>
            <Button onClick={() => runDelete(confirming)} disabled={busyId === confirming.id} variant="danger">Revoke key</Button>
          </div>
        </Card>
      )}

      <ConnectForm onConnected={load} />
    </>
  );
}

// ---------------------------------------------------------------------------
// ExecutorSettings — §88
// ---------------------------------------------------------------------------

export function ExecutorSettings() {
  const [profile, setProfile] = useState<RiskProfile>(DEFAULT_RISK_PROFILE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const body = await getSettings();
      setProfile(body.profile);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setNumber = useCallback((key: keyof RiskProfile) => (text: string) => {
    const value = Number(text);
    if (text.trim() !== '' && Number.isFinite(value)) setProfile((prev) => ({ ...prev, [key]: value }));
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const body = await putSettings(profile);
      setProfile(body.profile);
      setNotice('risk profile saved — every new execution is validated against it (PRD §88)');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [profile]);

  return (
    <>
      <div style={{ display: 'flex', gap: space[8], alignItems: 'center', flexWrap: 'wrap', marginBottom: space[8] }}>
        <h3 style={{ ...h3Style, margin: 0 }}>RISK SETTINGS · §88</h3>
        <Button onClick={load} disabled={loading}>↻ Refresh</Button>
        <Button onClick={save} disabled={saving || loading} variant="primary">Save profile</Button>
        <span style={{ color: color.labelTertiary, fontSize: fontSize[11] }}>{loading ? 'loading…' : ''}</span>
      </div>
      {error !== '' && <Banner variant="error" style={{ margin: `0 0 ${space[8]}px`, whiteSpace: 'pre-wrap', fontWeight: fontWeight.bold }}>⚠ {error}</Banner>}
      {notice !== '' && <p style={{ color: color.blue, fontSize: fontSize[11], fontWeight: fontWeight.bold, margin: `0 0 ${space[8]}px` }}>✓ {notice}</p>}

      <Card>
        <div style={{ ...pairStyle }}>
          <Field label="Default risk mode">
            <Select
              value={profile.defaultRiskMode}
              onChange={(defaultRiskMode) => setProfile((prev) => ({ ...prev, defaultRiskMode }))}
              options={[{ value: 'risk_percent', label: 'Risk % of basis' }, { value: 'risk_usd', label: 'Risk $' }]}
            />
          </Field>
          <Field label={profile.defaultRiskMode === 'risk_percent' ? 'Default risk (%)' : 'Default risk ($)'}>
            <Input
 value={String(profile.defaultRisk)} onChange={setNumber('defaultRisk')} type="number" />
          </Field>
          <Field label="Maximum risk / trade (%)">
            <Input
 value={String(profile.maxRiskPerTradePct)} onChange={setNumber('maxRiskPerTradePct')} type="number" />
          </Field>
          <Field label="Max total open risk (%)" hint="committed risk across all live executions, as a % of total exchange equity — a new opening that would exceed it is REFUSED, not resized">
            <Input
 value={String(profile.maxOpenRiskPct)} onChange={setNumber('maxOpenRiskPct')} type="number" />
          </Field>
          <Field label="Max daily loss (%)" hint="once today's realized P&L reaches -this, new openings are blocked; closing and reducing stay available">
            <Input
 value={String(profile.maxDailyLossPct)} onChange={setNumber('maxDailyLossPct')} type="number" />
          </Field>
          <Field label="Max leverage (x)">
            <Input
 value={String(profile.maxLeverage)} onChange={setNumber('maxLeverage')} type="number" />
          </Field>
          <Field label="Default margin mode">
            <Select
              value={profile.defaultMarginMode}
              onChange={(defaultMarginMode) => setProfile((prev) => ({ ...prev, defaultMarginMode }))}
              options={[{ value: 'isolated', label: 'Isolated' }, { value: 'cross', label: 'Cross' }]}
            />
          </Field>
          <Field label="Default execution urgency">
            <Select
              value={profile.defaultExecutionUrgency}
              onChange={(defaultExecutionUrgency) => setProfile((prev) => ({ ...prev, defaultExecutionUrgency }))}
              options={URGENCY_OPTIONS}
            />
          </Field>
        </div>
        <p style={noteStyle}>
          `maxRiskPerTradePct` and `maxLeverage` block a request that exceeds them at creation (PRD §79); the portfolio
          limits are stored for the later enforcement phase · per-account overrides are not available yet (PRD §88)
        </p>
      </Card>
    </>
  );
}

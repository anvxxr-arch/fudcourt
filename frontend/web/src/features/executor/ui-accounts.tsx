'use client';
/**
 * ui-accounts.tsx — ExecutorAccounts (§87) + ConnectForm (§43).
 * Split from ui-manage.tsx; re-exported through ./ui-manage and ./ui.
 */
import { useCallback, useEffect, useState } from 'react';
import { color, fontSize, fontWeight, space } from '@/styles/tokens';
import { Button, Card, Input, Select } from '@/ui/primitives';
import { Banner } from '@/ui/banner';
import { Perm } from '@/ui/perm';
import { Field } from '@/ui/field';
import { StatusPill } from '@/ui/status-pill';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';
import { type CredentialRecord } from '@/lib/executor';
import { DASH, formatAgo } from './shapers';
import {
  connectAccount,
  deleteAccount,
  errorMessage,
  listAccounts,
  testAccount,
} from './client';
import { h3Style, noteStyle, tdStyle, thStyle } from './ui-shared';

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

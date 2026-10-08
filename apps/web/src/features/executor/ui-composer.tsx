'use client';
/**
 * ui-composer.tsx — ExecutorComposer entry (PRD §82, §83, §84, §80).
 * Split from ui.tsx; re-exported through ./ui.
 * Section modules (single source, re-exported below):
 * ./ui-composer-build (ComposerState + builders),
 * ./ui-composer-fields (option constants + LevelEditor), ./ui-composer-preview (PreviewBlock).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { themeColor, fontSize, fontWeight, space } from '@/styles/tokens';
import { Button, Card, Input, Select } from '@/ui/primitives';
import { Banner } from '@/ui/banner';
import { Field } from '@/ui/field';
import { Checkbox } from '@/ui/checkbox';
import type { CredentialRecord } from '@/lib/executor';
import {
  createExecution,
  errorMessage,
  listAccounts,
  preview,
  type PreviewResponse,
} from './client';
import { h3Style, noteStyle, pairStyle } from './ui-shared';
import {
  BASIS_OPTIONS,
  BASIS_SIZING,
  ENTRY_OPTIONS,
  INTENT_OPTIONS,
  LEVERAGE_MODE_OPTIONS,
  LevelEditor,
  MARGIN_OPTIONS,
  MARKET_OPTIONS,
  MODE_OPTIONS,
  POSITION_POLICY_OPTIONS,
  RISK_POLICY_OPTIONS,
  RISK_SIZING,
  SIDE_OPTIONS,
  SIZING_OPTIONS,
  STRATEGY_OPTIONS,
  URGENCY_OPTIONS,
} from './ui-composer-fields';
import { PreviewBlock } from './ui-composer-preview';
import {
  INITIAL,
  buildRequest,
  entryIsLimit,
  missingRequired,
  type ComposerState,
} from './ui-composer-build';

// ExecutorComposer — §82, §83, §84, §80
// ---------------------------------------------------------------------------
export function ExecutorComposer() {
  const router = useRouter();
  const [state, setState] = useState<ComposerState>(INITIAL);
  const [accounts, setAccounts] = useState<CredentialRecord[]>([]);
  const [accountsError, setAccountsError] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  // `request` is the serialized body that produced it, so the block can refuse to
  // show a preview that no longer describes the form.
  const [result, setResult] = useState<{ request: string; preview: PreviewResponse } | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState('');

  const patch = useCallback((change: Partial<ComposerState>) => {
    setState((prev) => ({ ...prev, ...change }));
  }, []);

  const loadAccounts = useCallback(async () => {
    setAccountsError('');
    try {
      const body = await listAccounts();
      setAccounts(body.accounts);
      setState((prev) => (prev.accountId === '' && body.accounts[0] !== undefined ? { ...prev, accountId: body.accounts[0].id } : prev));
    } catch (err) {
      setAccountsError(errorMessage(err));
    }
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const request = useMemo(() => buildRequest(state), [state]);
  const blocking = useMemo(() => missingRequired(state), [state]);
  const serializedRequest = JSON.stringify(request);
  // The preview block is bound to the request that produced it: a form edit
  // invalidates it instead of leaving stale risk figures beside new inputs.
  const shown = result === null || result.request !== serializedRequest ? null : result.preview;
  const conflictCount = shown === null ? 0 : shown.preview.conflicts.length;
  const liveEnabled = result?.preview.liveEnabled ?? false;
  const isSpot = state.marketType === 'spot';

  const runPreview = useCallback(async () => {
    setBusy(true);
    setPreviewError('');
    setSubmitError('');
    try {
      // §98: a preview creates nothing and places nothing, whatever the mode.
      const answer = await preview(buildRequest(state));
      setResult({ request: JSON.stringify(request), preview: answer });
    } catch (err) {
      setPreviewError(errorMessage(err));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [request, state]);

  const submit = useCallback(async () => {
    if (blocking.length > 0) {
      setSubmitError(blocking.join('\n'));
      return;
    }
    setBusy(true);
    setSubmitError('');
    try {
      const created = await createExecution(request);
      setCreatedId(created.execution.id);
      setResult(null);
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [blocking, request]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: space[12], alignItems: 'start' }}>
      <Card>
        <h3 style={h3Style}>NEW EXECUTION · §82</h3>
        {accountsError !== '' && <Banner variant="error" style={{ margin: `0 0 ${space[8]}px`, whiteSpace: 'pre-wrap', fontWeight: fontWeight.bold }}>⚠ {accountsError}</Banner>}

        <Field label="Account">
          <Select
            value={state.accountId}
            onChange={(accountId) => patch({ accountId })}
            options={[
              { value: '', label: accounts.length === 0 ? 'no account connected — connect one first' : 'select an account' },
              ...accounts.map((account) => ({
                value: account.id,
                label: `${account.label} · ${account.exchange} · ${account.health}${account.revokedAt === null ? '' : ' · revoked'}`,
              })),
            ]}
          />
        </Field>
        {accounts.length === 0 && (
          <p style={noteStyle}>
            <Link href="/executor/accounts" style={{ color: themeColor.blue, textDecoration: 'underline' }}>connect an exchange account →</Link>
          </p>
        )}

        <div style={{ ...pairStyle, marginTop: space[8] }}>
          <Field label="Market">
            <Select
 value={state.marketType} onChange={(marketType) => patch({ marketType })} options={MARKET_OPTIONS} />
          </Field>
          <Field label="Symbol (BASE/QUOTE)">
            <Input
 value={state.symbol} onChange={(symbol) => patch({ symbol })} placeholder="BTC/USDT" />
          </Field>
        </div>
        <div style={{ ...pairStyle, marginTop: space[8] }}>
          <Field label="Side">
            <Select
 value={state.side} onChange={(side) => patch({ side })} options={SIDE_OPTIONS} />
          </Field>
          <Field label="Intent">
            <Select
 value={state.intent} onChange={(intent) => patch({ intent })} options={INTENT_OPTIONS} />
          </Field>
        </div>

        <div style={{ borderTop: `1px solid ${themeColor.separator}`, marginTop: space[8], paddingTop: space[8] }}>
          <p style={{ color: themeColor.blue, fontSize: fontSize[11], fontWeight: fontWeight.bold, margin: `0 0 ${space[8]}px` }}>ENTRY · STOP · TARGETS</p>
          <div style={pairStyle}>
            <Field label="Entry type">
              <Select
                value={state.entryType}
                onChange={(entryType) => patch({ entryType })}
                options={ENTRY_OPTIONS}
                disabled={state.strategy === 'market' || state.strategy === 'limit'}
              />
            </Field>
            <Field label={state.strategy === 'limit' ? 'Limit price' : 'Entry price'}>
              <Input
                value={state.entryPrice}
                onChange={(entryPrice) => patch({ entryPrice })}
                placeholder={entryIsLimit(state) ? 'e.g. 100000' : 'market'}
                type="number"
                disabled={!entryIsLimit(state)}
              />
            </Field>
          </div>
          {entryIsLimit(state) && (
            <div style={{ marginTop: space[8] }}>
              <Checkbox label="Post only (maker)" checked={state.postOnly} onChange={(postOnly) => patch({ postOnly })} />
            </div>
          )}
          <div style={{ marginTop: space[8] }}>
            <Field label={`Stop loss${RISK_SIZING.has(state.sizingMode) ? ' (required by §38)' : ''}`}>
              <Input
 value={state.stopLoss} onChange={(stopLoss) => patch({ stopLoss })} placeholder="e.g. 98000" type="number" />
            </Field>
          </div>
          <LevelEditor
            title="Take profit(s) — fraction 0..1, blank = close everything at that level"
            rows={state.takeProfits}
            onChange={(takeProfits) => patch({ takeProfits })}
          />
        </div>

        <div style={{ borderTop: `1px solid ${themeColor.separator}`, marginTop: space[8], paddingTop: space[8] }}>
          <p style={{ color: themeColor.blue, fontSize: fontSize[11], fontWeight: fontWeight.bold, margin: `0 0 ${space[8]}px` }}>SIZING · LEVERAGE</p>
          <div style={pairStyle}>
            <Field label="Sizing mode">
              <Select
 value={state.sizingMode} onChange={(sizingMode) => patch({ sizingMode })} options={SIZING_OPTIONS} />
            </Field>
            <Field label={BASIS_SIZING.has(state.sizingMode) ? 'Risk %' : 'Sizing value'}>
              <Input
 value={state.sizingValue} onChange={(sizingValue) => patch({ sizingValue })} placeholder="e.g. 1" type="number" />
            </Field>
          </div>
          {BASIS_SIZING.has(state.sizingMode) && (
            <div style={{ marginTop: space[8] }}>
              <Field label="Risk basis (PRD §10 — percentage sizing must name its source)">
                <Select
 value={state.basis} onChange={(basis) => patch({ basis })} options={BASIS_OPTIONS} />
              </Field>
            </div>
          )}
          <div style={{ ...pairStyle, marginTop: space[8] }}>
            <Field label="Leverage mode">
              <Select
 value={state.leverageMode} onChange={(leverageMode) => patch({ leverageMode })} options={LEVERAGE_MODE_OPTIONS} disabled={isSpot} />
            </Field>
            {state.leverageMode === 'manual' ? (
              <Field label="Leverage (x)">
                <Input
 value={state.manualLeverage} onChange={(manualLeverage) => patch({ manualLeverage })} type="number" disabled={isSpot} />
              </Field>
            ) : (
              <Field label="Margin mode">
                <Select
 value={state.marginMode} onChange={(marginMode) => patch({ marginMode })} options={MARGIN_OPTIONS} disabled={isSpot} />
              </Field>
            )}
          </div>
        </div>

        <div style={{ borderTop: `1px solid ${themeColor.separator}`, marginTop: space[8], paddingTop: space[8] }}>
          <p style={{ color: themeColor.blue, fontSize: fontSize[11], fontWeight: fontWeight.bold, margin: `0 0 ${space[8]}px` }}>EXECUTION METHOD</p>
          <Field label="Method">
            <Select
 value={state.strategy} onChange={(strategy) => patch({ strategy })} options={STRATEGY_OPTIONS} />
          </Field>
          {(state.strategy === 'twap' || state.strategy === 'adaptive_twap') && (
            <div style={{ ...pairStyle, marginTop: space[8] }}>
              <Field label="Duration (minutes)">
                <Input
 value={state.durationMinutes} onChange={(durationMinutes) => patch({ durationMinutes })} type="number" />
              </Field>
              <Field label="Slices (blank = engine decides)">
                <Input
 value={state.slices} onChange={(slices) => patch({ slices })} placeholder="auto" type="number" />
              </Field>
            </div>
          )}
          {(state.strategy === 'twap' || state.strategy === 'adaptive_twap') && (
            <div style={{ ...pairStyle, marginTop: space[8] }}>
              <Field
                label="Quantity jitter (%)"
                hint="PRD §28/§29 — blank means equal slices; otherwise each slice is randomly scaled by ±this share, then normalized so the total is unchanged"
              >
                <Input
 value={state.quantityJitterPct} onChange={(quantityJitterPct) => patch({ quantityJitterPct })} placeholder="0" type="number" />
              </Field>
              <Field
                label="Interval jitter (%)"
                hint="randomizes the gap between slices; the schedule stays monotonic and inside the duration"
              >
                <Input
 value={state.intervalJitterPct} onChange={(intervalJitterPct) => patch({ intervalJitterPct })} placeholder="0" type="number" />
              </Field>
            </div>
          )}
          {(state.strategy === 'adaptive_twap' || state.strategy === 'chase_limit') && (
            <div style={{ marginTop: space[8] }}>
              <Field label="Urgency">
                <Select
 value={state.urgency} onChange={(urgency) => patch({ urgency })} options={URGENCY_OPTIONS} />
              </Field>
            </div>
          )}
          {state.strategy === 'iceberg' && (
            <div style={{ marginTop: space[8] }}>
              <Field label="Visible quantity">
                <Input
 value={state.visibleQty} onChange={(visibleQty) => patch({ visibleQty })} type="number" />
              </Field>
            </div>
          )}
          {state.strategy === 'chase_limit' && (
            <div style={{ ...pairStyle, marginTop: space[8] }}>
              <Field label="Max chase distance ($)" hint="PRD §32 — how far the peg may travel from arrival before it holds position">
                <Input
 value={state.maxChaseDistance} onChange={(maxChaseDistance) => patch({ maxChaseDistance })} placeholder="unbounded" type="number" />
              </Field>
              <Field label="Max replacements" hint="cancel/replace cycles before the strategy stops (or falls back to market, if enabled)">
                <Input
 value={state.maxReplacements} onChange={(maxReplacements) => patch({ maxReplacements })} placeholder="100" type="number" />
              </Field>
            </div>
          )}
          {(state.strategy === 'scale_in' || state.strategy === 'scale_out') && (
            <LevelEditor title="Scale levels — fractions must sum to 1" rows={state.levels} onChange={(levels) => patch({ levels })} />
          )}
        </div>

        <div style={{ borderTop: `1px solid ${themeColor.separator}`, marginTop: space[8], paddingTop: space[8] }}>
          <button
            className="fc-focusable"
            onClick={() => setShowAdvanced((open) => !open)}
            style={{ background: 'transparent', color: themeColor.blue, border: 'none', cursor: 'pointer', fontSize: fontSize[11], fontWeight: fontWeight.bold, padding: 0 }}
          >
            {showAdvanced ? '▾' : '▸'} ADVANCED CONSTRAINTS
          </button>
          {showAdvanced && (
            <div style={{ marginTop: space[8] }}>
              <div style={pairStyle}>
                <Field label="Max slippage (bps)">
                  <Input
 value={state.maxSlippageBps} onChange={(maxSlippageBps) => patch({ maxSlippageBps })} type="number" />
                </Field>
                <Field label="Max spread (bps)">
                  <Input
 value={state.maxSpreadBps} onChange={(maxSpreadBps) => patch({ maxSpreadBps })} type="number" />
                </Field>
              </div>
              <div style={{ ...pairStyle, marginTop: space[8] }}>
                <Field label="Max price (cap)">
                  <Input
 value={state.maxPrice} onChange={(maxPrice) => patch({ maxPrice })} type="number" />
                </Field>
                <Field label="Min price (floor)">
                  <Input
 value={state.minPrice} onChange={(minPrice) => patch({ minPrice })} type="number" />
                </Field>
              </div>
              <div style={{ marginTop: space[8] }}>
                <Field label="Max duration (minutes)">
                  <Input
 value={state.maxDurationMinutes} onChange={(maxDurationMinutes) => patch({ maxDurationMinutes })} type="number" />
                </Field>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: space[8], marginTop: space[8] }}>
                <Checkbox label="Maker only" checked={state.makerOnly} onChange={(makerOnly) => patch({ makerOnly })} />
                <Checkbox label="Allow market fallback" checked={state.allowMarketFallback} onChange={(allowMarketFallback) => patch({ allowMarketFallback })} />
                <Checkbox label="Cancel if risk exceeded" checked={state.cancelIfRiskExceeded} onChange={(cancelIfRiskExceeded) => patch({ cancelIfRiskExceeded })} />
                <Checkbox label="Stop if disconnected" checked={state.stopIfDisconnected} onChange={(stopIfDisconnected) => patch({ stopIfDisconnected })} />
              </div>
              <div style={{ ...pairStyle, marginTop: space[8] }}>
                <Field label="Risk breach policy">
                  <Select
 value={state.riskPolicy} onChange={(riskPolicy) => patch({ riskPolicy })} options={RISK_POLICY_OPTIONS} />
                </Field>
                <Field label="Existing position">
                  <Select
                    value={state.existingPositionPolicy}
                    onChange={(existingPositionPolicy) => patch({ existingPositionPolicy })}
                    options={POSITION_POLICY_OPTIONS}
                  />
                </Field>
              </div>
            </div>
          )}
        </div>

        <div style={{ borderTop: `1px solid ${themeColor.separator}`, marginTop: space[8], paddingTop: space[8] }}>
          <div style={pairStyle}>
            <Field label="Execution mode">
              <Select
 value={state.mode} onChange={(mode) => patch({ mode })} options={MODE_OPTIONS} />
            </Field>
            <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: space[4] }}>
              <span style={{ color: state.mode === 'live' ? themeColor.red : themeColor.labelTertiary, fontSize: fontSize[11] }}>
                {state.mode === 'live'
                  ? `live is ${liveEnabled ? 'enabled' : 'BLOCKED by the server kill switch'}`
                  : 'paper — the venue adapter simulates the fills'}
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: space[8], marginTop: space[8], flexWrap: 'wrap' }}>
            <Button onClick={runPreview} disabled={busy || blocking.length > 0} variant="primary">Preview</Button>
            <Button onClick={submit} disabled={busy || conflictCount > 0 || blocking.length > 0} variant={state.mode === 'live' ? 'danger' : 'primary'}>
              {state.mode === 'live' ? 'Create LIVE execution' : 'Create execution'}
</Button>
            <Button onClick={() => { setResult(null); setPreviewError(''); setSubmitError(''); setState(INITIAL); }}>Reset</Button>
          </div>
          {blocking.length > 0 && (
            <ul style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], margin: `${space[8]}px 0 0`, paddingLeft: space[16] }}>
              {blocking.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          {state.mode === 'live' && !liveEnabled && (
            <p style={{ ...noteStyle, color: themeColor.red }}>
              live creation is refused by the server unless FUDCOURT_EXECUTOR_LIVE=1 (PRD §108) — paper mode works now
            </p>
          )}
        </div>
      </Card>

      <div>
        {previewError !== '' && <Banner variant="error" style={{ margin: `0 0 ${space[8]}px`, whiteSpace: 'pre-wrap', fontWeight: fontWeight.bold }}>⚠ {previewError}</Banner>}
        {submitError !== '' && <Banner variant="error" style={{ margin: `0 0 ${space[8]}px`, whiteSpace: 'pre-wrap', fontWeight: fontWeight.bold }}>⚠ {submitError}</Banner>}
        {createdId !== '' && (
          <Card style={{ borderColor: themeColor.blue }}>
            <h3 style={h3Style}>CREATED · READY</h3>
            <p style={{ color: themeColor.labelPrimary, fontSize: fontSize[11], margin: `0 0 ${space[8]}px` }}>
              execution <span style={{ color: themeColor.blue, textDecoration: 'underline' }}>{createdId}</span> exists and is waiting — start it from its
              own page, or keep composing.
            </p>
            <Button onClick={() => router.push(`/executor/${createdId}`)} variant="primary">go to execution →</Button>
          </Card>
        )}
        <PreviewBlock shown={shown} stale={result !== null} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// re-exports — section modules split from this file; import from here (or ./ui)
// ---------------------------------------------------------------------------
export type { ComposerState } from './ui-composer-build';
export { INITIAL, buildExecution, buildRequest, entryIsLimit, missingRequired } from './ui-composer-build';

// ---------------------------------------------------------------------------
export type { LevelRow } from './ui-composer-fields';
export {
  BASIS_OPTIONS,
  BASIS_SIZING,
  EMPTY_ROW,
  ENTRY_OPTIONS,
  INTENT_OPTIONS,
  LEVERAGE_MODE_OPTIONS,
  LevelEditor,
  MARGIN_OPTIONS,
  MARKET_OPTIONS,
  MODE_OPTIONS,
  POSITION_POLICY_OPTIONS,
  RISK_POLICY_OPTIONS,
  RISK_SIZING,
  SIDE_OPTIONS,
  SIZING_OPTIONS,
  STRATEGY_OPTIONS,
  URGENCY_OPTIONS,
} from './ui-composer-fields';
export { PreviewBlock } from './ui-composer-preview';

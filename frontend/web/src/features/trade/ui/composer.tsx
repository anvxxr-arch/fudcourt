'use client';

/**
 * composer.tsx — the trade composer (plan Phase 4).
 *
 * "Buy 0.01 BTC on Binance spot" → PREVIEW → risk figures → PLACE. It does not
 * re-implement sizing: it builds an `ExecutionRequest` and sends it to the
 * executor's own risk engine (`POST /api/executor/preview`), then shows exactly
 * the figures that engine returned. A preview persists nothing and places
 * nothing (PRD §98) — creating the execution is a separate, explicit click.
 *
 * THE TWO HONESTY RULES THIS FILE KEEPS.
 *  1. A market type the executor cannot work (options, swap) is a STATED gap:
 *     the composer renders that and sends nothing, rather than posting a request
 *     the planner would reject.
 *  2. The venue's own symbol is resolved through the Phase 5 binding, so no view
 *     builds a native symbol by hand — and a venue whose symbol cannot be
 *     derived from base+quote (a DEX) says so instead of guessing.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { alpha, color, fontSize, fontWeight, letterSpacing, radius, space } from '@/styles/tokens';
import { bindingFor } from '@/features/trade/adapters';
import {
  createTradeExecution,
  errorMessage,
  executorMarketTypeFor,
  fetchTradeAccounts,
  formatPrice,
  formatUsd,
  NO_VALUE,
  previewTradeIntent,
  type TradeAccountLite,
  type TradePreviewResponse,
} from '@/features/trade/client';
import { VENUE_MARKET_TYPES, VENUE_BY_ID, type MarketType, type VenueId } from '@/features/trade/model';
import { BASIS_SIZING, buildTradeRequest, missingRequired, type ComposerState } from '@/features/trade/model';
import { Card } from '@/ui/card';
import { Button, Input, Select } from '@/ui/primitives';
import { Field } from '@/ui/field';
import { Banner } from '@/ui/banner';
import { Row } from '@/ui/row';
import { Notice } from '@/ui/notice';
import type { BalanceBasis, PreviewResult, SizingMode } from '@/lib/executor';

const inputStyle: CSSProperties = {
  width: '100%',
  background: color.bgBase,
  color: color.labelPrimary,
  border: `1px solid ${color.separator}`,
  borderRadius: radius[8],
  padding: `${space[8]}px ${space[8]}px`,
  fontSize: fontSize[12],
  boxSizing: 'border-box',
};

const pairStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: space[8] };

const h3Style: CSSProperties = {
  color: color.blue,
  fontSize: fontSize[12],
  fontWeight: fontWeight.bold,
  margin: `0 0 ${space[8]}px`,
  letterSpacing: letterSpacing.sm,
};







const SIZING_OPTIONS: ReadonlyArray<{ value: SizingMode; label: string }> = [
  { value: 'risk_percent', label: 'Risk % of basis' },
  { value: 'risk_usd', label: 'Risk $' },
  { value: 'allocation_percent', label: 'Allocation % of basis' },
  { value: 'allocation_usd', label: 'Allocation $' },
  { value: 'notional_usd', label: 'Notional $' },
  { value: 'fixed_quantity', label: 'Fixed quantity' },
  { value: 'fixed_margin', label: 'Fixed margin $' },
  { value: 'target_profit_percent', label: 'Target profit % of basis' },
  { value: 'target_profit_usd', label: 'Target profit $' },
];

const BASIS_OPTIONS: ReadonlyArray<{ value: BalanceBasis; label: string }> = [
  { value: 'spot_available', label: 'Spot available' },
  { value: 'spot_equity', label: 'Spot equity' },
  { value: 'futures_available', label: 'Futures available' },
  { value: 'futures_equity', label: 'Futures equity' },
  { value: 'total_exchange_equity', label: 'Total exchange equity' },
  { value: 'asset_equity', label: 'Asset equity' },
  { value: 'custom', label: 'Custom' },
];

function PreviewPanel({ shown }: { shown: TradePreviewResponse | null }) {
  if (shown === null) {
    return (
      <Card title="Risk preview" subtitle="nothing is sized, priced or sent until the engine answers for this exact request">
        <p style={{ margin: 0, fontSize: fontSize[11], color: color.labelTertiary }}>
          Press Preview — the executor&apos;s risk engine returns the size, the risk figures and any conflicts, and persists nothing (PRD §98).
        </p>
      </Card>
    );
  }
  const preview: PreviewResult = shown.preview;
  const plan = preview.plan;
  return (
    <Card title="Risk preview" subtitle={`${plan.symbol} · ${plan.side.toUpperCase()} · ${plan.venueKey}`}>
      <Row label="Risk Budget" value={formatUsd(plan.risk.budget)} />
      <Row label="Sizing Reference Balance" value={formatUsd(plan.balanceReference)} />
      <Row label="Quantity" value={String(plan.quantity)} />
      <Row label="Notional" value={formatUsd(plan.notional)} />
      <Row label="Margin Required" value={formatUsd(plan.margin.estimatedInitial)} />
      <Row
        label="Leverage"
        value={plan.leverage.selected === null ? NO_VALUE : `${plan.leverage.selected}x · ${plan.leverage.mode}`}
      />
      <Row label="Entry Estimate" value={formatPrice(plan.estimatedEntry)} />
      <Row label="Stop" value={formatPrice(plan.stopLoss)} />
      <Row label="Estimated Fees" value={formatUsd(plan.risk.estimatedFees)} />
      <Row label="Total Planned Risk" value={formatUsd(plan.risk.estimatedTotalRisk)} />
      <Row label="Loss @ SL" value={formatUsd(preview.expectedLossAtStop)} tone="neg" />
      <Row label="Profit @ TP" value={formatUsd(preview.expectedProfitAtTarget)} tone="pos" />
      <Row label="Risk / Reward" value={preview.riskReward === null ? NO_VALUE : preview.riskReward.toFixed(2)} />
      <Row label="Liquidation Price" value={formatPrice(plan.liquidation.priceApprox)} />
      {preview.conflicts.length > 0 && (
        <div style={{ marginTop: space[8], borderTop: `1px solid ${color.red}`, paddingTop: space[8] }}>
          {preview.conflicts.map((c) => (
            <p key={c.code} style={{ margin: `0 0 ${space[4]}px`, fontSize: fontSize[11], color: color.labelPrimary }}>
              <span style={{ color: color.red, fontWeight: fontWeight.bold }}>{c.code}</span> — {c.message}
            </p>
          ))}
        </div>
      )}
      {preview.warnings.length > 0 && (
        <div style={{ marginTop: space[8], borderTop: `1px solid ${color.separator}`, paddingTop: space[8] }}>
          {preview.warnings.map((w) => (
            <p key={w} style={{ margin: '0 0 3px', fontSize: fontSize[11], color: color.labelTertiary }}>· {w}</p>
          ))}
        </div>
      )}
    </Card>
  );
}

export function TradeComposer({ marketType, defaultBase, defaultQuote }: {
  marketType: MarketType;
  /** Pre-filled base, for the instrument page (`/trade/spot/btc-usdt` → BTC). */
  defaultBase?: string;
  /** Pre-filled quote, for the instrument page. */
  defaultQuote?: string;
}) {
  const venues = useMemo<readonly VenueId[]>(() => VENUES_FOR(marketType), [marketType]);
  const execMT = executorMarketTypeFor(marketType);
  const [state, setState] = useState<ComposerState>({
    accountId: '',
    venue: venues[0] ?? 'binance',
    base: defaultBase ?? 'BTC',
    quote: defaultQuote ?? 'USDT',
    side: 'buy',
    intent: 'open',
    entryType: 'market',
    entryPrice: '',
    postOnly: false,
    stopLoss: '',
    takeProfit: '',
    sizingMode: 'risk_percent',
    sizingValue: '1',
    basis: execMT === 'linear_perp' ? 'futures_equity' : 'spot_equity',
    leverageMode: 'auto_safe',
    manualLeverage: '5',
    marginMode: '',
    mode: 'paper',
  });
  const [accounts, setAccounts] = useState<TradeAccountLite[]>([]);
  const [accountsError, setAccountsError] = useState('');
  const [shown, setShown] = useState<TradePreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState('');

  const patch = useCallback((change: Partial<ComposerState>) => setState((prev) => ({ ...prev, ...change })), []);

  useEffect(() => {
    const ac = new AbortController();
    fetchTradeAccounts(ac.signal)
      .then((rows) => {
        if (ac.signal.aborted) return;
        setAccounts(rows);
        setState((prev) => (prev.accountId === '' && rows[0] !== undefined ? { ...prev, accountId: rows[0].id } : prev));
      })
      .catch((err) => !ac.signal.aborted && setAccountsError(errorMessage(err)));
    return () => ac.abort();
  }, []);

  const request = useMemo(() => buildTradeRequest(state, marketType), [state, marketType]);
  const blocking = useMemo(() => missingRequired(state, marketType), [state, marketType]);
  const binding = bindingFor(state.venue);
  const venueSymbol = binding.venueSymbol(state.base, state.quote, marketType);
  const conflictCount = shown === null ? 0 : shown.preview.conflicts.length;
  const liveEnabled = shown?.liveEnabled ?? false;

  if (execMT === null) {
    return (
      <Card title="Composer" subtitle="an intent the executor cannot work yet">
        <Notice>
          The executor works a spot book and a linear perpetual. {marketType} has no executor counterpart yet, so the
          composer sends nothing rather than a request the planner would reject. The venue capability board below states
          what each venue offers for it.
        </Notice>
      </Card>
    );
  }

  const runPreview = useCallback(async () => {
    if (request === null) return;
    setBusy(true);
    setPreviewError('');
    setSubmitError('');
    try {
      const answer = await previewTradeIntent(request);
      setShown(answer);
    } catch (err) {
      setPreviewError(errorMessage(err));
      setShown(null);
    } finally {
      setBusy(false);
    }
  }, [request]);

  const place = useCallback(async () => {
    if (request === null || blocking.length > 0) {
      if (blocking.length > 0) setSubmitError(blocking.join('\n'));
      return;
    }
    setBusy(true);
    setSubmitError('');
    try {
      const created = await createTradeExecution(request);
      setCreatedId(created.execution.id);
      setShown(null);
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [request, blocking]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) minmax(300px, 400px)', gap: space[12], alignItems: 'start' }}>
      <Card>
        <h3 style={h3Style}>COMPOSE A TRADE · {marketType.toUpperCase()}</h3>
        {accountsError !== '' && <Banner variant="error" style={{ margin: `0 0 ${space[8]}px`, whiteSpace: 'pre-wrap' }}>⚠ {accountsError}</Banner>}

        <div style={{ ...pairStyle }}>
          <Field label="Account">
            <Select
              value={state.accountId}
              onChange={(accountId) => patch({ accountId })}
              options={[
                { value: '', label: accounts.length === 0 ? 'no account — connect one first' : 'select an account' },
                ...accounts.map((a) => ({ value: a.id, label: `${a.label} · ${a.exchange}` })),
              ]}
            />
          </Field>
          <Field label="Venue">
            <Select
              value={state.venue}
              onChange={(venue) => patch({ venue })}
              options={venues.map((v) => ({ value: v, label: `${VENUE_BY_ID[v].label} · ${VENUE_BY_ID[v].type}` }))}
            />
          </Field>
        </div>

        <div style={{ ...pairStyle, marginTop: space[8] }}>
          <Field label="Base">
            <Input value={state.base} onChange={(base) => patch({ base })} placeholder="BTC" />
          </Field>
          <Field label="Quote">
            <Input value={state.quote} onChange={(quote) => patch({ quote })} placeholder="USDT" />
          </Field>
        </div>
        <p style={{ margin: `${space[4]}px 0 0`, fontSize: fontSize[11], color: color.labelTertiary }}>
          venue symbol: {venueSymbol === null ? 'resolved from the venue token list at call time (not derivable from base+quote)' : venueSymbol}
        </p>

        <div style={{ ...pairStyle, marginTop: space[8] }}>
          <Field label="Side">
            <Select
              value={state.side}
              onChange={(side) => patch({ side })}
              options={[{ value: 'buy', label: 'Long / buy' }, { value: 'sell', label: 'Short / sell' }]}
            />
          </Field>
          <Field label="Intent">
            <Select
              value={state.intent}
              onChange={(intent) => patch({ intent })}
              options={[{ value: 'open', label: 'Open' }, { value: 'close', label: 'Close' }, { value: 'reduce', label: 'Reduce' }]}
            />
          </Field>
        </div>

        <div style={{ borderTop: `1px solid ${color.separator}`, marginTop: space[8], paddingTop: space[8] }}>
          <div style={pairStyle}>
            <Field label="Entry type">
              <Select
                value={state.entryType}
                onChange={(entryType) => patch({ entryType })}
                options={[{ value: 'market', label: 'Market' }, { value: 'limit', label: 'Limit' }]}
              />
            </Field>
            <Field label="Entry price">
              <Input value={state.entryPrice} onChange={(entryPrice) => patch({ entryPrice })} type="number" disabled={state.entryType !== 'limit'} placeholder={state.entryType === 'limit' ? 'e.g. 100000' : 'market'} />
            </Field>
          </div>
          <div style={{ ...pairStyle, marginTop: space[8] }}>
            <Field label="Stop loss">
              <Input value={state.stopLoss} onChange={(stopLoss) => patch({ stopLoss })} type="number" placeholder="e.g. 98000" />
            </Field>
            <Field label="Take profit">
              <Input value={state.takeProfit} onChange={(takeProfit) => patch({ takeProfit })} type="number" placeholder="e.g. 105000" />
            </Field>
          </div>
        </div>

        <div style={{ borderTop: `1px solid ${color.separator}`, marginTop: space[8], paddingTop: space[8] }}>
          <div style={pairStyle}>
            <Field label="Sizing mode">
              <Select value={state.sizingMode} onChange={(sizingMode) => patch({ sizingMode })} options={SIZING_OPTIONS} />
            </Field>
            <Field label={BASIS_SIZING.has(state.sizingMode) ? 'Risk %' : 'Sizing value'}>
              <Input value={state.sizingValue} onChange={(sizingValue) => patch({ sizingValue })} type="number" placeholder="e.g. 1" />
            </Field>
          </div>
          {BASIS_SIZING.has(state.sizingMode) && (
            <div style={{ marginTop: space[8] }}>
              <Field label="Risk basis">
                <Select value={state.basis} onChange={(basis) => patch({ basis })} options={BASIS_OPTIONS} />
              </Field>
            </div>
          )}
          {execMT === 'linear_perp' && (
            <div style={{ ...pairStyle, marginTop: space[8] }}>
              <Field label="Leverage mode">
                <Select
                  value={state.leverageMode}
                  onChange={(leverageMode) => patch({ leverageMode })}
                  options={[{ value: 'auto_safe', label: 'Auto safe' }, { value: 'manual', label: 'Manual' }]}
                />
              </Field>
              {state.leverageMode === 'manual' ? (
                <Field label="Leverage (x)">
                  <Input value={state.manualLeverage} onChange={(manualLeverage) => patch({ manualLeverage })} type="number" />
                </Field>
              ) : (
                <Field label="Margin mode">
                  <Select
                    value={state.marginMode}
                    onChange={(marginMode) => patch({ marginMode })}
                    options={[{ value: '', label: 'Risk profile default' }, { value: 'isolated', label: 'Isolated' }, { value: 'cross', label: 'Cross' }]}
                  />
                </Field>
              )}
            </div>
          )}
        </div>

        <div style={{ borderTop: `1px solid ${color.separator}`, marginTop: space[8], paddingTop: space[8] }}>
          <div style={pairStyle}>
            <Field label="Execution mode">
              <Select
                value={state.mode}
                onChange={(mode) => patch({ mode })}
                options={[{ value: 'paper', label: 'Paper (simulated)' }, { value: 'live', label: 'LIVE (real order)' }]}
              />
            </Field>
            <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: space[4] }}>
              <span style={{ fontSize: fontSize[11], color: state.mode === 'live' ? color.red : color.labelTertiary }}>
                {state.mode === 'live'
                  ? `live is ${liveEnabled ? 'enabled' : 'BLOCKED by the server kill switch'}`
                  : 'paper — the venue adapter simulates the fills'}
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: space[8], marginTop: space[8], flexWrap: 'wrap' }}>
            <Button onClick={runPreview} disabled={busy || blocking.length > 0} variant="primary">Preview</Button>
            <Button onClick={place} disabled={busy || conflictCount > 0 || blocking.length > 0} variant={state.mode !== 'live' ? 'primary' : 'ghost'}>
              {state.mode === 'live' ? 'Place LIVE order' : 'Place paper order'}
            </Button>
          </div>
          {blocking.length > 0 && (
            <ul style={{ color: color.labelTertiary, fontSize: fontSize[11], margin: `${space[8]}px 0 0`, paddingLeft: space[16] }}>
              {blocking.map((item) => <li key={item}>{item}</li>)}
            </ul>
          )}
        </div>
      </Card>

      <div>
        {previewError !== '' && <Banner variant="error" style={{ margin: `0 0 ${space[8]}px`, whiteSpace: 'pre-wrap' }}>⚠ {previewError}</Banner>}
        {submitError !== '' && <Banner variant="error" style={{ margin: `0 0 ${space[8]}px`, whiteSpace: 'pre-wrap' }}>⚠ {submitError}</Banner>}
        {createdId !== '' && (
          <Card>
            <p style={{ margin: `0 0 ${space[8]}px`, fontSize: fontSize[11], color: color.labelPrimary }}>
              execution <span style={{ color: color.blue }}>{createdId}</span> created and ready — start it from the executor.
            </p>
          </Card>
        )}
        <PreviewPanel shown={shown} />
      </div>
    </div>
  );
}

/** The venues the taxonomy says serve a market type. */
function VENUES_FOR(marketType: MarketType): readonly VenueId[] {
  return (Object.keys(VENUE_MARKET_TYPES) as VenueId[]).filter((venue) => VENUE_MARKET_TYPES[venue].includes(marketType));
}

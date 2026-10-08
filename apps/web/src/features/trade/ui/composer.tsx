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
 *
 * Layout: state + data-fetching live here; the form column is ComposerFields
 * (composer-fields.tsx) and the preview column is PreviewColumn
 * (composer-preview.tsx). Shared styles/options/helpers live in
 * composer-shared.tsx and are re-exported below so existing deep importers
 * keep working unchanged.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { space } from '@/styles/tokens';
import { bindingFor } from '@/features/trade/adapters';
import {
  createTradeExecution,
  errorMessage,
  executorMarketTypeFor,
  fetchTradeAccounts,
  previewTradeIntent,
  type TradeAccountLite,
  type TradePreviewResponse,
} from '@/features/trade/client';
import { type MarketType, type VenueId } from '@/features/trade/model';
import { buildTradeRequest, missingRequired, type ComposerState } from '@/features/trade/model';
import { Card } from '@/ui/card';
import { Notice } from '@/ui/notice';
import { ComposerFields } from './composer-fields';
import { PreviewColumn } from './composer-preview';
import { VENUES_FOR } from './composer-shared';

export { BASIS_OPTIONS, h3Style, pairStyle, SIZING_OPTIONS, VENUES_FOR } from './composer-shared';
export { ComposerFields, type ComposerFieldsProps } from './composer-fields';
export { PreviewColumn, PreviewPanel } from './composer-preview';

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
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(min(320px, 100%), 1fr) minmax(300px, 400px)', gap: space[12], alignItems: 'start' }}>
      <Card>
        <ComposerFields
          state={state}
          patch={patch}
          accounts={accounts}
          accountsError={accountsError}
          venues={venues}
          venueSymbol={venueSymbol}
          marketType={marketType}
          execMT={execMT}
          blocking={blocking}
          busy={busy}
          conflictCount={conflictCount}
          liveEnabled={liveEnabled}
          runPreview={runPreview}
          place={place}
        />
      </Card>

      <PreviewColumn previewError={previewError} submitError={submitError} createdId={createdId} shown={shown} />
    </div>
  );
}

'use client';
/**
 * composer-fields.tsx — the trade composer's form column.
 *
 * Split from composer.tsx (verbatim JSX); rendered by TradeComposer inside
 * its Card. Owns no state: every value comes in through props.
 */
import { themeColor, fontSize, space } from '@/styles/tokens';
import { VENUE_BY_ID, BASIS_SIZING, type ComposerState, type MarketType, type VenueId } from '@/features/trade/model';
import type { TradeAccountLite } from '@/features/trade/client';
import { Button, Input, Select } from '@/ui/primitives';
import { Field } from '@/ui/field';
import { Banner } from '@/ui/banner';
import { BASIS_OPTIONS, SIZING_OPTIONS, h3Style, pairStyle } from './composer-shared';

export interface ComposerFieldsProps {
  state: ComposerState;
  patch: (change: Partial<ComposerState>) => void;
  accounts: TradeAccountLite[];
  accountsError: string;
  venues: readonly VenueId[];
  venueSymbol: string | null;
  marketType: MarketType;
  /** Non-null here: the entry renders a stated-gap card when the executor has no counterpart. */
  execMT: 'spot' | 'linear_perp';
  blocking: string[];
  busy: boolean;
  conflictCount: number;
  liveEnabled: boolean;
  runPreview: () => void;
  place: () => void;
}

export function ComposerFields({
  state,
  patch,
  accounts,
  accountsError,
  venues,
  venueSymbol,
  marketType,
  execMT,
  blocking,
  busy,
  conflictCount,
  liveEnabled,
  runPreview,
  place,
}: ComposerFieldsProps) {
  return (
    <>
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
      <p style={{ margin: `${space[4]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary }}>
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

      <div style={{ borderTop: `1px solid ${themeColor.separator}`, marginTop: space[8], paddingTop: space[8] }}>
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

      <div style={{ borderTop: `1px solid ${themeColor.separator}`, marginTop: space[8], paddingTop: space[8] }}>
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

      <div style={{ borderTop: `1px solid ${themeColor.separator}`, marginTop: space[8], paddingTop: space[8] }}>
        <div style={pairStyle}>
          <Field label="Execution mode">
            <Select
              value={state.mode}
              onChange={(mode) => patch({ mode })}
              options={[{ value: 'paper', label: 'Paper (simulated)' }, { value: 'live', label: 'LIVE (real order)' }]}
            />
          </Field>
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: space[4] }}>
            <span style={{ fontSize: fontSize[11], color: state.mode === 'live' ? themeColor.red : themeColor.labelTertiary }}>
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
          <ul style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], margin: `${space[8]}px 0 0`, paddingLeft: space[16] }}>
            {blocking.map((item) => <li key={item}>{item}</li>)}
          </ul>
        )}
      </div>
    </>
  );
}

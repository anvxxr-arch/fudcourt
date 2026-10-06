'use client';
/**
 * ui-composer-preview.tsx — risk preview block (PRD §84, §80, §23).
 * Split from ui-composer.tsx; re-exported through ./ui-composer (and ./ui).
 */
import { Card } from '@/ui/primitives';
import { color, fontSize, fontWeight, space } from '@/styles/tokens';
import { Row } from '@/ui/row';
import type { PreviewResult } from '@/lib/executor';
import {
  DASH,
  decimalsForStep,
  formatBps,
  formatDuration,
  formatMoney,
  formatPct,
  formatPrice,
  formatQty,
  formatRiskReward,
} from './shapers';
import { type PreviewResponse } from './client';
import { h3Style, noteStyle } from './ui-shared';

// risk preview block (PRD §84, §80, §23)
// ---------------------------------------------------------------------------

export function PreviewBlock({ shown, stale }: { shown: PreviewResponse | null; stale: boolean }) {
  const preview: PreviewResult | null = shown === null ? null : shown.preview;
  const plan = preview === null ? null : preview.plan;
  const balances = plan?.balanceSnapshot ?? null;
  const stepDecimals = plan === null ? null : decimalsForStep(plan.instrument.stepSize);
  const tickSize = plan === null ? null : plan.instrument.tickSize;
  const equity = balances === null || plan === null
    ? null
    : plan.marketType === 'spot' ? balances.spotEquity : balances.futuresEquity;
  const conflictCount = preview?.conflicts.length ?? 0;
  return (
    <Card style={{ borderColor: conflictCount > 0 ? color.red : color.separator }}>
      <h3 style={h3Style}>RISK PREVIEW · §84</h3>
      {preview === null && (
        <p style={noteStyle}>
          {stale
            ? 'the form changed since this preview — the figures were cleared because they no longer describe this request; press Preview again'
            : 'no preview yet — nothing is sized, priced or sent until the engine answers for this exact request'}
        </p>
      )}
      {plan !== null && (
        <>
          <p style={{ color: color.labelPrimary, fontSize: fontSize[13], fontWeight: fontWeight.bold, margin: '0 0 2px' }}>
            {plan.symbol} · {plan.side.toUpperCase()} · {plan.venueKey}
          </p>
          <p style={noteStyle}>
            {plan.sizingMode} {plan.sizingValue}
            {plan.riskBasis === null ? '' : ` of ${plan.riskBasis}`}
            {' · '}{plan.execution.strategy}
            {plan.execution.durationMs === null ? '' : ` over ${formatDuration(plan.execution.durationMs)}`}
            {plan.execution.estimatedSlices === null ? '' : ` · ${plan.execution.estimatedSlices} slices`}
            {plan.execution.urgency === null ? '' : ` · ${plan.execution.urgency}`}
          </p>
          <div style={{ marginTop: space[8] }}>
            <Row label="Account Equity" value={formatMoney(equity)} />
            <Row label="Risk Budget" value={formatMoney(plan.risk.budget)} />
            <Row label="Sizing Reference Balance" value={formatMoney(plan.balanceReference)} />
            <Row label="Quantity" value={formatQty(plan.quantity, stepDecimals)} />
            <Row label="Notional" value={formatMoney(plan.notional)} />
            <Row label="Margin Required" value={formatMoney(plan.margin.estimatedInitial)} />
            <Row
              label="Leverage"
              value={plan.leverage.selected === null
                ? DASH
                : `${plan.leverage.selected}x · ${plan.leverage.mode === 'auto_safe' ? 'AUTO SAFE' : 'MANUAL'}`}
            />
            <Row label="Margin Mode" value={plan.margin.mode ?? DASH} />
            <Row label="Entry Estimate" value={formatPrice(plan.estimatedEntry, tickSize)} />
            <Row label="Stop" value={formatPrice(plan.stopLoss, tickSize)} />
            <Row
              label="Take Profit(s)"
              value={plan.takeProfits.length === 0
                ? DASH
                : plan.takeProfits
                  .map((tp) => `${formatPrice(tp.price, tickSize)}${tp.fraction === undefined ? '' : ` (${formatPct(tp.fraction)})`}`)
                  .join(' · ')}
            />
            <Row label="Estimated Fees" value={formatMoney(plan.risk.estimatedFees)} />
            <Row label="Estimated Slippage" value={`${formatMoney(plan.risk.slippageBudget)} · ${formatBps(plan.slippageModel.slippageBps)}`} />
            <Row label="Price Risk" value={formatMoney(plan.risk.priceRisk)} />
            <Row label="Safety Reserve" value={formatMoney(plan.risk.safetyReserve)} />
            <Row label="Total Planned Risk" value={formatMoney(plan.risk.estimatedTotalRisk)} />
            <Row label="Loss @ SL" value={formatMoney(preview?.expectedLossAtStop, { signed: true })} tone="bad" />
            <Row label="Profit @ TP" value={formatMoney(preview?.expectedProfitAtTarget, { signed: true })} tone="good" />
            <Row label="Risk / Reward" value={formatRiskReward(preview?.riskReward)} />
            <Row label="Liquidation Price" value={formatPrice(plan.liquidation.priceApprox, tickSize)} />
            <Row
              label="SL → Liquidation Buffer"
              value={plan.liquidation.stopToLiquidationBuffer === null
                ? DASH
                : `${formatMoney(plan.liquidation.stopToLiquidationBuffer)}${plan.liquidation.safe === false ? ' · UNSAFE' : plan.liquidation.safe === true ? ' · safe' : ''}`}
              tone={plan.liquidation.safe === false ? 'bad' : undefined}
            />
          </div>
        </>
      )}
      {preview !== null && conflictCount > 0 && (
        <div style={{ marginTop: space[8], borderTop: `1px solid ${color.red}`, paddingTop: space[8] }}>
          <p style={{ color: color.red, fontSize: fontSize[11], fontWeight: fontWeight.bold, margin: `0 0 ${space[4]}px` }}>
            {conflictCount} CONFLICT{conflictCount === 1 ? '' : 'S'} — creation is blocked (PRD §117)
          </p>
          {preview.conflicts.map((conflict) => (
            <p key={conflict.code} style={{ color: color.labelPrimary, fontSize: fontSize[11], margin: `0 0 ${space[4]}px` }}>
              <span style={{ color: color.red, fontWeight: fontWeight.bold }}>{conflict.code}</span> — {conflict.message}
              {conflict.detail !== undefined && (
                <span style={{ color: color.labelTertiary }}>{' '}({Object.entries(conflict.detail).map(([key, value]) => `${key}=${value}`).join(', ')})</span>
              )}
            </p>
          ))}
        </div>
      )}
      {preview !== null && preview.warnings.length > 0 && (
        <div style={{ marginTop: space[8], borderTop: `1px solid ${color.separator}`, paddingTop: space[8] }}>
          <p style={{ color: color.blue, fontSize: fontSize[11], fontWeight: fontWeight.bold, margin: `0 0 ${space[4]}px` }}>
            {preview.warnings.length} WARNING{preview.warnings.length === 1 ? '' : 'S'} — shown, not blocking
          </p>
          {preview.warnings.map((warning) => (
            <p key={warning} style={{ color: color.labelTertiary, fontSize: fontSize[11], margin: '0 0 3px' }}>· {warning}</p>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

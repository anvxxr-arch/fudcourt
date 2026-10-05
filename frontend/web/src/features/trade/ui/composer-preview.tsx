'use client';
/**
 * composer-preview.tsx — the trade composer's risk-preview column.
 *
 * Split from composer.tsx (verbatim JSX + helpers); rendered by TradeComposer
 * next to the form. Shows exactly the figures the executor's risk engine
 * returned for the current preview, plus any banners.
 */
import { color, fontSize, fontWeight, space } from '@/styles/tokens';
import { formatPrice, formatUsd, NO_VALUE, type TradePreviewResponse } from '@/features/trade/client';
import { Card } from '@/ui/card';
import { Banner } from '@/ui/banner';
import { Row } from '@/ui/row';
import type { PreviewResult } from '@/lib/executor';

export function PreviewPanel({ shown }: { shown: TradePreviewResponse | null }) {
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


export function PreviewColumn({
  previewError,
  submitError,
  createdId,
  shown,
}: {
  previewError: string;
  submitError: string;
  createdId: string;
  shown: TradePreviewResponse | null;
}) {
  return (
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
  );
}

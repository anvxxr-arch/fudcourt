'use client';
/**
 * ui-composer-fields.tsx — composer option constants + LevelEditor (PRD §82, §83).
 * Split from ui-composer.tsx; single source for the option constants.
 * Re-exported through ./ui-composer (and ./ui); import from there.
 */
import { Button, Input, Label } from '@/ui/primitives';
import { space } from '@/styles/tokens';
import type {
  BalanceBasis,
  ExecutionMode,
  ExecutionStrategy,
  ExecutionUrgency,
  MarginMode,
  SizingMode,
} from '@/lib/executor';
import { pairStyle } from './ui-shared';

export type LevelRow = { price: string; fraction: string };

export const EMPTY_ROW: LevelRow = { price: '', fraction: '' };

export const MARKET_OPTIONS = [{ value: 'linear_perp', label: 'USDT perpetual' }, { value: 'spot', label: 'Spot' }] as const;
export const SIDE_OPTIONS = [{ value: 'buy', label: 'Long / buy' }, { value: 'sell', label: 'Short / sell' }] as const;
export const INTENT_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'close', label: 'Close' },
  { value: 'reduce', label: 'Reduce' },
] as const;
export const ENTRY_OPTIONS = [{ value: 'market', label: 'Market' }, { value: 'limit', label: 'Limit' }] as const;
export const SIZING_OPTIONS: ReadonlyArray<{ value: SizingMode; label: string }> = [
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
export const BASIS_OPTIONS: ReadonlyArray<{ value: BalanceBasis; label: string }> = [
  { value: 'spot_available', label: 'Spot available' },
  { value: 'spot_equity', label: 'Spot equity' },
  { value: 'futures_available', label: 'Futures available' },
  { value: 'futures_equity', label: 'Futures equity' },
  { value: 'total_exchange_equity', label: 'Total exchange equity' },
  { value: 'asset_equity', label: 'Asset equity' },
  { value: 'custom', label: 'Custom' },
];
export const STRATEGY_OPTIONS: ReadonlyArray<{ value: ExecutionStrategy; label: string }> = [
  { value: 'market', label: 'Market' },
  { value: 'limit', label: 'Limit' },
  { value: 'twap', label: 'TWAP' },
  { value: 'adaptive_twap', label: 'Adaptive TWAP' },
  { value: 'iceberg', label: 'Iceberg' },
  { value: 'chase_limit', label: 'Chase limit' },
  { value: 'scale_in', label: 'Scale in' },
  { value: 'scale_out', label: 'Scale out' },
];
export const URGENCY_OPTIONS: ReadonlyArray<{ value: ExecutionUrgency; label: string }> = [
  { value: 'passive', label: 'Passive' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'aggressive', label: 'Aggressive' },
  { value: 'immediate', label: 'Immediate' },
];
export const MARGIN_OPTIONS: ReadonlyArray<{ value: MarginMode | ''; label: string }> = [
  { value: '', label: 'Risk profile default' },
  { value: 'isolated', label: 'Isolated' },
  { value: 'cross', label: 'Cross' },
];
export const RISK_POLICY_OPTIONS = [
  { value: 'resize_then_stop', label: 'Resize then stop' },
  { value: 'pause', label: 'Pause' },
  { value: 'stop', label: 'Stop' },
] as const;
export const POSITION_POLICY_OPTIONS = [
  { value: 'reject', label: 'Reject if a position exists' },
  { value: 'add', label: 'Add to the position' },
] as const;
export const MODE_OPTIONS: ReadonlyArray<{ value: ExecutionMode; label: string }> = [
  { value: 'paper', label: 'Paper (simulated)' },
  { value: 'live', label: 'LIVE (real order)' },
];
export const LEVERAGE_MODE_OPTIONS = [
  { value: 'auto_safe', label: 'Auto safe' },
  { value: 'manual', label: 'Manual' },
] as const;

/** Sizing modes that must name their balance basis (PRD §10). */
export const BASIS_SIZING: ReadonlySet<SizingMode> = new Set<SizingMode>([
  'risk_percent',
  'allocation_percent',
  'target_profit_percent',
]);

/** Risk-based sizing needs a stop; a stop needs a price (§38). */
export const RISK_SIZING: ReadonlySet<SizingMode> = new Set<SizingMode>(['risk_usd', 'risk_percent']);

// ---------------------------------------------------------------------------
// ExecutorComposer — §82, §83, §84, §80
// ---------------------------------------------------------------------------
export function LevelEditor({ title, rows, onChange }: { title: string; rows: LevelRow[]; onChange: (rows: LevelRow[]) => void }) {
  return (
    <div style={{ marginTop: space[8] }}>
      <Label>{title}</Label>
      {rows.map((row, index) => (
        <div key={index} style={{ ...pairStyle, marginBottom: space[8] }}>
          <Input
            value={row.price}
            onChange={(price) => {
              const next = rows.slice();
              next[index] = { ...row, price };
              onChange(next);
            }}
            placeholder="price"
            type="number"
          />
          <div style={{ display: 'flex', gap: space[8] }}>
            <Input
              value={row.fraction}
              onChange={(fraction) => {
                const next = rows.slice();
                next[index] = { ...row, fraction };
                onChange(next);
              }}
              placeholder="fraction 0..1"
              type="number"
            />
            <Button onClick={() => onChange(rows.filter((_, i) => i !== index))} variant="danger" disabled={rows.length === 1}>
              ✕
</Button>
          </div>
        </div>
      ))}
      <Button onClick={() => onChange([...rows, { ...EMPTY_ROW }])}>+ level</Button>
    </div>
  );
}

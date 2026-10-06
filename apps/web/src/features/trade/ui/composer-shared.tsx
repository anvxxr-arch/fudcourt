'use client';
/**
 * composer-shared.tsx — single-source shared constants for the trade composer.
 *
 * Split from composer.tsx; imported by composer.tsx and composer-preview.tsx.
 * Layout styles, the sizing/basis option lists, and the venue-taxonomy helper
 * live here so the entry and section modules cannot drift apart.
 */
import type { CSSProperties } from 'react';
import { color, fontSize, fontWeight, letterSpacing, space } from '@/styles/tokens';
import { VENUE_MARKET_TYPES, type MarketType, type VenueId } from '@/features/trade/model';
import type { BalanceBasis, SizingMode } from '@/lib/executor';

export const pairStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: space[8] };

export const h3Style: CSSProperties = {
  color: color.blue,
  fontSize: fontSize[12],
  fontWeight: fontWeight.bold,
  margin: `0 0 ${space[8]}px`,
  letterSpacing: letterSpacing.sm,
};

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

/** The venues the taxonomy says serve a market type. */
export function VENUES_FOR(marketType: MarketType): readonly VenueId[] {
  return (Object.keys(VENUE_MARKET_TYPES) as VenueId[]).filter((venue) => VENUE_MARKET_TYPES[venue].includes(marketType));
}

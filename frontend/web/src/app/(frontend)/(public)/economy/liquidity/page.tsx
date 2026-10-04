import LiquidityBoard from '@/features/economy/ui/liquidity';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Liquidity — Global plumbing | FUDCOURT',
  description:
    'Central-bank balance sheets, reserves, reverse repo, the dollar and financial conditions, with a derived global liquidity index for risk assets.',
};

/** The liquidity board (plan Phase 9). */
export default function EconomyLiquidityRoute() {
  return <LiquidityBoard />;
}

import RegimeBoard from '@/features/economy/ui/regime';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Macro Regime — Growth, inflation, liquidity, policy | FUDCOURT',
  description:
    'Growth, inflation, labor, liquidity and policy read from published observations and matched against an explicit rule table, with a stated weight table for potential asset impact.',
};

/** The macro regime board (plan Phase 13, stages 16–17). */
export default function EconomyRegimeRoute() {
  return <RegimeBoard />;
}

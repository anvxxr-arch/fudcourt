import type { Metadata } from 'next';
import TradeDashboard from '@/features/trade/ui/dashboard';

export const metadata: Metadata = {
  title: 'Trade — command center | FUDCOURT',
  description:
    'One trading surface across spot, margin, perpetual, futures, options and swap. Market type is what you trade; the venue is only where it executes.',
};

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** The trading domain's front door (plan Phase 6). */
export default function TradePage() {
  return <TradeDashboard />;
}

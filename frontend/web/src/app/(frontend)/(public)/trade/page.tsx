import type { Metadata } from 'next';
import TradeDashboard from '@/features/trade/ui/dashboard';

export const metadata: Metadata = {
  title: 'Trade Hub: Spot, Margin, Perps, Futures & Options | FUDCOURT',
  description:
    'One trading surface across spot, margin, perpetual, futures, options and swap. Market type is what you trade on FudCourt; the venue is only where it executes.',
  alternates: { canonical: '/trade' },
  openGraph: {
    title: 'Trade Hub: Spot, Margin, Perps, Futures & Options | FUDCOURT',
    description: 'One trading surface across every market type and venue. Connect a venue to see balances, positions and risk.',
    url: '/trade',
    siteName: 'FUDCOURT',
    type: 'website',
    images: ['/og-cover.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Trade Hub: Spot, Margin, Perps, Futures & Options | FUDCOURT',
    description: 'One trading surface across every market type and venue. Connect a venue to see balances, positions and risk.',
    images: ['/og-cover.png'],
  },
};

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** The trading domain's front door (plan Phase 6). */
export default function TradePage() {
  return <TradeDashboard />;
}

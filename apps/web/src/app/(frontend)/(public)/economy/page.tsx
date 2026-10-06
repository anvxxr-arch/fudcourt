import type { Metadata } from 'next';
import EconomyDashboard from '@/features/economy/ui/dashboard';

export const metadata: Metadata = {
  title: 'Global Macro Dashboard: Growth, Inflation, Money & Policy',
  description:
    'FudCourt macro dashboard: growth, inflation, labour, money and policy across major economies, read from FRED, the World Bank and BIS into one canonical model.',
  alternates: { canonical: '/economy' },
  openGraph: {
    title: 'Global Macro Dashboard: Growth, Inflation, Money & Policy',
    description: 'Growth, inflation, labour, money and policy across major economies — one canonical macro model from FRED, World Bank and BIS.',
    url: '/economy',
    siteName: 'FUDCOURT',
    type: 'website',
    images: ['/og-cover.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Global Macro Dashboard: Growth, Inflation, Money & Policy',
    description: 'Growth, inflation, labour, money and policy across major economies — one canonical macro model from FRED, World Bank and BIS.',
    images: ['/og-cover.png'],
  },
};

/** The macro module's front door (plan Phase 4). */
export default function EconomyPage() {
  return <EconomyDashboard />;
}

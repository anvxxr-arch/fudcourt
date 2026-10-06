import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Market Hub — Crypto, Forex, Commodities, Stocks & DEX Pairs',
  description:
    'The FudCourt market hub: cross-checked CEX instruments, on-chain DEX pairs, and per-asset-class boards for crypto, forex, commodities and stocks in one place.',
  alternates: { canonical: '/market' },
  openGraph: {
    title: 'Market Hub — Crypto, Forex, Commodities, Stocks & DEX Pairs',
    description: 'Cross-checked CEX instruments, on-chain DEX pairs, and per-asset-class boards for crypto, forex, commodities and stocks.',
    url: '/market',
    siteName: 'FUDCOURT',
    type: 'website',
    images: ['/og-cover.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Market Hub — Crypto, Forex, Commodities, Stocks & DEX Pairs',
    description: 'Cross-checked CEX instruments, on-chain DEX pairs, and per-asset-class boards for crypto, forex, commodities and stocks.',
    images: ['/og-cover.png'],
  },
};

export default function MarketRoute() {
  return <StoreShell initialPage="market" />;
}

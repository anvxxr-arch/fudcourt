import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

const TITLE = 'Whale Positions & Positioning | FUDCOURT';
const DESCRIPTION =
  'The largest open positions on Hyperliquid, read from coinank: notional, leverage, entry and liquidation price per position, the long/short split and the per-coin grouping. The board states how many of the upstream total it sees.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/whales' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/whales', siteName: 'FUDCOURT', type: 'website', images: ['/og-cover.png'] },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og-cover.png'] },
};
export const revalidate = 0;

export default function WhalesRoute() {
  return <StoreShell initialPage="whales" />;
}

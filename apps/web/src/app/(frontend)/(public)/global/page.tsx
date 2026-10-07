import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

const TITLE = 'Global — Market cap, dominance & venue ranking | FUDCOURT';
const DESCRIPTION =
  'The whole-market read: total market cap and 24h volume, BTC and ETH dominance with their daily change, DeFi, stablecoin and derivatives segment volumes, the gas oracle, and the venue ranking by reported volume and market share.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/global' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/global', siteName: 'FUDCOURT', type: 'website', images: ['/og-cover.png'] },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og-cover.png'] },
};
export const revalidate = 0;

export default function GlobalRoute() {
  return <StoreShell initialPage="global" />;
}

import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

const TITLE = 'Coin Directory — Listings, Drill-down & Market Pairs | FUDCOURT';
const DESCRIPTION =
  'The ranked all-coins directory, the recently-added / most-searched / most-visited widgets, and a per-coin drill down into CoinMarketCap market pairs and CoinGlass open interest. A metric the upstream did not publish renders —, never 0.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/coins' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/coins', siteName: 'FUDCOURT', type: 'website', images: ['/og-cover.png'] },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og-cover.png'] },
};
export const revalidate = 0;

export default function CoinsRoute() {
  return <StoreShell initialPage="coins" />;
}

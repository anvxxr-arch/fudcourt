import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

const TITLE = 'Screener — the Full Crypto Price List | FUDCOURT';
const DESCRIPTION =
  'The full CryptoRank price list — every coin with a live price, the widest dataset in the app (the coin directory sees only the top 100). Filter by name or symbol, sort by price and page client-side; a price the upstream did not publish renders —, never 0.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/screener' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/screener', siteName: 'FUDCOURT', type: 'website', images: ['/og-cover.png'] },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og-cover.png'] },
};
export const revalidate = 0;

export default function ScreenerRoute() {
  return <StoreShell initialPage="screener" />;
}

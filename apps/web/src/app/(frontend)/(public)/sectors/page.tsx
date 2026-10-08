import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

const TITLE = 'Sector & Tag Taxonomy — Themes, Breadth & Coins | FUDCOURT';
const DESCRIPTION =
  'CryptoRank\u2019s topic taxonomy: 183 tags by market cap with dominance and gainers/losers breadth, and a keyed detail that loads one tag\u2019s coins. Every board states its slice, a metric the upstream did not publish renders \u2014, and an absent change column is named rather than printed as 0.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/sectors' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/sectors', siteName: 'FUDCOURT', type: 'website', images: ['/og-cover.png'] },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og-cover.png'] },
};
export const revalidate = 0;

export default function SectorsRoute() {
  return <StoreShell initialPage="sectors" />;
}

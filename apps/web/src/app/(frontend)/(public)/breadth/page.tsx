import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

const TITLE = 'Crypto Breadth — RWA, Launches, Sectors & Venues | FUDCOURT';
const DESCRIPTION =
  'Tokenized real-world assets, launchpool and node-sale calendars, sector rotation and the exchange ranking. Every board states its slice, a metric the upstream did not publish renders —, and an absent change column is named rather than printed as 0.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/breadth' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/breadth', siteName: 'FUDCOURT', type: 'website', images: ['/og-cover.png'] },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og-cover.png'] },
};
export const revalidate = 0;

export default function BreadthRoute() {
  return <StoreShell initialPage="breadth" />;
}

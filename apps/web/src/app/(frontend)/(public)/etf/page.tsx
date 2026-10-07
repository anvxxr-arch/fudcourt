import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

const TITLE = 'Spot-ETF flows — Daily creations & redemptions | FUDCOURT';
const DESCRIPTION =
  'Spot-Bitcoin ETF flows per issuer per day: net creations and redemptions in USD and BTC, a cumulative series and per-issuer totals. Rows the upstream ships without a ticker are grouped as unlabelled — never given a fabricated name.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/etf' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/etf', siteName: 'FUDCOURT', type: 'website', images: ['/og-cover.png'] },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og-cover.png'] },
};
export const revalidate = 0;

export default function EtfRoute() {
  return <StoreShell initialPage="etf" />;
}

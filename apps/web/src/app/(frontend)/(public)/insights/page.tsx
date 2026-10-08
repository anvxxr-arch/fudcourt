import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

const TITLE = 'Insights — Quarterly Returns & AI Market Overview | FUDCOURT';
const DESCRIPTION =
  'BTC and ETH quarterly returns — computed here from CryptoRank open/close prices and labelled as computed, with running quarters marked in progress — beside CryptoRank’s own AI market digest: its summary, news, funding and drop-hunting / vesting sections, quoted and attributed.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/insights' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/insights', siteName: 'FUDCOURT', type: 'website', images: ['/og-cover.png'] },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og-cover.png'] },
};
export const revalidate = 0;

export default function InsightsRoute() {
  return <StoreShell initialPage="insights" />;
}

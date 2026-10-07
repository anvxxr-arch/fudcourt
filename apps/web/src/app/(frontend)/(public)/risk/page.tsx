import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

const TITLE = 'Prediction Markets & Event Risk | FUDCOURT';
const DESCRIPTION =
  'Prediction-market pricing joined with the headlines being reported. Every probability is the mid of a two-sided book, a thin book is marked wide, and no headline is claimed to have moved a price.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/risk' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/risk', siteName: 'FUDCOURT', type: 'website', images: ['/og-cover.png'] },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og-cover.png'] },
};
export const revalidate = 0;

export default function RiskRoute() {
  return <StoreShell initialPage="risk" />;
}

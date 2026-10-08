import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

const TITLE = 'Funding rates — Per-symbol venue matrix | FUDCOURT';
const DESCRIPTION =
  'The per-symbol funding-rate matrix: 885 symbols, each with its USDT-margined and COIN-margined venue rates. Every rate is a fraction rendered ×100; a missing venue is a dash, never a zero.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/funding' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/funding', siteName: 'FUDCOURT', type: 'website', images: ['/og-cover.png'] },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og-cover.png'] },
};
export const revalidate = 0;

export default function FundingRoute() {
  return <StoreShell initialPage="funding" />;
}

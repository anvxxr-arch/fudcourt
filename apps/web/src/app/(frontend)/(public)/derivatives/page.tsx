import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

const TITLE = 'Derivatives — Open interest, funding & liquidations | FUDCOURT';
const DESCRIPTION =
  'The futures tape: open interest and its change, funding-rate extremes, per-venue liquidations across six intervals, and the long/short ratio. Every field is read verbatim from the venue aggregates; a missing venue is a dash, never a zero.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/derivatives' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/derivatives', siteName: 'FUDCOURT', type: 'website', images: ['/og-cover.png'] },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og-cover.png'] },
};
export const revalidate = 0;

export default function DerivativesRoute() {
  return <StoreShell initialPage="derivatives" />;
}

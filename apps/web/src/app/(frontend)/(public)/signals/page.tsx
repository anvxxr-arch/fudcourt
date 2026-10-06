import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Signal Screening Over a 168h Window | FUDCOURT',
  description: 'Read-only screening output over a 168h window: parity-checked market reads. Not trading signals, not financial advice.',
  alternates: { canonical: '/signals' },
  openGraph: { title: 'Signal Screening Over a 168h Window | FUDCOURT', description: 'Read-only screening output over a 168h window: parity-checked market reads. Not trading signals, not financial advice.', url: '/signals', siteName: 'FUDCOURT', type: 'website', images: ['/og-cover.png'] },
  twitter: { card: 'summary_large_image', title: 'Signal Screening Over a 168h Window | FUDCOURT', description: 'Read-only screening output over a 168h window: parity-checked market reads. Not trading signals, not financial advice.', images: ['/og-cover.png'] },
};
export const revalidate = 0;

export default function SignalsRoute() {
  return <StoreShell initialPage="signals" />;
}

import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Crypto Market News for Treasury & Trading | FUDCOURT',
  description: 'Crypto market news aggregated for treasury and trading decisions. Gated feeds, no fabricated items, freshest first.',
  alternates: { canonical: '/news' },
  openGraph: { title: 'Crypto Market News for Treasury & Trading | FUDCOURT', description: 'Crypto market news aggregated for treasury and trading decisions. Gated feeds, no fabricated items, freshest first.', url: '/news', siteName: 'FUDCOURT', type: 'website', images: ['/og-cover.png'] },
  twitter: { card: 'summary_large_image', title: 'Crypto Market News for Treasury & Trading | FUDCOURT', description: 'Crypto market news aggregated for treasury and trading decisions. Gated feeds, no fabricated items, freshest first.', images: ['/og-cover.png'] },
};
export const revalidate = 0;

export default function NewsRoute() {
  return <StoreShell initialPage="news" />;
}

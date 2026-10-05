import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Trader & Wallet Scoreboard, Ranked Real | FUDCOURT',
  description: 'Tracked traders and wallets ranked by realized performance. Verified fills only — no paper claims, no vanity ranks.',
  alternates: { canonical: '/scoreboard' },
  openGraph: { title: 'Trader & Wallet Scoreboard, Ranked Real | FUDCOURT', description: 'Tracked traders and wallets ranked by realized performance. Verified fills only — no paper claims, no vanity ranks.', url: '/scoreboard', siteName: 'FUDCOURT', type: 'website', images: ['/og-cover.png'] },
  twitter: { card: 'summary_large_image', title: 'Trader & Wallet Scoreboard, Ranked Real | FUDCOURT', description: 'Tracked traders and wallets ranked by realized performance. Verified fills only — no paper claims, no vanity ranks.', images: ['/og-cover.png'] },
};
export const revalidate = 0;

export default function ScoreboardRoute() {
  return <StoreShell initialPage="scoreboard" />;
}

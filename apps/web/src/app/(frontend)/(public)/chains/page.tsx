import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

const TITLE = 'Chain & Ecosystem Directory — Chains, Cap & Ecosystem TVL | FUDCOURT';
const DESCRIPTION =
  'The chain directory with each network and its explorer, the ecosystem index with projects, market cap and TVL, and a keyed per-chain detail of its ecosystem tokens. Every board states its slice, a metric the upstream did not publish renders —, and the detail names its absent change column rather than printing 0.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/chains' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/chains', siteName: 'FUDCOURT', type: 'website', images: ['/og-cover.png'] },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og-cover.png'] },
};
export const revalidate = 0;

export default function ChainsRoute() {
  return <StoreShell initialPage="chains" />;
}

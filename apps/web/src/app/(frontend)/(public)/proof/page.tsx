import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

const TITLE = 'Proof of treasury — the public commitment | FUDCOURT';
const DESCRIPTION =
  'The treasury\u2019s public commitment: a total, a per-chain breakdown and a SHA-256 digest over the full snapshot. Only aggregates are published — the holdings behind the digest stay private and can be revealed later.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/proof' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/proof', siteName: 'FUDCOURT', type: 'website', images: ['/og-cover.png'] },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og-cover.png'] },
};
export const revalidate = 0;

export default function ProofRoute() {
  return <StoreShell initialPage="proof" />;
}

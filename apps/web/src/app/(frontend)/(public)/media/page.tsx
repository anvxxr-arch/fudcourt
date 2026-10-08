import StoreShell from '@/features/overview/store-shell';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

const TITLE = 'Crypto Media & News by Tag — Video Feed & Wire | FUDCOURT';
const DESCRIPTION =
  'CryptoRank’s own media feed and news wire, plus a tag reader: a 10-of-479 video slice, a news table where a null date is a pinned promo slot kept and dated —, and a per-tag board whose unknown slugs surface as 404s, never an unfiltered feed.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/media' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/media', siteName: 'FUDCOURT', type: 'website', images: ['/og-cover.png'] },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og-cover.png'] },
};
export const revalidate = 0;

export default function MediaRoute() {
  return <StoreShell initialPage="media" />;
}

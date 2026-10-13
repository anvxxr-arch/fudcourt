import HomePage from '@/features/home/ui';
import { getSession, hasTier } from '@/server/auth';
import type { Metadata } from 'next';
// Home stays REQUEST-TIME, unlike every other public board (revalidate = 300).
// Its render reads `cookies()` via `getSession()` to choose the landing call to
// action — `/team/balance` for a team visitor, `/login` otherwise — and Next
// spells that `no-store`: a page whose render touches request state can never be
// a cached shell. The rendered page and the served header agree by construction.
// (Moving just that CTA to the client would free the page, but it is out of
// scope here; the honest static/dynamic split is the point of this pass.)
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'FUDCOURT — Verified Crypto Market Boards & Treasury Terminal',
  description:
    'FUDCOURT: verified crypto market boards for everyone, a cross-chain treasury terminal for teams, and an admin panel for managers. Live figures, never guessed.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'FUDCOURT — Verified Crypto Market Boards & Treasury Terminal',
    description:
      'Verified market boards, a cross-chain treasury terminal, and an admin panel. Live figures, never guessed.',
    url: '/',
    siteName: 'FUDCOURT',
    type: 'website',
    images: ['/og-cover.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FUDCOURT — Verified Crypto Market Boards & Treasury Terminal',
    description:
      'Verified market boards, a cross-chain treasury terminal, and an admin panel. Live figures, never guessed.',
    images: ['/og-cover.png'],
  },
};

// The landing page: the product's front door, read-only.
//
// The session is read server-side only to pick the second call to action — a
// team visitor gets a link into the treasury terminal, everyone else a sign-in
// link. No treasury data is fetched or rendered here: an anonymous visitor sees
// the public market overview and boards only, and the treasury API bundle
// (/api/all, /api/wallets, /api/coins, /api/reconcile) is never requested.
export default async function RootPage() {
  const user = await getSession();
  return <HomePage isTeam={hasTier(user, 'team')} />;
}

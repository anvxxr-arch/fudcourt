import HomePage from '@/features/home/ui';
import { getSession } from '@/platform/auth/session';
import { hasTier } from '@/platform/auth/guard';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'FUDCOURT — Community, terminal, and management',
  description:
    'FUDCOURT is community, terminal, and management: verified market intelligence boards for everyone, a cross-chain treasury terminal for the team, and an admin control panel for management.',
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

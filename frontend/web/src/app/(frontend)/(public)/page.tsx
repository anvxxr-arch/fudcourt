import StoreShell from '@/components/layout/store-shell';
import { getSession } from '@/platform/auth/session';
import { hasTier } from '@/platform/auth/guard';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Public landing page: market boards only, never the treasury dashboard.
// The session is read server-side so the shell knows whether this visitor
// may see treasury tabs; anonymous visitors get boards only (isTeam=false),
// which means no wallet addresses, transaction rows, or reconciliation rows
// are ever rendered — and the treasury API bundle is never even fetched.
export default async function RootPage() {
  const user = await getSession();
  return <StoreShell initialPage="ticker" isTeam={hasTier(user, 'team')} />;
}

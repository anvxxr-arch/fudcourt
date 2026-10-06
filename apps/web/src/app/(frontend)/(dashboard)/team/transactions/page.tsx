import StoreShell from '@/features/overview/store-shell';
import { requireTier } from '@/server/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function TeamTransactionsPage() {
  await requireTier('team');
  return <StoreShell initialPage="transactions" isTeam />;
}

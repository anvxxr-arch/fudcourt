import StoreShell from '@/components/layout/store-shell';
import { requireTier } from '@/platform/auth/guard';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function TeamReconciliationPage() {
  await requireTier('team');
  return <StoreShell initialPage="reconciliation" isTeam />;
}

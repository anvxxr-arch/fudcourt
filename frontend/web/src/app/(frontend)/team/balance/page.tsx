import StoreShell from '@/shell/store-shell';
import { requireTier } from '@/platform/auth/guard';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function TeamBalancePage() {
  await requireTier('team');
  return <StoreShell initialPage="dashboard" isTeam />;
}

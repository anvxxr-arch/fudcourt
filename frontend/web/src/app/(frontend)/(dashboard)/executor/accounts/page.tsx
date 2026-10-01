import { requireTier } from '@/platform/auth/guard';
import { ExecutorAccounts, ExecutorFrame } from '@/features/executor/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** `/executor/accounts` — BYOK connect, health, permissions and revocation (§87). */
export default async function ExecutorAccountsPage() {
  await requireTier('team');
  return (
    <ExecutorFrame title="EXCHANGE ACCOUNTS" subtitle="your own keys, sealed server-side; withdrawal permission is refused">
      <ExecutorAccounts />
    </ExecutorFrame>
  );
}

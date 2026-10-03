import { requireTier } from '@/platform/auth/guard';
import { ExecutorFrame, ExecutorHistory } from '@/features/executor/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** `/executor/history` — the same execution list the area lands on (§81, §22). */
export default async function ExecutorHistoryPage() {
  await requireTier('team');
  return (
    <ExecutorFrame title="HISTORY" subtitle="every execution this account has recorded, filterable by lifecycle state">
      <ExecutorHistory />
    </ExecutorFrame>
  );
}

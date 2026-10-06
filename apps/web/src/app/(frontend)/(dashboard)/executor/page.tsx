import { requireTier } from '@/server/auth';
import { ExecutorFrame, ExecutorOverview } from '@/features/executor/ui';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
/** `/executor` — the area's landing page: status counts and the most recent executions. */
export default async function ExecutorIndexPage() {
  await requireTier('team');
  return (
    <ExecutorFrame title="EXECUTIONS" subtitle="status counts and the most recent runs — full table at /executor/history">
      <ExecutorOverview />
    </ExecutorFrame>
  );
}

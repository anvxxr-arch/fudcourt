import { requireTier } from '@/server/auth';
import { ExecutorFrame, ExecutorHistory } from '@/features/executor/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** `/executor` — the area's landing page: the execution history (§81, §22). */
export default async function ExecutorIndexPage() {
  await requireTier('team');
  return (
    <ExecutorFrame title="EXECUTIONS" subtitle="everything this account has run, and what each one is doing now">
      <ExecutorHistory />
    </ExecutorFrame>
  );
}

import { requireTier } from '@/platform/auth/guard';
import { ExecutorFrame, ExecutorProgress } from '@/features/executor/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** `/executor/:id` — one execution: progress, child orders, fills, log (§85, §86). */
export default async function ExecutorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireTier('team');
  const { id } = await params;
  return (
    <ExecutorFrame title="EXECUTION" subtitle="progress, planned risk and every order this execution placed">
      <ExecutorProgress executionId={id} />
    </ExecutorFrame>
  );
}

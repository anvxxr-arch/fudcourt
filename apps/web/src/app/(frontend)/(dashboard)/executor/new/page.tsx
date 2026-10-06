import { requireTier } from '@/server/auth';
import { ExecutorComposer, ExecutorFrame } from '@/features/executor/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** `/executor/new` — the trade composer and its live risk preview (§82, §83, §84). */
export default async function ExecutorNewPage() {
  await requireTier('team');
  return (
    <ExecutorFrame title="NEW EXECUTION" subtitle="size the trade by risk, preview it, then create it — nothing is sent without you">
      <ExecutorComposer />
    </ExecutorFrame>
  );
}

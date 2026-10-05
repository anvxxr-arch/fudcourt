import { requireTier } from '@/server/auth';
import { ExecutorFrame, ExecutorSettings } from '@/features/executor/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** `/executor/settings` — the risk profile every new execution is validated against (§88). */
export default async function ExecutorSettingsPage() {
  await requireTier('team');
  return (
    <ExecutorFrame title="RISK SETTINGS" subtitle="global risk defaults; per-account overrides come later (PRD §88)">
      <ExecutorSettings />
    </ExecutorFrame>
  );
}

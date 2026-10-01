import { NextResponse } from 'next/server';
import { store } from '@/platform/executor/store';
import { lifecycle, requireExecutorUser } from '@/platform/executor/runtime';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/executor/executions/:id/cancel (PRD §97, §128.20).
 *
 * Cancels the execution and its managed child orders. It never closes the
 * position by itself (§75) — closing is a separate, explicit user action.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireExecutorUser();
  if (auth.denied) return auth.denied;
  const { id } = await params;
  const result = await lifecycle(store, auth.user, id, 'cancel');
  return 'status' in result ? result : NextResponse.json(result);
}

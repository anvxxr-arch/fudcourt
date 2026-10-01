import { NextResponse } from 'next/server';
import { store } from '@/platform/executor/store';
import { lifecycle, requireExecutorUser } from '@/platform/executor/runtime';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** POST /api/executor/executions/:id/pause (PRD §97, §128.19). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireExecutorUser();
  if (auth.denied) return auth.denied;
  const { id } = await params;
  const result = await lifecycle(store, auth.user, id, 'pause');
  return 'status' in result ? result : NextResponse.json(result);
}

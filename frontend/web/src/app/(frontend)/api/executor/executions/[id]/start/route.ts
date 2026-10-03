import { NextResponse } from 'next/server';
import { executorProxyEnabled, proxyExecutorRequest } from '@/platform/executor/executor-proxy';
import { store } from '@/platform/executor/store';
import { lifecycle, requireExecutorUser } from '@/platform/executor/runtime';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** POST /api/executor/executions/:id/start (PRD §97). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (executorProxyEnabled()) return proxyExecutorRequest(req);
  const auth = await requireExecutorUser();
  if (auth.denied) return auth.denied;
  const { id } = await params;
  const result = await lifecycle(store, auth.user, id, 'start');
  return 'status' in result ? result : NextResponse.json(result);
}

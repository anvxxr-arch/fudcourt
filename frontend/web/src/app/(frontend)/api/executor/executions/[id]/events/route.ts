import { NextResponse } from 'next/server';
import { executorProxyEnabled, proxyExecutorRequest } from '@/platform/executor/executor-proxy';
import { store } from '@/platform/executor/store';
import { notFound, requireExecutorUser } from '@/platform/executor/runtime';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/executor/executions/:id/events — immutable event log (PRD §63, §97). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (executorProxyEnabled()) return proxyExecutorRequest(req);
  const auth = await requireExecutorUser();
  if (auth.denied) return auth.denied;
  const { id } = await params;
  const execution = await store.getExecution(auth.user.id, id);
  if (!execution) return notFound('execution');
  return NextResponse.json({ events: await store.listEvents(execution.id) });
}

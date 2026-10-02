import { NextResponse } from 'next/server';
import { executorProxyEnabled, proxyExecutorRequest } from '@/platform/executor/executor-proxy';
import { store } from '@/platform/executor/store';
import { notFound, requireExecutorUser } from '@/platform/executor/runtime';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/executor/executions/:id — execution + its immutable plan (PRD §97). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (executorProxyEnabled()) return proxyExecutorRequest(req);
  const auth = await requireExecutorUser();
  if (auth.denied) return auth.denied;
  const { id } = await params;
  const execution = await store.getExecution(auth.user.id, id);
  if (!execution) return notFound('execution');
  const plan = await store.getExecutionPlan(execution.id);
  return NextResponse.json({ execution, plan });
}

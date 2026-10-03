import { NextResponse } from 'next/server';
import { executorProxyEnabled, proxyExecutorRequest } from '@/platform/executor/executor-proxy';
import { store } from '@/platform/executor/store';
import { createExecution, requireExecutorUser } from '@/platform/executor/runtime';
import type { ExecutionRequest, ExecutionStatus } from '@/platform/executor/types';
import { EXECUTION_TRANSITIONS } from '@/platform/executor/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/executor/executions?status= — the session user's execution history (PRD §97, §128.22). */
export async function GET(req: Request) {
  if (executorProxyEnabled()) return proxyExecutorRequest(req);
  const auth = await requireExecutorUser();
  if (auth.denied) return auth.denied;
  const status = new URL(req.url).searchParams.get('status');
  if (status !== null && !(status in EXECUTION_TRANSITIONS)) {
    return NextResponse.json(
      { error: 'status', detail: `unknown execution status '${status}'` },
      { status: 400 },
    );
  }
  const executions = await store.listExecutions(auth.user.id, {
    status: status === null ? undefined : (status as ExecutionStatus),
    limit: 200,
  });
  return NextResponse.json({ executions });
}

/** POST /api/executor/executions — create with an immutable input snapshot (PRD §99). */
export async function POST(req: Request) {
  if (executorProxyEnabled()) return proxyExecutorRequest(req);
  const auth = await requireExecutorUser();
  if (auth.denied) return auth.denied;
  let body: ExecutionRequest;
  try {
    body = (await req.json()) as ExecutionRequest;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const result = await createExecution(store, auth.user, body);
  return 'status' in result ? result : NextResponse.json(result);
}

import { NextResponse } from 'next/server';
import { executorProxyEnabled, proxyExecutorRequest } from '@/platform/executor/executor-proxy';
import { store } from '@/platform/executor/store';
import { requireExecutorUser, testAccount } from '@/platform/executor/runtime';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** POST /api/executor/accounts/:id/test — live credential validation (PRD §46). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (executorProxyEnabled()) return proxyExecutorRequest(req);
  const auth = await requireExecutorUser();
  if (auth.denied) return auth.denied;
  const { id } = await params;
  const result = await testAccount(store, auth.user, id);
  return 'status' in result ? result : NextResponse.json(result);
}

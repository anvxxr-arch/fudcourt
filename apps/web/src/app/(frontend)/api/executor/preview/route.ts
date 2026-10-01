import { NextResponse } from 'next/server';
import { store } from '@/platform/executor/store';
import { previewExecution, requireExecutorUser } from '@/platform/executor/runtime';
import type { ExecutionRequest } from '@/platform/executor/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/executor/preview — dry run only (PRD §98): nothing is created and
 * no external order is ever placed on this path.
 */
export async function POST(req: Request) {
  const auth = await requireExecutorUser();
  if (auth.denied) return auth.denied;
  let body: ExecutionRequest;
  try {
    body = (await req.json()) as ExecutionRequest;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const result = await previewExecution(store, auth.user, body);
  return 'status' in result ? result : NextResponse.json(result);
}

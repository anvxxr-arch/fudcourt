import { NextResponse } from 'next/server';
import { store } from '@/platform/executor/store';
import { requireExecutorUser, runEmergencyStop } from '@/platform/executor/runtime';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/executor/emergency — Emergency Stop (PRD §75): stop all managed
 * strategies and cancel managed open orders. Positions are NEVER closed here;
 * that stays a separate explicit action.
 */
export async function POST(req: Request) {
  const auth = await requireExecutorUser();
  if (auth.denied) return auth.denied;
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // An empty body means "everything I own" — the valid §75 scope.
  }
  const result = await runEmergencyStop(store, auth.user, { accountId: body.accountId });
  return 'status' in result ? result : NextResponse.json(result);
}

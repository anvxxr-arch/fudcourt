import { NextRequest, NextResponse } from 'next/server';
import { fail, failInternal } from '../_lib/http';
import { listPlans } from '@/server/plans';

/**
 * GET /api/plans — the paper-plan ledger recorded by `signal-pipeline.py`
 * (DR-050), newest first.
 *
 *   ?limit=N   cap the slice (default 500, max 2000)
 *
 * Read-only. The table's writer is the `fudcourt-signals.timer` oneshot, never
 * this route, so a GET can never mutate a plan.
 *
 * Tier: `team`. `/api/plans` is listed in `@/server/auth`'s TEAM_API_ROUTES, so
 * the middleware answers 401 before this handler runs — the rows carry the
 * account's own equity and risk figures, the same private ledger the treasury
 * routes gate.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest): Promise<Response> {
  const raw = req.nextUrl.searchParams.get('limit');
  let limit = 500;
  if (raw !== null && raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      return fail('bad limit', 400, `limit must be a positive integer, got ${JSON.stringify(raw)}`);
    }
    limit = n;
  }

  try {
    return NextResponse.json(await listPlans(limit));
  } catch (e: unknown) {
    return failInternal(e);
  }
}

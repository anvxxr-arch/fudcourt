import { NextRequest, NextResponse } from 'next/server';
import { fail, failInternal } from '../_lib/http';
import { flows, journalEntries, trialBalance } from '@/server/journal';

/**
 * GET /api/journal — the derived double-entry journal (see `@/server/journal`,
 * DR-047).
 *
 *   ?mode=entries [&limit=N]   the entries, newest first (default)
 *   ?mode=trial                the trial balance (debits = credits)
 *   ?mode=flows                operating / external / internal flows
 *
 * Read-only, and derived on every call from `transactions` — the `journal`
 * table has no writer by design (DR-036/DR-037), so this route never mutates.
 *
 * Tier: `team`. `/api/journal` is listed in `@/server/auth`'s TEAM_API_ROUTES, so
 * the middleware answers 401 before this handler runs; the reads expose the same
 * private ledger the treasury routes gate.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MODES = ['entries', 'trial', 'flows'] as const;
type Mode = (typeof MODES)[number];

export async function GET(req: NextRequest): Promise<Response> {
  const p = req.nextUrl.searchParams;

  const modeRaw = p.get('mode') ?? 'entries';
  if (!(MODES as readonly string[]).includes(modeRaw)) {
    return fail('unknown mode', 400, `${JSON.stringify(modeRaw)} is not one of ${MODES.join('|')}`);
  }
  const mode = modeRaw as Mode;

  const limitRaw = p.get('limit');
  let limit: number | undefined;
  if (limitRaw !== null && limitRaw !== '') {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n <= 0) {
      return fail('bad limit', 400, `limit must be a positive integer, got ${JSON.stringify(limitRaw)}`);
    }
    limit = n;
  }

  try {
    switch (mode) {
      case 'trial':
        return NextResponse.json(await trialBalance());
      case 'flows':
        return NextResponse.json(await flows());
      case 'entries':
      default:
        return NextResponse.json({ entries: await journalEntries(limit) });
    }
  } catch (e: unknown) {
    return failInternal(e);
  }
}

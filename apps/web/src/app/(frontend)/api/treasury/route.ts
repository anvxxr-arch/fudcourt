import { NextRequest, NextResponse } from 'next/server';
import { fail, failInternal } from '../_lib/http';
import {
  parseBucket,
  parseGroup,
  parseRange,
  treasuryAnalytics,
  treasuryBreakdown,
  treasuryDiff,
  treasuryHistory,
} from '@/server/treasury';

/**
 * GET /api/treasury — the treasury time-series read surface.
 *
 * One route, four modes over `asset_history` (see `@/server/treasury`):
 *
 *   ?mode=history   &group=total|chain|wallet|asset &range=… &bucket=…  bucketed series
 *   ?mode=analytics &range=…                                            ATH/drawdown/vol/change
 *   ?mode=breakdown &dimension=chain|wallet|asset &range=…              per-dimension deltas
 *   ?mode=diff      &range=…                                            what moved + why
 *
 * `mode` defaults to `history`, `range` to `7d`. Every supplied-but-unknown
 * value is a 400, never a silent fallback: a caller that typos `range=7days`
 * gets told so rather than quietly receiving a 7d answer it did not ask for
 * (the house rule — never clamp, never fake).
 *
 * Tier: `team`. `/api/treasury` is listed in `@/server/auth`'s TEAM_API_ROUTES,
 * so the middleware answers 401 before this handler runs; the reads are the
 * same private treasury data `/api/all` and `/api/coins` already gate.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MODES = ['history', 'analytics', 'breakdown', 'diff'] as const;
type Mode = (typeof MODES)[number];

const DIMENSIONS = ['chain', 'wallet', 'asset'] as const;
type Dimension = (typeof DIMENSIONS)[number];

export async function GET(req: NextRequest): Promise<Response> {
  const p = req.nextUrl.searchParams;

  const modeRaw = p.get('mode') ?? 'history';
  if (!(MODES as readonly string[]).includes(modeRaw)) {
    return fail('unknown mode', 400, `${JSON.stringify(modeRaw)} is not one of ${MODES.join('|')}`);
  }
  const mode = modeRaw as Mode;

  const range = parseRange(p.get('range'));
  if (range === null) {
    return fail('unknown range', 400, `${JSON.stringify(p.get('range'))} is not one of 24h|7d|30d|90d`);
  }

  try {
    switch (mode) {
      case 'analytics':
        return NextResponse.json(await treasuryAnalytics(range));

      case 'breakdown': {
        const dim = p.get('dimension') ?? 'chain';
        if (!(DIMENSIONS as readonly string[]).includes(dim)) {
          return fail('unknown dimension', 400, `${JSON.stringify(dim)} is not one of ${DIMENSIONS.join('|')}`);
        }
        return NextResponse.json(await treasuryBreakdown(dim as Dimension, range));
      }

      case 'diff':
        return NextResponse.json(await treasuryDiff(range));

      case 'history': {
        const group = parseGroup(p.get('group'));
        if (group === null) {
          return fail('unknown group', 400, `${JSON.stringify(p.get('group'))} is not one of total|chain|wallet|asset`);
        }
        const bucket = parseBucket(p.get('bucket'));
        if (bucket === null) {
          return fail('unknown bucket', 400, `${JSON.stringify(p.get('bucket'))} is not one of 5m|15m|1h|6h|1d`);
        }
        return NextResponse.json(await treasuryHistory(group, range, bucket));
      }
    }
  } catch (e: unknown) {
    return failInternal(e);
  }
}

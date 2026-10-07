import { NextRequest, NextResponse } from 'next/server';
import { fail, failInternal } from '../_lib/http';
import { pnlSummary, priceCoverage, priceSeries } from '@/server/pnl';

/**
 * GET /api/pnl — cost basis, realized/unrealized P&L, and the implied price
 * series (see `@/server/pnl`, DR-046).
 *
 *   ?mode=summary                  per-(chain,asset) FIFO basis + P&L (default)
 *   ?mode=coverage                 which symbols have a materialized price series
 *   ?mode=prices &symbol=ETH       the implied price series for one symbol
 *
 * Read-only. The price materialization itself is a separate, idempotent write
 * (`backfillImpliedPrices`) run by the operator/schedule, not by this handler —
 * a GET must never mutate.
 *
 * Tier: `team`. `/api/pnl` is listed in `@/server/auth`'s TEAM_API_ROUTES, so the
 * middleware answers 401 before this handler runs; the reads expose the same
 * private ledger the treasury routes gate.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MODES = ['summary', 'coverage', 'prices'] as const;
type Mode = (typeof MODES)[number];

export async function GET(req: NextRequest): Promise<Response> {
  const p = req.nextUrl.searchParams;

  const modeRaw = p.get('mode') ?? 'summary';
  if (!(MODES as readonly string[]).includes(modeRaw)) {
    return fail('unknown mode', 400, `${JSON.stringify(modeRaw)} is not one of ${MODES.join('|')}`);
  }
  const mode = modeRaw as Mode;

  try {
    switch (mode) {
      case 'coverage':
        return NextResponse.json({ rows: await priceCoverage() });

      case 'prices': {
        const symbol = p.get('symbol');
        if (symbol === null || symbol === '') {
          return fail('missing symbol', 400, 'mode=prices requires a non-empty &symbol=');
        }
        const source = p.get('source') ?? 'implied';
        return NextResponse.json(await priceSeries(symbol, source));
      }

      case 'summary':
      default:
        return NextResponse.json(await pnlSummary());
    }
  } catch (e: unknown) {
    return failInternal(e);
  }
}

import { NextResponse } from 'next/server';
import { query } from '@/server/db';
import { exposureOverlay, EXPOSURE_RULE } from '@/features/economy/model';
import type { HoldingInput } from '@/features/economy/model';
import { readRegime } from '../_lib/regime';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/**
 * The macro regime, joined with the treasury's own exposure to it
 * (plan Phase 13, stages 16–17).
 *
 * WHY THIS IS A SEPARATE ROUTE FROM /api/economy/regime. The regime board is
 * public: it describes asset CLASSES. This route adds the treasury's holdings,
 * which are private, so it is gated at the team tier (`server/auth.ts`,
 * TEAM_API_ROUTES). Keeping the private join out of the public route is the
 * whole reason it exists rather than being a field on the regime payload.
 *
 * The regime half is read by `../_lib/regime.ts` — the SAME module the public
 * route uses — so the two boards cannot disagree about the regime.
 *
 * A FAILED PORTFOLIO READ IS A VISIBLE PARTIAL READ, NOT AN EMPTY TABLE. The
 * regime half is still served, `exposure` is null, and `failed[]` names the read
 * that threw. That is the economy module's own envelope contract; the board
 * renders a loud error for the section rather than a zero.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get('country');
  const read = await readRegime(raw);
  if (!read.ok) return NextResponse.json(read.body, { status: read.status });

  const failed = [...read.payload.failed];
  let exposure = null;

  try {
    const rows = (await query(
      `SELECT asset, SUM(value_usd) AS value_usd
         FROM assets
        GROUP BY asset
        ORDER BY asset`
    )) as { asset: unknown; value_usd: unknown }[];

    const holdings: HoldingInput[] = rows.map((r) => ({
      asset: String(r.asset),
      // A missing/NaN value stays NULL: the overlay treats it as "unknown", not
      // as zero, and refuses to state a book total it cannot compute.
      value_usd:
        r.value_usd === null || r.value_usd === undefined || Number.isNaN(Number(r.value_usd))
          ? null
          : Number(r.value_usd),
    }));

    exposure = exposureOverlay(holdings, read.payload.impacts);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    failed.push({ symbol: 'postgres:assets', reason });
  }

  return NextResponse.json({
    ...read.payload,
    failed,
    exposure,
    derived:
      read.payload.derived +
      '; the exposure overlay joins those class stances with the treasury\u2019s own holdings ' +
      '(the sum of value_usd per asset in the local assets table): ' +
      EXPOSURE_RULE +
      '. The alignment is the value-weighted mean of the class scores over the holdings that could be ' +
      'valued, so it is a reading of the regime against the book \u2014 not advice, and not a position size',
    asOf: Math.floor(Date.now() / 1000),
  });
}

import { NextResponse } from 'next/server';
import { readRegime } from '../_lib/regime';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/**
 * The macro regime (plan Phase 13, stages 16–17).
 *
 * The route's only job is to READ: it resolves a scope, fetches the series each
 * dimension needs, and hands them to `buildRegime`, which is pure. Every
 * judgement — trend, regime label, asset weights — lives in the feature, where
 * it is unit-tested offline against fixed series instead of against whatever the
 * upstream published this morning.
 *
 * The read itself lives in `../_lib/regime.ts` because `/api/economy/exposure`
 * serves the SAME regime joined with the treasury's holdings; two copies of this
 * read would let the two boards disagree about the regime they both describe.
 *
 * Failure is per-dimension. A country whose central bank we do not track still
 * gets a regime if growth, inflation and liquidity resolved; the missing
 * dimension is named in `missing[]` and the rule table simply cannot fire a rule
 * that needed it. A dimension is NEVER filled in with a guess to complete the
 * picture.
 *
 * `?country=` accepts ISO2 or ISO3. With no parameter the scope is GLOBAL and the
 * anchor is the United States — the dollar money stock and the Fed's policy rate
 * are the dominant global liquidity and policy inputs, and the payload says so.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get('country');
  const read = await readRegime(raw);
  if (!read.ok) return NextResponse.json(read.body, { status: read.status });
  return NextResponse.json(read.payload);
}

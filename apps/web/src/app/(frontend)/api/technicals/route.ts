import { NextResponse } from 'next/server';
import { publicJson } from '../_lib/http';
import { parseIds, loadTechnicals, SCAN_TTL_MS, TechnicalsError } from '@/features/technicals/client';
import { TIMEFRAMES, type Timeframe } from '@/features/technicals/model';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/** The largest class the registry carries is 65; this bounds the upstream POST. */
export const MAX_IDS = 80;

/**
 * TradingView-equivalent technical summaries, read from the screener the public
 * technicals page itself uses — no key, no scraping.
 *
 * The route only READS and SHAPES; every judgement (the score → word bands, the
 * net recovery, the invariant check) lives in `features/technicals/model.ts`,
 * where it is unit-tested offline against a frozen payload.
 *
 * `?symbols=btcusdt,ethusdt` (registry ids, see the board; max 80 — the largest
 * class the registry carries is 65, so the cap bounds the upstream POST rather
 * than a caller's ambition) · `?tf=1h,4h,1d`
 * (default `1h,4h,1d`). A payload that cannot be explained is a thrown error
 * with a status, never a 200 carrying a board of dashes: the whole point of the
 * board is that a figure it cannot source is a figure it does not print.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const ids = parseIds(params.get('symbols'));
  if (ids.length > MAX_IDS) {
    return NextResponse.json(
      { error: `too many symbols (max ${MAX_IDS})`, kind: 'too-many-symbols' },
      { status: 400 },
    );
  }
  const tfParam = params.get('tf');
  const wanted = (tfParam ?? '1h,4h,1d')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const unknownTf = wanted.filter((t) => !(TIMEFRAMES as readonly string[]).includes(t));
  if (unknownTf.length > 0) {
    return NextResponse.json(
      { error: 'unknown timeframe(s)', unknown: unknownTf, known: TIMEFRAMES },
      { status: 400 },
    );
  }
  try {
    const payload = await loadTechnicals(ids, wanted as Timeframe[]);
    return publicJson(payload, SCAN_TTL_MS / 1000);
  } catch (err) {
    if (err instanceof TechnicalsError) {
      return NextResponse.json({ error: err.message, kind: err.kind }, { status: err.status });
    }
    return NextResponse.json(
      { error: `technicals read failed: ${(err as Error).message}`, kind: 'unexpected' },
      { status: 500 },
    );
  }
}

import { NextResponse } from 'next/server';
/**
 * Wallet reconciliation. THIN, HONEST PROXY to the Rust service
 * `fudcourt-reconciled` (backend/sync, 127.0.0.1:3102) — DR-014.
 *
 * WHY A PROXY: the reconciliation maths is now a Rust implementation
 * (`backend/sync/src/reconcile.rs`) with the original TS shaper kept beside it
 * (`lib/reconcile.ts`) as the independent oracle. Both were diffed section by
 * section on live data (`scripts/tools/parity-reconcile.ts`: identical rows,
 * wallets and walletSummary, key order included) before this route was pointed at
 * the service.
 *
 * WHY NOT FALL BACK TO THE TS SHAPER: a silent fallback is exactly the failure
 * mode this house refuses — a board that keeps rendering while its real source is
 * down. If the service is unreachable this answers 502 with the real reason, and
 * the page shows the error. `lib/reconcile.ts` is a test/oracle artifact, not a
 * runtime path (the same status `scripts/oracle/cr_fetch.py` has).
 *
 * Everything the service returns is forwarded VERBATIM apart from the body's
 * `source` field, which names the implementation that produced the numbers.
 *
 * Auth is UNCHANGED and still owned by middleware + `lib/guard.ts`
 * (`/api/reconcile` is a team-tier read); this route adds no gate of its own.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
/** Rust reconcile service base URL. Runtime read: a restart picks up changes. */
const RECONCILE = process.env.RECONCILE_URL ?? 'http://127.0.0.1:3102';
/** The service does three Turso round-trips; 30s is its own client timeout. */
const TIMEOUT_MS = 45_000;
export async function GET() {
  const upstream = `${RECONCILE}/api/reconcile`;
  let res: Response;
  try {
    res = await fetch(upstream, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Unreachable, refused, DNS failure or our timeout — the real reason only.
    // Node's fetch reports a generic "fetch failed"; the actionable cause
    // (ECONNREFUSED, ENOTFOUND, our AbortSignal timeout, …) is on err.cause.
    const reason =
      err instanceof Error
        ? [err.message, (err.cause as Error | undefined)?.message]
            .filter((s): s is string => Boolean(s))
            .join(': ')
        : String(err);
    return NextResponse.json(
      { error: `reconcile unreachable: ${reason}`, upstream },
      { status: 502 },
    );
  }
  // Verbatim pass-through: parse nothing, interpret nothing. A 500 from the
  // service carries its own real reason and is forwarded with that status.
  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: {
      'Content-Type': 'application/json',
      'X-Reconcile-Upstream': upstream,
      'Cache-Control': 'no-store',
    },
  });
}

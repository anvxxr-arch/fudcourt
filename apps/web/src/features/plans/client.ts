/**
 * The paper-plan ledger's client — the one read, typed.
 *
 * TYPING / DISPLAY MIRROR ONLY. The read goes to `/api/plans`, which is
 * team-gated by `@/server/auth` (the rows carry the account's own equity and
 * risk figures) and backed by `@/server/plans` reading `signal_plans`. The
 * route owns every validation (the `limit` bound, the row shape); this file
 * must never grow a guard or a second shaper — a second one is the one thing
 * that could drift from the server's.
 *
 * What it does own: the shape the board renders with, and the reading of a
 * FAILED read, which is an error to surface — never an empty board. "No plans
 * recorded" and "the read broke" are different claims, and the board keeps them
 * apart.
 *
 * The route is team-gated, so the call rides the session cookie the shell
 * already holds (same-origin `fetch` sends it by default). `cache: 'no-store'`
 * keeps the board live — the table grows every 5 minutes, and a cached slice
 * would freeze the newest plan out of view.
 */
import { getJSON } from '@/lib/fetch';
import type { PlanLedger } from './model';

export type { PlanLedger, SignalPlan } from './model';

/** A read that either resolved to a payload or failed with a reason — never both. */
export type Source<T> = { data: T | null; error: string | null };

/**
 * Read the plan ledger. A rejection is captured as the error side rather than
 * thrown, so the board can render "the read failed" — never an empty ledger.
 */
export async function fetchPlans(signal?: AbortSignal): Promise<Source<PlanLedger>> {
  try {
    const data = await getJSON<PlanLedger>('/api/plans', { signal, cache: 'no-store' });
    return { data, error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

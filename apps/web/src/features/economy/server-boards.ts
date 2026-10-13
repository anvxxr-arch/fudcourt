import 'server-only';
/**
 * Server-side loader for the macro dashboard's boards.
 *
 * WHY THIS EXISTS. `/economy` is a prerendered shell: the export is a client
 * component that fetches its five boards from `/api/economy/*` in an effect.
 * That shell ships with `Loading` placeholders, and the cards then GROW when the
 * data lands — measured 2026-10-09 (Lighthouse mobile): `Pulse snapshot` was
 * 112px in the shell and 532px loaded, and the cards below it moved 136px
 * (CLS 0.2704, the only shift on the page). The markup was never reserving the
 * space the numbers occupy.
 *
 * The honest fix is to render the numbers in the FIRST paint, which means
 * reading them on the server. Doing that per REQUEST would be the wrong trade:
 * a single FRED series takes ~4s from here and the dashboard reads dozens, so
 * request-time rendering would push TTFB past 10s. Instead the page keeps its
 * `revalidate = 300` and this loader runs at BUILD (and on each background
 * revalidation), so the served HTML already carries the figures while TTFB
 * stays a static-file read.
 *
 * The five boards are read through the SAME route handlers the client used to
 * call, invoked directly with a synthetic request rather than over HTTP. That
 * is deliberate: the payloads, their validation and their derived fields have
 * one implementation, and the dashboard cannot drift from the API it used to
 * consume. A board that fails to load resolves to `null` — the page then falls
 * back to the client fetch it used before (see `EconomyDashboard`), so a build
 * without upstream access degrades to the old behaviour instead of baking an
 * error page for 300s.
 */
import { GET as compareGET } from '@/app/(frontend)/api/economy/compare/route';
import { GET as centralBanksGET } from '@/app/(frontend)/api/economy/central-banks/route';
import { GET as liquidityGET } from '@/app/(frontend)/api/economy/liquidity/route';
import { GET as calendarGET } from '@/app/(frontend)/api/economy/calendar/route';
import { GET as regimeGET } from '@/app/(frontend)/api/economy/regime/route';
import type {
  CalendarEnvelope,
  CentralBanksEnvelope,
  CompareEnvelope,
  LiquidityEnvelope,
  RegimeEnvelope,
} from '@/features/economy/model';
import { PULSE } from '@/features/economy/model';

export type EconomyBoards = {
  pulse: CompareEnvelope | null;
  banks: CentralBanksEnvelope | null;
  liquidity: LiquidityEnvelope | null;
  calendar: CalendarEnvelope | null;
  regime: RegimeEnvelope | null;
};

/** Invoke a route handler directly and read its JSON; `null` on any failure. */
async function read<T>(path: string): Promise<T | null> {
  try {
    const res = await (async () => {
      if (path.startsWith('compare')) return compareGET(new Request(`http://internal/api/economy/${path}`));
      if (path.startsWith('calendar')) return calendarGET(new Request(`http://internal/api/economy/${path}`));
      if (path.startsWith('regime')) return regimeGET(new Request(`http://internal/api/economy/${path}`));
      if (path.startsWith('central-banks')) return centralBanksGET();
      return liquidityGET();
    })();
    if (!res.ok) {
      // Named, not silent: a board that resolves non-200 at build time is
      // reported so the cause is visible in the build log, then left null so the
      // page falls back to its client fetch.
      console.error(`[economy] board ${path.split('?')[0]} answered HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`[economy] board ${path.split('?')[0]} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Every board the dashboard renders, read once. */
export async function loadEconomyBoards(): Promise<EconomyBoards> {
  const [pulse, banks, liquidity, calendar, regime] = await Promise.all([
    read<CompareEnvelope>(`compare?indicators=${PULSE.join(',')}&period=1y`),
    read<CentralBanksEnvelope>('central-banks'),
    read<LiquidityEnvelope>('liquidity'),
    read<CalendarEnvelope>('calendar'),
    read<RegimeEnvelope>('regime'),
  ]);
  return { pulse, banks, liquidity, calendar, regime };
}

import { NextResponse } from 'next/server';
import { LIQUIDITY_COMPONENTS, readLiquiditySeries } from '@/app/(frontend)/api/economy/_lib/adapters';
import { mapPool } from '@/app/(frontend)/api/economy/_lib/rows';
import { liquidityBreadth } from '@/features/economy/regime';
import type { LiquidityComponent } from '@/features/economy/client';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/** How far back a component's change is measured, in calendar days. */
const CHANGE_WINDOW_DAYS = 30;

/** A point's date as an epoch day, for window arithmetic. */
function dayValue(date: string): number | null {
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(t) ? Math.floor(t / 86_400_000) : null;
}

/**
 * The liquidity board (plan Phase 9) — the module's differentiator.
 *
 * Every component is a real, named series (see `LIQUIDITY_COMPONENTS`), read
 * through the same limiter and memo layer as everything else. `direction` states
 * which way a rising value pushes liquidity, so the derived index below cannot
 * invert a component: a rising reverse-repo balance or a rising dollar is
 * TIGHTENING, and a board that treated every rise as expansion would be
 * confidently wrong in exactly the regime it exists to detect.
 *
 * The index is a POSITION IN THE BASKET, 0–100: the share of components whose
 * most recent move is loosening, weighted by importance. It is derived here and
 * labelled as such — it is not an official gauge, and the payload says so.
 */
export async function GET() {
  const failed: { symbol: string; reason: string }[] = [];

  const components = await mapPool(LIQUIDITY_COMPONENTS, 5, async (spec): Promise<LiquidityComponent> => {
    try {
      const points = await readLiquiditySeries(spec);
      const withValues = points.filter((p) => Number.isFinite(p.value));
      if (withValues.length === 0) {
        failed.push({ symbol: `FRED:${spec.seriesId}`, reason: 'no observation in the window' });
        return baseComponent(spec, null, null, null, null);
      }
      const last = withValues[withValues.length - 1];
      // The comparison point is the newest observation at least
      // CHANGE_WINDOW_DAYS old — a fixed calendar lookback, not "the previous
      // row", so a weekly and a daily component are compared over the same span.
      const cutoff = (dayValue(last.date) ?? 0) - CHANGE_WINDOW_DAYS;
      let prior: number | null = null;
      for (let i = withValues.length - 2; i >= 0; i--) {
        const d = dayValue(withValues[i].date);
        if (d !== null && d <= cutoff) {
          prior = withValues[i].value;
          break;
        }
      }
      return baseComponent(spec, last.value, last.date, prior, prior === null ? null : last.value - prior);
    } catch (e) {
      failed.push({ symbol: `FRED:${spec.seriesId}`, reason: e instanceof Error ? e.message : String(e) });
      return baseComponent(spec, null, null, null, null);
    }
  });

  const live = components.filter((c) => c.change !== null);
  const index = liquidityBreadth(components);

  if (live.length === 0) {
    return NextResponse.json(
      { error: 'no data returned', detail: 'no liquidity component resolved a change over the window', failed },
      { status: 502 }
    );
  }

  return NextResponse.json({
    components,
    index,
    failed,
    upstream: ['fred.stlouisfed.org graph CSV (keyless)'],
    derived: `each component is a named FRED series; change = newest observation vs the newest at least ${CHANGE_WINDOW_DAYS} days older, so a daily and a weekly series are compared over the same span; the index is the share of live components moving in their LOOSENING direction (0–100), weighted equally — a derived position in this basket, not an official gauge; ${live.length} of ${components.length} component(s) had a usable change`,
    asOf: Math.floor(Date.now() / 1000),
  });
}

function baseComponent(
  spec: (typeof LIQUIDITY_COMPONENTS)[number],
  value: number | null,
  date: string | null,
  previous: number | null,
  change: number | null
): LiquidityComponent {
  return {
    id: spec.id,
    label: spec.label,
    value,
    unit: spec.unit,
    date,
    previous,
    change,
    direction: spec.direction,
    source: 'fred',
    note: spec.note,
  };
}

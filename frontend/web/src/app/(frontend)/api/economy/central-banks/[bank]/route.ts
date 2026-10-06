import { NextResponse } from 'next/server';
import { CENTRAL_BANK_BY_SLUG, INDICATORS } from '@/features/economy/model';
import { readObservations } from '@/app/(frontend)/api/economy/_lib/adapters';
import { toMeta } from '@/app/(frontend)/api/economy/_lib/rows';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/**
 * One central bank (plan Phase 7): the current rate, its full daily history, and
 * the DECISIONS derived from it.
 *
 * `changes` is the interesting part and it is derived, not fetched: a policy
 * decision IS a change in the level, so the list of distinct levels with the date
 * each took effect reconstructs the decision history from the rate series itself.
 * That is honest — every entry is a date the upstream actually published a new
 * value on — and it is why this page needs no separate "decisions" dataset that
 * would immediately drift from the rate it describes.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ bank: string }> }) {
  const { bank: slug } = await params;
  const bank = CENTRAL_BANK_BY_SLUG[(slug ?? '').toLowerCase()];
  if (!bank) {
    return NextResponse.json(
      { error: 'unknown central bank', detail: `${JSON.stringify(slug ?? '')} is not a central bank this module tracks` },
      { status: 404 }
    );
  }

  // The registry's own policy-rate indicator for this area — the same object the
  // indicator page resolves, so the two pages cannot describe different series.
  const policyIndicator = INDICATORS.find((i) => i.subcategory === 'policy-rate' && i.sourceSeriesId === bank.area);
  if (!policyIndicator) {
    return NextResponse.json(
      { error: 'no indicator bound', detail: `no policy-rate indicator is bound to BIS area ${bank.area}` },
      { status: 400 }
    );
  }

  const failed: { symbol: string; reason: string }[] = [];
  let history: { date: string; value: number | null }[] = [];
  try {
    history = (await readObservations(policyIndicator)).map((o) => ({ date: o.date, value: o.value }));
  } catch (e) {
    failed.push({ symbol: `BIS:${bank.area}`, reason: e instanceof Error ? e.message : String(e) });
  }

  if (history.length === 0) {
    return NextResponse.json(
      { error: 'no data returned', detail: `BIS WS_CBPOL published nothing for area ${bank.area} in the window`, failed },
      { status: 502 }
    );
  }

  // Walk the daily series and keep each level CHANGE, carrying the date it took
  // effect. Consecutive identical values are one level, not many observations.
  const changes: { date: string; from: number; to: number }[] = [];
  let current: { date: string; value: number } | null = null;
  for (const point of history) {
    if (point.value === null) continue;
    if (!current) {
      current = { date: point.date, value: point.value };
      continue;
    }
    if (point.value !== current.value) {
      changes.push({ date: point.date, from: current.value, to: point.value });
      current = { date: point.date, value: point.value };
    }
  }
  const latest = current;
  // The most recent change whose `to` is not the current level would be a
  // contradiction; the walk above guarantees `current` is the last level, so the
  // previous DISTINCT level is the `from` of the last change.
  const lastChange = changes.length > 0 ? changes[changes.length - 1] : null;

  const related = INDICATORS.filter(
    (i) => i.country === bank.country && i.category === 'monetary' && i.subcategory !== 'policy-rate'
  )
    .slice(0, 8)
    .map(toMeta);

  return NextResponse.json({
    bank: {
      slug: bank.slug,
      short: bank.short,
      name: bank.name,
      area: bank.area,
      country: bank.country,
      region: bank.region,
      note: bank.note,
      rate: latest?.value ?? null,
      date: latest?.date ?? null,
      previousRate: lastChange?.from ?? null,
    },
    history,
    changes: changes.slice(-24).reverse(),
    related,
    failed,
    upstream: ['stats.bis.org WS_CBPOL (daily, keyless)'],
    derived: `${history.length} daily observation(s) over a 6-year window; ${changes.length} level change(s) derived from the series itself (each is a date BIS published a new value on, which is what a policy decision looks like in the data); no statement text and no meeting calendar are fetched, so neither is claimed`,
    asOf: Math.floor(Date.now() / 1000),
  });
}

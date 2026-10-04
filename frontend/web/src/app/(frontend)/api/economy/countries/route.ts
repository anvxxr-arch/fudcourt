import { NextResponse } from 'next/server';
import { COUNTRY_LIST, INDICATORS } from '@/features/economy/registry';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/**
 * The country registry as a board reads it (plan Phase 5).
 *
 * Served from the compiled registry, so this route touches no upstream and can
 * never be stale or rate-limited: the explorer must render even when every
 * provider is down, because a navigation page that fails is a page nobody can
 * reach the data through.
 */
export async function GET() {
  const counts = new Map<string, number>();
  for (const ind of INDICATORS) {
    if (!ind.country) continue;
    counts.set(ind.country, (counts.get(ind.country) ?? 0) + 1);
  }

  const countries = COUNTRY_LIST.map((c) => ({ ...c, indicatorCount: counts.get(c.id) ?? 0 }));
  // Region order is the taxonomy's own display order, not the alphabetical order
  // of the strings, so the board does not lead with "Africa & Middle East".
  const preferred = ['Americas', 'Europe', 'Asia-Pacific', 'Africa & Middle East'];
  const present = new Set(COUNTRY_LIST.map((c) => c.region));
  const regions = preferred.filter((r) => present.has(r as never));

  return NextResponse.json({
    countries,
    regions,
    total: countries.length,
    asOf: Math.floor(Date.now() / 1000),
  });
}

import { NextResponse } from 'next/server';
import { CENTRAL_BANKS } from '@/features/economy/registry';
import { fetchPolicyRates } from '@/features/market/sources/bis';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/**
 * Every central bank the registry tracks, with its current policy rate
 * (plan Phase 7).
 *
 * ONE upstream call, not thirty-three: BIS's WS_CBPOL accepts a `+`-joined area
 * list and answers the latest observation per area, which is exactly the shape
 * this board needs. Fanning out per bank would be the same data at 33× the
 * request cost against a rate-limited public API.
 *
 * A bank BIS carries no observation for keeps `rate: null` and is named in
 * `failed[]` — the row still renders, because "we track this bank but BIS is
 * quiet about it" is a different fact from "this bank does not exist".
 */
export async function GET() {
  const areas = CENTRAL_BANKS.map((b) => b.area);
  const failed: { symbol: string; reason: string }[] = [];
  const rateByArea = new Map<string, { rate: number; date: string }>();

  try {
    for (const hit of await fetchPolicyRates(areas)) {
      rateByArea.set(hit.area, { rate: hit.rate, date: hit.date });
    }
  } catch (e) {
    failed.push({ symbol: 'BIS:WS_CBPOL', reason: e instanceof Error ? e.message : String(e) });
  }

  const banks = CENTRAL_BANKS.map((b) => {
    const hit = rateByArea.get(b.area);
    if (!hit) failed.push({ symbol: `BIS:${b.area}`, reason: 'no observation in the window' });
    return {
      slug: b.slug,
      short: b.short,
      name: b.name,
      area: b.area,
      country: b.country,
      region: b.region,
      note: b.note,
      rate: hit?.rate ?? null,
      date: hit?.date ?? null,
      previousRate: null,
    };
  });

  if (rateByArea.size === 0) {
    return NextResponse.json(
      { error: 'no data returned', detail: 'BIS WS_CBPOL answered nothing for any tracked area', failed },
      { status: 502 }
    );
  }

  return NextResponse.json({
    banks,
    failed,
    upstream: ['stats.bis.org WS_CBPOL (daily, keyless)'],
    derived: `latest observation per area from ONE BIS call for ${areas.length} areas; ${rateByArea.size} resolved, ${failed.length} item(s) failed; a bank BIS does not carry is present with rate null, never omitted and never 0`,
    asOf: Math.floor(Date.now() / 1000),
  });
}

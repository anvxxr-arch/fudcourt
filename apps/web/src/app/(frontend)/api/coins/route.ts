import { NextResponse } from 'next/server';
import { query } from '@/server/db';
import { failInternal } from '../_lib/http';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// GET /api/coins — distinct coins with total value, sorted by value desc
export async function GET() {
  try {
    const coins = await query(
      `SELECT asset,
              SUM(value_usd) as total_usd,
              SUM(quantity) as total_qty,
              COUNT(DISTINCT chain) as chains,
              COUNT(DISTINCT wallet) as wallets
       FROM assets
       GROUP BY asset
       ORDER BY total_usd DESC, asset`
    );

    const coinRows = coins as { total_usd: number | string | null }[];
    const hasNull = coinRows.some((c) => c.total_usd === null || c.total_usd === undefined);
    const total = hasNull ? null : coinRows.reduce((s, c) => s + Number(c.total_usd ?? 0), 0);

    return NextResponse.json({ coins, total });
  } catch (e: unknown) {
    return failInternal(e);
  }
}

import { NextResponse } from 'next/server';
import { query } from '@/server/db';
import { fail, failInternal } from '../../_lib/http';
import { accountCollections, accountPortfolio, openseaKey } from '@/features/nft/opensea';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/**
 * GET /api/treasury/nfts — the treasury's wallets joined with OpenSea.
 *
 * For every monitored wallet in the local `wallets` table: the venue's
 * portfolio value (total/nft/token USD + P&L) and the collections it holds
 * with the venue's own USD mark. Read-only overlay: nothing is written to
 * `assets`, so the sync stays the single writer and this route can never
 * invent a holding.
 *
 * A wallet whose venue read fails still appears, with `failed` naming the
 * reason — the exposure route's visible-partial contract, not an empty table.
 * A missing OPENSEA_API_KEY answers 503 (never an empty list), a throttled
 * deployment 429, transport 504, upstream 502.
 *
 *   ?timeframe=DAY|WEEK|MONTH   P&L window (default DAY, venue vocabulary)
 *   ?wallet=<address>           one wallet only (default: all monitored)
 *
 * Tier: `team`. Registered in `@/server/auth`'s TEAM_API_ROUTES alongside
 * `/api/economy/exposure`: the wallet list is private even though the venue
 * figures are public chain data.
 */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const timeframeRaw = p.get('timeframe') ?? 'DAY';
  if (!['HOUR', 'DAY', 'WEEK', 'MONTH'].includes(timeframeRaw)) {
    return fail(
      'unknown timeframe',
      400,
      `${JSON.stringify(timeframeRaw)} is not one of HOUR|DAY|WEEK|MONTH`,
    );
  }
  const timeframe = timeframeRaw;
  const only = p.get('wallet');

  let wallets: { address: string; label: string | null; chain: string | null }[];
  try {
    wallets = (await query(
      only
        ? 'SELECT address, label, chain FROM wallets WHERE monitored = 1 AND address = ?'
        : 'SELECT address, label, chain FROM wallets WHERE monitored = 1 ORDER BY created_at, address',
      only ? [only] : [],
    )) as { address: string; label: string | null; chain: string | null }[];
  } catch (e: unknown) {
    return failInternal(e);
  }
  if (only && wallets.length === 0) return fail('unknown wallet', 404, 'no monitored wallet with that address');

  const toNum = (s: string | null | undefined): number | null => {
    if (s === null || s === undefined || s === '') return null;
    const v = Number(s);
    return Number.isFinite(v) ? v : null;
  };

  const rows = await Promise.all(
    wallets.map(async (w) => {
      try {
        const [pf, cols] = await Promise.all([
          accountPortfolio(w.address, timeframe),
          accountCollections(w.address, 50),
        ]);
        return {
          address: w.address,
          label: w.label,
          chain: w.chain,
          portfolio: {
            total_value_usd: toNum(pf.total_value_usd),
            nft_value_usd: toNum(pf.nft_value_usd),
            token_value_usd: toNum(pf.token_value_usd),
            pnl_absolute: toNum(pf.pnl_absolute),
            pnl_percentage: toNum(pf.pnl_percentage),
            timeframe: pf.timeframe,
          },
          collections: cols.collections.map((c) => ({
            collection: c.collection,
            name: c.name,
            item_count: c.item_count ?? null,
            usd_value: c.usd_value ?? null,
          })),
          failed: null as string | null,
        };
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return {
          address: w.address,
          label: w.label,
          chain: w.chain,
          portfolio: null,
          collections: [],
          failed: reason,
        };
      }
    }),
  );

  const failedWallets = rows.filter((r) => r.failed !== null).length;
  if (openseaKey() === null && failedWallets === rows.length && rows.length > 0) {
    return fail('OPENSEA_API_KEY is not configured; this endpoint requires it', 503);
  }
  const throttled = rows.find((r) => r.failed !== null && /throttled \(429\)/.test(r.failed ?? ''));
  if (throttled && failedWallets === rows.length && rows.length > 0) {
    return fail('OpenSea throttled this deployment (429)', 429);
  }

  return NextResponse.json({
    timeframe,
    wallets: rows,
    totals: {
      wallets: rows.length,
      total_value_usd: rows.reduce((s, r) => s + (r.portfolio?.total_value_usd ?? 0), 0),
      nft_value_usd: rows.reduce((s, r) => s + (r.portfolio?.nft_value_usd ?? 0), 0),
      failed: failedWallets,
    },
    asOf: Math.floor(Date.now() / 1000),
  });
}

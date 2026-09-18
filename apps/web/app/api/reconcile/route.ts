import { query } from '../../../lib/db';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type AssetRow = { wallet: string; chain: string; asset: string; quantity: number; value_usd: number; updated_at: string | null };
type TxRow = { id: number; date: string; chain: string; asset: string; event: string; amount_usd: number; direction: string; memo: string | null; wallet_to: string | null; hash: string | null; url: string | null; source: string };
type WalletRow = { address: string; label: string; alias: string; emoji: string; color: string; chain: string };
type ReconRow = { wallet: string; asset: string; current: number; in_sum: number; out_sum: number; expected: number; diff: number };

export async function GET() {
  try {
    const [assets, transactions, wallets] = await Promise.all([
      query(`SELECT wallet, chain, asset, quantity, value_usd, updated_at FROM assets ORDER BY wallet, chain, asset`) as unknown as Promise<AssetRow[]>,
      query(`SELECT id, date, chain, asset, event, amount_usd, direction, memo, wallet_to, hash, url, source FROM transactions ORDER BY date ASC`) as unknown as Promise<TxRow[]>,
      query(`SELECT address, label, alias, emoji, color, chain FROM wallets ORDER BY label`) as unknown as Promise<WalletRow[]>,
    ]);

    const balance: Record<string, Record<string, { current: number; in_sum: number; out_sum: number }>> = {};

    for (const a of assets) {
      const w = a.wallet || 'Unknown';
      const asset = a.asset || 'Unknown';
      if (!balance[w]) balance[w] = {};
      if (!balance[w][asset]) balance[w][asset] = { current: 0, in_sum: 0, out_sum: 0 };
      balance[w][asset].current += Number(a.quantity) || 0;
    }

    for (const t of transactions) {
      const w = t.wallet_to || 'Unknown';
      const asset = t.asset || 'USDT';
      if (!balance[w]) balance[w] = {};
      if (!balance[w][asset]) balance[w][asset] = { current: 0, in_sum: 0, out_sum: 0 };
      const amt = Number(t.amount_usd) || 0;
      if (t.direction === 'IN') balance[w][asset].in_sum += amt;
      else balance[w][asset].out_sum += amt;
    }

    const rows: ReconRow[] = [];
    for (const w of Object.keys(balance)) {
      for (const asset of Object.keys(balance[w])) {
        const b = balance[w][asset];
        const expected = b.in_sum - b.out_sum;
        const diff = b.current - expected;
        rows.push({ wallet: w, asset, current: b.current, in_sum: b.in_sum, out_sum: b.out_sum, expected, diff });
      }
    }

    rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

    const walletSummary: Record<string, { current_total: number; expected_total: number; diff_total: number }> = {};
    for (const r of rows) {
      if (!walletSummary[r.wallet]) walletSummary[r.wallet] = { current_total: 0, expected_total: 0, diff_total: 0 };
      walletSummary[r.wallet].current_total += r.current * (r.asset === 'USDC' || r.asset === 'USDT' ? 1 : 0);
      walletSummary[r.wallet].expected_total += r.expected;
      walletSummary[r.wallet].diff_total += r.diff;
    }

    return NextResponse.json({ rows, wallets, walletSummary });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

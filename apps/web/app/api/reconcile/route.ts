import { query } from '../../../lib/db';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    // Get all assets (current balances per chain/asset/wallet)
    const assets = await query(`
      SELECT wallet, chain, asset, quantity, value_usd, updated_at
      FROM assets
      ORDER BY wallet, chain, asset
    `);

    // Get all transactions
    const transactions = await query(`
      SELECT id, date, chain, asset, event, amount_usd, direction, memo, wallet_to, hash, url, source
      FROM transactions
      ORDER BY date ASC
    `);

    // Get wallet labels
    const wallets = await query(`
      SELECT address, label, alias, emoji, color, chain
      FROM wallets
      ORDER BY label
    `);

    // Reconciliation: per wallet, per asset
    // current_balance from assets table
    // sum of IN transactions - sum of OUT transactions = expected balance
    // diff = current_balance - expected

    const walletAssetBalance: Record<string, Record<string, { current: number; in_sum: number; out_sum: number; expected: number; diff: number }>> = {};

    // Current balances from assets
    for (const a of assets as any[]) {
      const w = a.wallet || 'Unknown';
      const asset = a.asset || 'Unknown';
      if (!walletAssetBalance[w]) walletAssetBalance[w] = {};
      if (!walletAssetBalance[w][asset]) walletAssetBalance[w][asset] = { current: 0, in_sum: 0, out_sum: 0, expected: 0, diff: 0 };
      walletAssetBalance[w][asset].current += Number(a.quantity) || 0;
    }

    // Sum transactions by wallet_to + asset
    for (const t of transactions as any[]) {
      const w = t.wallet_to || 'Unknown';
      const asset = t.asset || 'USDT';
      if (!walletAssetBalance[w]) walletAssetBalance[w] = {};
      if (!walletAssetBalance[w][asset]) walletAssetBalance[w][asset] = { current: 0, in_sum: 0, out_sum: 0, expected: 0, diff: 0 };
      const amt = Number(t.amount_usd) || 0;
      if (t.direction === 'IN') walletAssetBalance[w][asset].in_sum += amt;
      else walletAssetBalance[w][asset].out_sum += amt;
    }

    // Compute expected and diff
    const rows: any[] = [];
    for (const w of Object.keys(walletAssetBalance)) {
      for (const asset of Object.keys(walletAssetBalance[w])) {
        const b = walletAssetBalance[w][asset];
        b.expected = b.in_sum - b.out_sum;
        b.diff = b.current - b.expected;
        rows.push({ wallet: w, asset, ...b });
      }
    }

    // Sort by absolute diff descending (suspicious first)
    rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

    // Summary per wallet
    const walletSummary: Record<string, { current_total: number; expected_total: number; diff_total: number }> = {};
    for (const r of rows) {
      if (!walletSummary[r.wallet]) walletSummary[r.wallet] = { current_total: 0, expected_total: 0, diff_total: 0 };
      walletSummary[r.wallet].current_total += r.current * (r.asset === 'USDC' || r.asset === 'USDT' ? 1 : 0); // approximate for stablecoins
      walletSummary[r.wallet].expected_total += r.expected;
      walletSummary[r.wallet].diff_total += r.diff;
    }

    return NextResponse.json({ rows, wallets, walletSummary });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

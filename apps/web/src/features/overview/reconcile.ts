// Pure reconciliation shaper (DR-014).
//
// WHY THIS IS A SEPARATE FILE: `/api/reconcile` is now served two ways -- this TS
// shaper and the Rust service in `apps/reconciler` -- and the two must agree on live
// data. A shaper that a probe can import and feed recorded rows is what makes
// that comparison possible at all; the same reason `lib/shapers.ts` exists for
// the CryptoRank envelopes.
//
// The body below is the route's original inline logic, moved verbatim. It is NOT
// improved on the way out: `expected` stays transaction-derived, `current_total`
// stays stablecoin-only, `|| 'Unknown'` and `Number(x) || 0` stay as they were.
// Any of those changed here and the Rust port would "differ" from a rule that
// nothing had ever written down.

export type AssetRow = { wallet: string; chain: string; asset: string; quantity: number; value_usd: number; updated_at: string | null };
export type TxRow = { id: number; date: string; chain: string; asset: string; event: string; amount_usd: number; direction: string; memo: string | null; wallet_to: string | null; hash: string | null; url: string | null; source: string };
export type WalletRow = { address: string; label: string; alias: string; emoji: string; color: string; chain: string };
export type ReconRow = { wallet: string; asset: string; current: number; in_sum: number; out_sum: number; expected: number; diff: number };
export type WalletSummary = { current_total: number; expected_total: number; diff_total: number };

export type ReconcileResult = {
  rows: ReconRow[];
  wallets: WalletRow[];
  walletSummary: Record<string, WalletSummary>;
};

export function reconcile(
  assets: AssetRow[],
  transactions: TxRow[],
  wallets: WalletRow[],
): ReconcileResult {
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
  const walletSummary: Record<string, WalletSummary> = {};
  for (const r of rows) {
    if (!walletSummary[r.wallet]) walletSummary[r.wallet] = { current_total: 0, expected_total: 0, diff_total: 0 };
    walletSummary[r.wallet].current_total += r.current * (r.asset === 'USDC' || r.asset === 'USDT' ? 1 : 0);
    walletSummary[r.wallet].expected_total += r.expected;
    walletSummary[r.wallet].diff_total += r.diff;
  }
  return { rows, wallets, walletSummary };
}

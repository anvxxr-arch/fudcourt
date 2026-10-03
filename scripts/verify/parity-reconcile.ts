// Parity probe (DR-014): run the SAME live rows through the TS shaper and the
// Rust service, and diff the three payload sections as JSON.
//
// This is deliberately a throwaway-shaped tool rather than a unit test: it needs
// the live database and the running Rust service, so it documents HOW the two
// implementations were shown to agree in one place, and `verify-reconcile.py`
// carries the durable contract assertions.
//
// Usage: cd frontend/web && bun --tsconfig-override ./tsconfig.json \
//   ../../scripts/verify/parity-reconcile.ts [rust-base]
import { query } from '@/platform/db/client';
import { reconcile } from '@/features/treasury/reconcile';
import type { AssetRow, TxRow, WalletRow } from '@/features/treasury/reconcile';

const RUST_BASE = process.argv[2] ?? 'http://127.0.0.1:3102';

const assets = (await query(
  `SELECT wallet, chain, asset, quantity, value_usd, updated_at FROM assets ORDER BY wallet, chain, asset`,
)) as unknown as AssetRow[];
const transactions = (await query(
  `SELECT id, date, chain, asset, event, amount_usd, direction, memo, wallet_to, hash, url, source FROM transactions ORDER BY date ASC`,
)) as unknown as TxRow[];
const wallets = (await query(
  `SELECT address, label, alias, emoji, color, chain FROM wallets ORDER BY label`,
)) as unknown as WalletRow[];

const ts = reconcile(assets, transactions, wallets);

const res = await fetch(`${RUST_BASE}/api/reconcile`);
if (!res.ok) {
  console.error(`rust service answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  process.exit(1);
}
type RustBody = {
  rows: typeof ts.rows;
  wallets: typeof ts.wallets;
  walletSummary: typeof ts.walletSummary;
  source: string;
};
const rust = (await res.json()) as RustBody;

console.log(`input: ${assets.length} asset rows, ${transactions.length} tx rows, ${wallets.length} wallets`);
console.log(`ts rows=${ts.rows.length} wallets=${ts.wallets.length} summary=${Object.keys(ts.walletSummary).length}`);
console.log(`rust rows=${rust.rows.length} wallets=${rust.wallets.length} summary=${Object.keys(rust.walletSummary).length} source=${rust.source}`);

let failed = 0;
function section(name: string, a: unknown, b: unknown) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  console.log(`${same ? 'OK  ' : 'FAIL'} ${name}`);
  if (!same) {
    failed++;
    // Show the first divergent element rather than dumping both payloads.
    const av = a as unknown[];
    const bv = b as unknown[];
    if (Array.isArray(av) && Array.isArray(bv)) {
      for (let i = 0; i < Math.max(av.length, bv.length); i++) {
        if (JSON.stringify(av[i]) !== JSON.stringify(bv[i])) {
          console.log(`  first divergence at index ${i}`);
          console.log(`    ts  : ${JSON.stringify(av[i])}`);
          console.log(`    rust: ${JSON.stringify(bv[i])}`);
          break;
        }
      }
    } else {
      console.log(`  ts  : ${JSON.stringify(a).slice(0, 500)}`);
      console.log(`  rust: ${JSON.stringify(b).slice(0, 500)}`);
    }
  }
}

section('rows (ordered)', ts.rows, rust.rows);
section('wallets (echoed SELECT)', ts.wallets, rust.wallets);
section('walletSummary (key order included)', ts.walletSummary, rust.walletSummary);

// The summary sections must also agree key-for-key regardless of order, so an
// insertion-order difference cannot be mistaken for a value difference.
const keySets = (o: Record<string, unknown>) => JSON.stringify(Object.keys(o).sort());
section('walletSummary key SET (order-insensitive)', keySets(ts.walletSummary), keySets(rust.walletSummary));

console.log(failed === 0 ? 'PARITY: all sections identical' : `PARITY: ${failed} section(s) differ`);
process.exit(failed === 0 ? 0 : 1);

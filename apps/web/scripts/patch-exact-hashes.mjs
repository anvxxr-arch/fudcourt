import fs from 'node:fs';
const src = fs.readFileSync('/home/dwizzy/fudcourt/apps/balance/lib/db.ts', 'utf8');
const url = src.match(/url:\s*'([^']+)'/)[1];
const tok = src.match(/authToken:\s*'([^']+)'/)[1];
const { createClient } = await import('/home/dwizzy/fudcourt/node_modules/@libsql/client/lib-esm/node.js');
const c = createClient({ url, authToken: tok });

// EXACT on-chain verified receipts (BSC RPC eth_getTransactionReceipt, status 0x1)
const FIX = [
  { id: 1, hash: '0x9bcfb80ce9e0b4fef9a375f541b12b5c20eb3f55ca233a6a8189a949de480195',
    url: 'https://bscscan.com/tx/0x9bcfb80ce9e0b4fef9a375f541b12b5c20eb3f55ca233a6a8189a949de480195',
    wallet_to: '0xb0be41f0e7f0ad49622b292da1322c2bea46fa1b',
    memo: 'VERIFIED: 300 USDT Main 0x6816ba2cb2bc013a78225228a153586ca63b1548 -> Hanif 0xb0be41f0e7f0ad49622b292da1322c2bea46fa1b, blk 122016821 status 0x1' },
  { id: 2, hash: '0x11f89a228e6ed788576b85d3989a1b4d6fe17a81a20ded2e232e4499a435decf',
    url: 'https://bscscan.com/tx/0x11f89a228e6ed788576b85d3989a1b4d6fe17a81a20ded2e232e4499a435decf',
    wallet_to: '0x787513072f5ed215e14f488325a27185ca0bbec9',
    memo: 'VERIFIED: 200 USDT Main 0x6816...1548 -> 0x787513072f5ed215e14f488325a27185ca0bbec9 (EOA nonce 34038)' },
  { id: 3, hash: '0xde649e2f233bb3819b0ecfdc38a05ac08918ea7b571cc6f3eec7011de42ade4a',
    url: 'https://bscscan.com/tx/0xde649e2f233bb3819b0ecfdc38a05ac08918ea7b571cc6f3eec7011de42ade4a',
    wallet_to: '0xd0784cd963127c7d2d813bb395b91d98425b4350',
    memo: 'VERIFIED: 200 USDT Main 0x6816...1548 -> 0xd0784cd963127c7d2d813bb395b91d98425b4350 (EOA nonce 6)' },
  { id: 6, hash: '0xabae8fe68d93f79485328b82a426697987a371b096ea77f9d7ec46bd0ca036e6',
    url: 'https://bscscan.com/tx/0xabae8fe68d93f79485328b82a426697987a371b096ea77f9d7ec46bd0ca036e6',
    wallet_to: '0x9f599f3d64a9d99ea21e68127bb6ce99f893da61',
    memo: 'VERIFIED: 30 USDT out via 0x011af51cc6614fec1de0e0ff6dc315a150f3851c (fee 0.075) -> 0x9f599f3d64a9d99ea21e68127bb6ce99f893da61' },
  { id: 7, hash: '0xbeb3c9f5bbbf98439027e130ff51567d340f58936053e961db17f98e4bf27900',
    url: 'https://bscscan.com/tx/0xbeb3c9f5bbbf98439027e130ff51567d340f58936053e961db17f98e4bf27900',
    wallet_to: '0x9d545895834ea5114a6477bc94339835c2e33dae',
    memo: 'VERIFIED: 100 USDT 1inch swap via 0x111111125421ca6dc452d289314280a0f8842a65 -> 0x9d545895834ea5114a6477bc94339835c2e33dae (fee 0.25)' },
  { id: 8, hash: '2SfcnEuCuz5FZC7nDfTwbs4x5P5TEK5ucGNuGhGBiQCRanWyu3nFyN3fwhsHwhFXUg93aUf3orSwECcsHYMhqqqZ',
    url: 'https://solscan.io/tx/2SfcnEuCuz5FZC7nDfTwbs4x5P5TEK5ucGNuGhGBiQCRanWyu3nFyN3fwhsHwhFXUg93aUf3orSwECcsHYMhqqqZ',
    wallet_to: '7KMhEBFjmhhC1B2HqaJC7zvkyx9pJ9ryCXqUnGBThgFP',
    memo: 'VERIFIED: 0.998 SOL inbound to Akang wallet 7KMhEBFjmhhC1B2HqaJC7zvkyx9pJ9ryCXqUnGBThgFP at 2026-09-11T20:01:29Z' },
];

for (const f of FIX) {
  await c.execute({
    sql: 'UPDATE transactions SET hash=?, url=?, wallet_to=?, memo=? WHERE id=?',
    args: [f.hash, f.url, f.wallet_to, f.memo, f.id],
  });
  console.log(`patched id=${f.id} -> ${f.hash.slice(0, 30)}...`);
}

const r = await c.execute('SELECT id,date,event,amount_usd,direction,hash,wallet_to FROM transactions WHERE id IN (1,2,3,6,7,8) ORDER BY id');
console.log('\n=== READBACK ===');
for (const x of r.rows) console.log(`${x.id} | ${x.date} | ${x.event} | ${x.amount_usd} | ${x.hash} | -> ${x.wallet_to}`);

// Any remaining placeholders?
const bad = await c.execute("SELECT id,hash FROM transactions WHERE hash LIKE '0xabc%' OR (hash IS NOT NULL AND hash<>'' AND length(hash)<60)");
console.log('\nremaining placeholders:', bad.rows.length, JSON.stringify(bad.rows));
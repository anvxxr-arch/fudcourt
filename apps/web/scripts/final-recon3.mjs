import fs from 'node:fs';
const RPCs = ['https://bsc.blockrazor.xyz', 'https://1rpc.io/bnb', 'https://bsc-dataseed.bnbchain.org'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = a => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const W = { Main: '0x6816ba2cb2bc013a78225228a153586ca63b1548', Hanif: '0xb0be41f0e7f0ad49622b292da1322c2bea46fa1b' };

const data = JSON.parse(fs.readFileSync('/tmp/bsc_verified.json', 'utf8'));
const seen = new Set();
const ledger = [];
for (const x of data) {
  for (const t of (x.realUSDT || [])) {
    if (t.topic0 !== TRANSFER) continue;
    const from = (t.from || '').toLowerCase(), to = (t.to || '').toLowerCase();
    const ours = Object.entries(W).find(([k, v]) => v === from || v === to);
    if (!ours) continue;
    const key = `${x.hash}|${from}|${to}|${t.amt}|${x.block}`;
    if (seen.has(key)) continue;            // <-- dedupe
    seen.add(key);
    ledger.push({ time: x.time, block: x.block, from, to, amt: t.amt, hash: x.hash,
      dir: (to === W.Main || to === W.Hanif) ? 'IN' : 'OUT', wallet: ours[0] });
  }
}
// drop self-transfers Main->Main etc
const clean = ledger.filter(l => l.from !== l.to);
clean.sort((a, b) => a.block - b.block);

console.log(`unique transfer legs: ${clean.length}\n`);
console.log('=== EXACT USDT LEDGER (verified, deduped) ===');
for (const l of clean) console.log(`${l.time.slice(0, 19)} blk ${l.block} ${l.dir.padEnd(3)} ${String(l.amt).padStart(22)}  ${l.from} -> ${l.to}  ${l.hash}`);

const byW = {};
for (const l of clean) (byW[l.wallet] ||= []).push(l);
console.log('\n=== PER-WALLET ===');
let g = 0;
for (const [w, ls] of Object.entries(byW)) {
  const i = ls.filter(l => l.dir === 'IN').reduce((s, l) => s + l.amt, 0);
  const o = ls.filter(l => l.dir === 'OUT').reduce((s, l) => s + l.amt, 0);
  g += i - o;
  console.log(`  ${w.padEnd(6)} IN=${i.toFixed(8)} OUT=${o.toFixed(8)} NET=${(i - o).toFixed(8)} n=${ls.length}`);
}
console.log(`  GRAND NET = ${g.toFixed(8)}`);

console.log('\n=== LIVE USDT BALANCE (exact, on-chain now) ===');
const bal = {};
for (const [n, w] of Object.entries(W)) {
  let d = null;
  for (let i = 0; i < 6 && !d; i++) { d = await (async () => {
    for (const u of RPCs) { try { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDT, data: '0x70a08231' + pad(w) }, 'latest'] }) }); const j = await r.json(); if (j.result) return j.result; } catch (e) {} } return null; })(); if (!d) await sleep(700); }
  bal[n] = d ? Number(BigInt(d)) / 1e18 : null;
  console.log(`  ${n.padEnd(6)} = ${bal[n]} USDT`);
}
fs.writeFileSync('/tmp/final_recon3.json', JSON.stringify({ ledger: clean, byWallet: byW, balances: bal }, null, 1));
console.log('\nwrote /tmp/final_recon3.json');
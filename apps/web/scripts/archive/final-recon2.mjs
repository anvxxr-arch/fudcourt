import fs from 'node:fs';
const CALLRPCS = ['https://bsc.blockrazor.xyz', 'https://1rpc.io/bnb', 'https://bsc-dataseed.bnbchain.org'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ci = 0;
async function call(m, p) {
  for (let i = 0; i < CALLRPCS.length; i++) {
    const u = CALLRPCS[(ci + i) % CALLRPCS.length];
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) });
      const j = await r.json();
      if (j.result !== undefined && j.result !== null) { ci++; return j.result; }
    } catch (e) {}
  }
  return null;
}
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = a => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const W = { Main: '0x6816ba2cb2bc013a78225228a153586ca63b1548', Hanif: '0xb0be41f0e7f0ad49622b292da1322c2bea46fa1b' };

const data = JSON.parse(fs.readFileSync('/tmp/bsc_verified.json', 'utf8'));
// TRUE ledger: real USDT contract AND topic0 == Transfer only
const ledger = [];
for (const x of data) {
  for (const t of (x.realUSDT || [])) {
    if (t.topic0 !== TRANSFER) continue;            // <-- FIX: skip Approval events
    const from = (t.from || '').toLowerCase(), to = (t.to || '').toLowerCase();
    const ours = Object.entries(W).find(([k, v]) => v === from || v === to);
    if (!ours) continue;
    const dir = (to === W.Main) ? 'IN' : (to === W.Hanif) ? 'IN' : 'OUT';
    ledger.push({ time: x.time, block: x.block, from, to, amt: t.amt, hash: x.hash, dir, wallet: ours[0] });
  }
}
ledger.sort((a, b) => a.block - b.block || a.time.localeCompare(b.time));
console.log('=== TRUE USDT LEDGER (Transfer events only, real Binance-Peg USDT) ===');
let run = {};
const RS = []; // running statement
for (const l of ledger) {
  console.log(`${l.time.slice(0, 19)} blk ${l.block} ${l.dir.padEnd(3)} ${String(l.amt).padStart(20)} USDT  ${l.from} -> ${l.to}  ${l.hash}`);
}
const byW = {};
for (const l of ledger) { (byW[l.wallet] ||= []).push(l); }
console.log('\n=== PER-WALLET NET (from verified transfer events) ===');
let grand = 0;
for (const [w, ls] of Object.entries(byW)) {
  const inn = ls.filter(l => l.dir === 'IN').reduce((s, l) => s + l.amt, 0);
  const out = ls.filter(l => l.dir === 'OUT').reduce((s, l) => s + l.amt, 0);
  grand += inn - out;
  console.log(`  ${w.padEnd(6)} IN=${inn.toFixed(8)}  OUT=${out.toFixed(8)}  NET=${(inn - out).toFixed(8)}  (n=${ls.length})`);
}
console.log(`  GRAND NET = ${grand.toFixed(8)} USDT`);

console.log('\n=== CURRENT ON-CHAIN USDT BALANCE (exact) ===');
for (const [n, w] of Object.entries(W)) {
  const d = await call('eth_call', [{ to: USDT, data: '0x70a08231' + pad(w) }, 'latest']);
  console.log(`  ${n.padEnd(6)} ${w} = ${d ? Number(BigInt(d)) / 1e18 : 'RPC_NULL'}`);
  await sleep(150);
}
fs.writeFileSync('/tmp/final_recon2.json', JSON.stringify({ ledger, byWallet: byW }, null, 1));
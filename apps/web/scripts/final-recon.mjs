import fs from 'node:fs';
const CALLRPCS = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc.blockrazor.xyz'];
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
const pad = a => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const W = {
  Main: '0x6816ba2cb2bc013a78225228a153586ca63b1548',
  Hanif: '0xb0be41f0e7f0ad49622b292da1322c2bea46fa1b',
};

const data = JSON.parse(fs.readFileSync('/tmp/bsc_verified.json', 'utf8'));
// build exact USDT ledger: only REAL USDT contract transfers touching our wallets
const ledger = [];
for (const x of data) {
  for (const t of (x.realUSDT || [])) {
    const from = (t.from || '').toLowerCase(), to = (t.to || '').toLowerCase();
    const label = Object.entries(W).find(([k, v]) => v === from)?.[0] || Object.entries(W).find(([k, v]) => v === to)?.[0];
    if (!label) continue;
    ledger.push({ time: x.time, block: x.block, from, to, amt: t.amt, hash: x.hash,
      dir: W.Main === to || W.Hanif === to ? 'IN' : 'OUT', wallet: W.Main === to || W.Main === from ? 'Main' : 'Hanif' });
  }
}
ledger.sort((a, b) => a.block - b.block || a.time.localeCompare(b.time));
console.log('=== EXACT USDT LEDGER (real Binance-Peg USDT only, verified receipts) ===');
for (const l of ledger) console.log(`${l.time.slice(0,10)} blk ${l.block} ${l.dir.padEnd(3)} ${String(l.amt).padStart(22)} USDT  ${l.from} -> ${l.to}  ${l.hash}`);

console.log('\n=== CURRENT ON-CHAIN USDT BALANCES (exact) ===');
const now = {};
for (const [n, w] of Object.entries(W)) {
  const d = await call('eth_call', [{ to: USDT, data: '0x70a08231' + pad(w) }, 'latest']);
  now[n] = d ? Number(BigInt(d)) / 1e18 : null;
  console.log(`  ${n.padEnd(6)} ${w}  = ${now[n]} USDT`);
  await sleep(120);
}
fs.writeFileSync('/tmp/final_recon.json', JSON.stringify({ ledger, balances: now }, null, 1));
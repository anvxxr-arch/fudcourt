import fs from 'node:fs';
const RPCs = ['https://bsc.blockrazor.xyz', 'https://1rpc.io/bnb', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const pad = a => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const W = { Main: '0x6816ba2cb2bc013a78225228a153586ca63b1548', Hanif: '0xb0be41f0e7f0ad49622b292da1322c2bea46fa1b' };

async function bal(w) {
  for (let attempt = 0; attempt < 10; attempt++) {
    for (const u of RPCs) {
      try {
        const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDT, data: '0x70a08231' + pad(w) }, 'latest'] }) });
        const j = await r.json();
        if (j.result) return Number(BigInt(j.result)) / 1e18;
      } catch (e) {}
    }
    await sleep(900);
  }
  return null;
}
// native BNB too
async function native(w) {
  for (const u of RPCs) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [w, 'latest'] }) });
      const j = await r.json();
      if (j.result) return Number(BigInt(j.result)) / 1e18;
    } catch (e) {}
  }
  return null;
}

console.log('=== LIVE BALANCES (exact, BSC) ===');
const out = {};
for (const [n, w] of Object.entries(W)) {
  const u = await bal(w); await sleep(600);
  const b = await native(w); await sleep(300);
  out[n] = { usdt: u, bnb: b };
  console.log(`  ${n.padEnd(6)} ${w}`);
  console.log(`         USDT = ${u}`);
  console.log(`         BNB  = ${b}`);
}

// verify the 300 USDT Main->Hanif deposit (block 122016821)
console.log('\n=== VERIFY 300 USDT DEPOSIT (id=1 hash) ===');
const H = '0x9bcfb80ce9e0b4fef9a375f541b12b5c20eb3f55ca233a6a8189a949de480195';
let rc = null;
for (const u of RPCs) {
  try { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [H] }) }); const j = await r.json(); if (j.result) { rc = j.result; break; } } catch (e) {}
}
if (rc) {
  console.log(`  block=${parseInt(rc.blockNumber, 16)} status=${rc.status} from=${rc.from} to=${rc.to}`);
  const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  for (const l of rc.logs) {
    if (l.address.toLowerCase() === USDT && l.topics[0] === T) {
      console.log(`  USDT Transfer: 0x${l.topics[1].slice(26)} -> 0x${l.topics[2].slice(26)}  ${Number(BigInt(l.data)) / 1e18} USDT`);
    }
  }
} else console.log('  receipt RPC unavailable');
fs.writeFileSync('/tmp/live_balances.json', JSON.stringify(out, null, 1));
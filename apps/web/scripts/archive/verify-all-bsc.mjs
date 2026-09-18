import fs from 'node:fs';

const RPCS = ['https://bsc.blockrazor.xyz', 'https://1rpc.io/bnb', 'https://bsc-dataseed.bnbchain.org'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let rr = 0;
async function rpc(m, p) {
  for (let i = 0; i < RPCS.length; i++) {
    const u = RPCS[(rr + i) % RPCS.length];
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) });
      const j = await r.json();
      if (j.result !== undefined && j.result !== null) { rr++; return j.result; }
    } catch (e) {}
  }
  return null;
}
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MAIN = '0x6816ba2cb2bc013a78225228a153586ca63b1548';
const HANIF = '0xb0be41f0e7f0ad49622b292da1322c2bea46fa1b';

const txt = fs.readFileSync('/home/dwizzy/wallet_combined_2months_enriched.csv', 'utf8').replace(/\r/g, '');
const lines = txt.split('\n').filter(l => l.trim());
const hdr = lines[0].split(',');
const recs = lines.slice(1).map(l => { const p = l.split(','); const o = {}; hdr.forEach((h, i) => o[h] = p[i]); return o; });
const bsc = recs.filter(r => r.chain === 'BSC' && r.hash && r.hash.startsWith('0x'));

console.log('BSC rows with hash:', bsc.length);
const results = [];
for (const r of bsc) {
  const rc = await rpc('eth_getTransactionReceipt', [r.hash]);
  if (!rc) { results.push({ ...r, status: 'RPC_FAIL' }); await sleep(120); continue; }
  const transfers = (rc.logs || []).map(l => ({
    contract: l.address.toLowerCase(),
    isRealUSDT: l.address.toLowerCase() === USDT,
    topic0: l.topics[0],
    from: l.topics[1] ? '0x' + l.topics[1].slice(26) : null,
    to: l.topics[2] ? '0x' + l.topics[2].slice(26) : null,
    amt: (() => { try { return Number(BigInt(l.data)) / 1e18; } catch (e) { return null; } })(),
  }));
  results.push({
    time: r.time, type: r.type, asset: r.asset, amount: r.amount, usd: r.usd_value, dir: r.direction, hash: r.hash,
    block: parseInt(rc.blockNumber, 16), status: rc.status, txFrom: rc.from,
    realUSDT: transfers.filter(t => t.isRealUSDT),
    fakeTokens: [...new Set(transfers.filter(t => !t.isRealUSDT && t.topic0 === T).map(t => t.contract))],
  });
  await sleep(110);
}
fs.writeFileSync('/tmp/bsc_verified.json', JSON.stringify(results, null, 1));

console.log('\n=== REAL USDT TRANSFERS (verified on-chain) ===');
for (const x of results) {
  if (x.status === 'RPC_FAIL') { console.log('RPC_FAIL', x.time, x.hash.slice(0, 20)); continue; }
  for (const t of x.realUSDT || []) {
    console.log(`${x.time} | blk ${x.block} | ${t.amt} USDT | ${t.from} -> ${t.to} | ${x.hash}`);
  }
}
console.log('\n=== FAKE/HOMOGLYPH TOKEN CONTRACTS SEEN ===');
const fakeAgg = {};
for (const x of results) for (const f of x.fakeTokens || []) fakeAgg[f] = (fakeAgg[f] || 0) + 1;
for (const [k, v] of Object.entries(fakeAgg)) console.log(`  ${k}  (${v} txs)  realUSDT=${k === USDT}`);
console.log('\nfake contracts total:', Object.keys(fakeAgg).length);
import fs from 'node:fs';
const RPC = 'https://bsc-dataseed.bnbchain.org';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const MAIN = '0x6816ba2cb2bc013a78225228a153586ca63b1548';
const HANIF = '0xb0be41f0e7f0ad49622b292da1322c2bea46fa1b';
const pad = (a) => '0x' + a.toLowerCase().replace('0x','').padStart(64, '0');
const TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
const ts = (h) => new Date(parseInt(h,16)*1000).toISOString();

const latest = parseInt(await rpc('eth_blockNumber', []), 16);
const FROM = '0x' + (latest - 2000000).toString(16);
console.log('latest block', latest, 'from', FROM);

const out = [];
for (const [label, tIdx, addr] of [['OUT from MAIN', true, MAIN], ['IN to MAIN', false, MAIN], ['IN to HANIF', false, HANIF]]) {
  out.push(`\n=== ${label} (${addr}) ===`);
  let res;
  try {
    res = await rpc('eth_getLogs', [{ fromBlock: FROM, toBlock: 'latest', address: USDT,
      topics: [TOPIC, tIdx ? pad(addr) : null, tIdx ? null : pad(addr)] }]);
  } catch (e) { out.push('ERR ' + e.message); continue; }
  out.push(`logs: ${res.length}`);
  for (const l of res) {
    const from = '0x' + l.topics[1].slice(26);
    const to = '0x' + l.topics[2].slice(26);
    const amt = Number(BigInt(l.data)) / 1e18;
    out.push(`${ts(l.blockNumber)} blk=${parseInt(l.blockNumber,16)} ${amt.toFixed(6)} USDT from=${from} to=${to} tx=${l.transactionHash} logIdx=${parseInt(l.logIndex,16)}`);
  }
}
console.log(out.join('\n'));
fs.writeFileSync('/tmp/bsc_usdt_logs.txt', out.join('\n'));
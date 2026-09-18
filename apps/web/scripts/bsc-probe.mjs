import fs from 'node:fs';
const RPCS = ['https://bsc.publicnode.com','https://bsc-dataseed1.defibit.io','https://binance.llamarpc.com','https://bsc-rpc.publicnode.com'];
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const MAIN = '0x6816ba2cb2bc013a78225228a153586ca63b1548';
const HANIF = '0xb0be41f0e7f0ad49622b292da1322c2bea46fa1b';
const pad = (a) => '0x' + a.toLowerCase().replace('0x','').padStart(64, '0');
const TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(url + ' ' + JSON.stringify(j.error));
  return j.result;
}
let ok = null;
for (const u of RPCS) { try { const n = await rpc(u,'eth_blockNumber',[]); console.log('OK', u, parseInt(n,16)); ok = u; break; } catch(e) { console.log('FAIL', u, e.message.slice(0,120)); } }
if (!ok) process.exit(1);
const latest = parseInt(await rpc(ok,'eth_blockNumber',[]), 16);
fs.writeFileSync('/tmp/bsc_rpc.txt', ok + ' ' + latest);
console.log('using', ok, 'latest', latest);
// test chunk size
for (const size of [5000, 20000, 100000]) {
  try {
    const res = await rpc(ok,'eth_getLogs',[{ fromBlock:'0x'+(latest-size).toString(16), toBlock:'latest', address: USDT, topics:[TOPIC, pad(MAIN)] }]);
    console.log('chunk', size, 'OK logs=', res.length);
  } catch(e) { console.log('chunk', size, 'ERR', e.message.slice(0,140)); }
}
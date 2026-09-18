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
const data = JSON.parse(fs.readFileSync('/tmp/bsc_verified.json', 'utf8'));
const REAL = '0x55d398326f99059ff775485246999027b3197955';

// identify every token contract: symbol, name, decimals
const contracts = [...new Set(data.flatMap(x => (x.fakeTokens || [])))];
const meta = {};
for (const c of contracts) {
  const call = async (sel) => { const r = await rpc('eth_call', [{ to: c, data: sel }, 'latest']); if (!r || r === '0x') return null;
    try { const hex = r.slice(2); const len = parseInt(hex.slice(64, 128), 16); if (!len || len > 100) return null;
      const s = Buffer.from(hex.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/\0/g, ''); return s; } catch (e) { return null; } };
  const sym = await call('0x95d89b41'); await sleep(60);
  const nam = await call('0x06fdde03'); await sleep(60);
  const dec = await rpc('eth_call', [{ to: c, data: '0x313ce567' }, 'latest']);
  meta[c] = { symbol: sym, name: nam, decimals: dec && dec !== '0x' ? parseInt(dec, 16) : null };
}
fs.writeFileSync('/tmp/token_meta.json', JSON.stringify(meta, null, 1));
console.log('=== TOKEN CONTRACT IDENTITY (on-chain symbol/name) ===');
for (const [c, m] of Object.entries(meta)) {
  const isReal = c === REAL;
  console.log(`${isReal ? '[REAL USDT]' : '[OTHER]   '} ${c}  sym=${JSON.stringify(m.symbol)}  name=${JSON.stringify(m.name)}  dec=${m.decimals}`);
}
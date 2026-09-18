import { execSync } from 'child_process';

const KEY = 'RWwP0wKxdtABmUNcxTmuH';
const URL = `https://bnb-mainnet.g.alchemy.com/v2/${KEY}`;
const Hanif = '0xb0be41f0e7f0ad49622b292da1322c2bea46fa1b';
const Main = '0x6816ba2cb2bc013a78225228a153586ca63b1548';

function call(m, p) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p });
  const cmd = `curl -s -X POST '${URL}' -H 'Content-Type: application/json' -d '${body.replace(/'/g, "'\\''")}'`;
  try {
    const r = execSync(cmd, { timeout: 30000 }).toString();
    const j = JSON.parse(r);
    if (j.error) return { error: j.error };
    return j.result;
  } catch (e) { return { error: e.message }; }
}

function main() {
  // Get ALL Hanif outgoing transfers (full history, all pages)
  console.log('=== HANIF COMPLETE OUTGOING HISTORY ===');
  let pageKey = null;
  let hanifOut = [];
  do {
    const params = {
      fromAddress: Hanif,
      contractAddresses: ['0x55d398326f99059ff775485246999027b3197955'],
      category: ['erc20'],
      withMetadata: true,
      excludeZeroValue: false,
      maxCount: '0x64'
    };
    if (pageKey) params.pageKey = pageKey;
    
    const result = call('alchemy_getAssetTransfers', [params]);
    if (result.error) { console.log('error:', result.error); break; }
    
    const transfers = result.transfers || [];
    hanifOut.push(...transfers);
    pageKey = result.pageKey;
  } while (pageKey);
  
  // Show all recent transfers (after block 122016821)
  const recent = hanifOut.filter(t => parseInt(t.blockNum, 16) >= 122016821);
  console.log('Recent Hanif outgoing:');
  for (const t of recent) {
    console.log(`  ${t.metadata.blockTimestamp} blk ${t.blockNum} -> ${t.to} ${t.value} USDT [${t.hash.slice(0,20)}]`);
  }

  // Find the 300 USDT forward tx
  const forward300 = hanifOut.find(t => parseInt(t.blockNum, 16) >= 122016821 && Math.abs(t.value - 300) < 0.01);
  if (forward300) {
    console.log('\n=== 300 USDT FORWARD TX ===');
    console.log(`Hash: ${forward300.hash}`);
    console.log(`To: ${forward300.to}`);
    console.log(`Value: ${forward300.value} USDT`);
    console.log(`Block: ${forward300.blockNum}`);
    console.log(`Timestamp: ${forward300.metadata.blockTimestamp}`);
    
    const rc = call('eth_getTransactionReceipt', [forward300.hash]);
    if (rc && !rc.error) {
      console.log(`Status: ${rc.status}`);
      console.log(`Gas used: ${parseInt(rc.gasUsed, 16)}`);
    }
  } else {
    console.log('No exact 300 USDT forward found, checking all recent...');
  }

  // Get current balances of all known addresses
  console.log('\n=== CURRENT BALANCES (Alchemy) ===');
  const USDT = '0x55d398326f99059ff775485246999027b3197955';
  const pad = a => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  
  const addresses = {
    Main,
    Hanif,
    '0xec5f1817a8fba834fdb444edc1fffa7544d11242': 'ec5f (Hanif main dest)',
    '0x20148ab7597a6ed17129f4ecac2bcbb2c8cbff0f': '20148 (Hanif 2nd dest)',
    '0x82916c48225948887faae3c4b6b819f6bf773ca2': '82916 (Hanif 3rd dest)',
    '0xd0784cd963127c7d2d813bb395b91d98425b4350': 'd0784 (200 dest)',
    '0x787513072f5ed215e14f488325a27185ca0bbec9': '78751 (200 dest)',
    '0x6872b6630a3afcd3117191a8403c2002e13df7de': '6872b (unknown source)',
  };
  
  let total = 0;
  for (const [addr, label] of Object.entries(addresses)) {
    const result = call('eth_call', [{ to: USDT, data: '0x70a08231' + pad(addr) }, 'latest']);
    let bal = null;
    if (result && typeof result === 'string') {
      bal = Number(BigInt(result)) / 1e18;
      total += bal;
    } else if (result && result.error) {
      bal = null;
    }
    console.log(`  ${label}: ${bal ?? 'null'} USDT`);
  }
  console.log(`  TOTAL: ${total.toFixed(8)} USDT`);

  // Get 0x6872b663 outgoing transfers to see if it's an exchange
  console.log('\n=== 0x6872b663 OUTGOING ===');
  const unknownOut = call('alchemy_getAssetTransfers', [{
    fromAddress: '0x6872b6630a3afcd3117191a8403c2002e13df7de',
    contractAddresses: ['0x55d398326f99059ff775485246999027b3197955'],
    category: ['erc20'],
    withMetadata: true,
    excludeZeroValue: false,
    maxCount: '0x0a'
  }]);
  if (unknownOut.transfers) {
    for (const t of unknownOut.transfers) {
      console.log(`  ${t.metadata.blockTimestamp} blk ${t.blockNum} -> ${t.to} ${t.value} USDT`);
    }
  }

  // Get 0x6872b663 incoming transfers
  console.log('\n=== 0x6872b663 INCOMING ===');
  const unknownIn = call('alchemy_getAssetTransfers', [{
    toAddress: '0x6872b6630a3afcd3117191a8403c2002e13df7de',
    contractAddresses: ['0x55d398326f99059ff775485246999027b3197955'],
    category: ['erc20'],
    withMetadata: true,
    excludeZeroValue: false,
    maxCount: '0x0a'
  }]);
  if (unknownIn.transfers) {
    for (const t of unknownIn.transfers) {
      console.log(`  ${t.metadata.blockTimestamp} blk ${t.blockNum} <- ${t.from} ${t.value} USDT`);
    }
  }
}
main();
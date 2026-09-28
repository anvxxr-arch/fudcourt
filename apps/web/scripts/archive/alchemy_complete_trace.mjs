import { execSync } from 'child_process';

const KEY = process.env.ALCHEMY_KEY ?? '';
const URL = `https://bnb-mainnet.g.alchemy.com/v2/${KEY}`;

function call(m, p) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p });
  const cmd = `curl -s -X POST '${URL}' -H 'Content-Type: application/json' -d '${body.replace(/'/g, "'\\''")}'`;
  try {
    const r = execSync(cmd, { timeout: 30000 }).toString();
    const j = JSON.parse(r);
    if (j.error) return null;
    return j.result;
  } catch (e) { return null; }
}

function main() {
  const USDT = '0x55d398326f99059ff775485246999027b3197955';
  const pad = a => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

  // Get ALL balances with individual curl calls to debug
  console.log('=== ALL ADDRESS BALANCES (BSC) ===');
  const addresses = [
    { name: 'Main (0x6816...)', addr: '0x6816ba2cb2bc013a78225228a153586ca63b1548' },
    { name: 'Hanif (0xb0be...)', addr: '0xb0be41f0e7f0ad49622b292da1322c2bea46fa1b' },
    { name: '0x20148ab7 (dest)', addr: '0x20148ab7597a6ed17129f4ecac2bcbb2c8cbff0f' },
    { name: '0xec5f1817 (Hanif dest)', addr: '0xec5f1817a8fba834fdb444edc1fffa7544d11242' },
    { name: '0x82916c48 (Hanif dest)', addr: '0x82916c48225948887faae3c4b6b819f6bf773ca2' },
    { name: '0xd0784cd9 (200 dest)', addr: '0xd0784cd963127c7d2d813bb395b91d98425b4350' },
    { name: '0x78751307 (200 dest)', addr: '0x787513072f5ed215e14f488325a27185ca0bbec9' },
    { name: '0x6872b663 (source to Hanif)', addr: '0x6872b6630a3afcd3117191a8403c2002e13df7de' },
  ];

  let grandTotal = 0;
  for (const a of addresses) {
    const r = call('eth_call', [{ to: USDT, data: '0x70a08231' + pad(a.addr) }, '0x748f798']);
    const bal = r ? Number(BigInt(r)) / 1e18 : null;
    if (bal !== null) grandTotal += bal;
    console.log(`${a.name.padEnd(28)} ${bal !== null ? bal.toFixed(8) : 'null'} USDT`);
  }
  console.log('='.repeat(60));
  console.log(`GRAND TOTAL: ${grandTotal.toFixed(8)} USDT`);

  // Get the 300 USDT forward tx details
  console.log('\n=== 300 USDT FORWARD TX (Main→Hanif→0x20148ab7) ===');
  const hash1 = '0x9bcfb80ce9e0b4fef9a375f541b12b5c20eb3f55ca233a6a8189a949de480195';
  const rc1 = call('eth_getTransactionReceipt', [hash1]);
  if (rc1) {
    console.log(`Main → Hanif: hash=${hash1.slice(0,20)} status=${rc1.status} block=${parseInt(rc1.blockNumber,16)}`);
  }
  
  const hash2 = '0x247403ea175a4a0f2d285c7637b7aed03ade3fdee77fcd6cd34277c438272b5f';
  const rc2 = call('eth_getTransactionReceipt', [hash2]);
  if (rc2) {
    console.log(`Hanif → 0x20148ab7: hash=${hash2.slice(0,20)} status=${rc2.status} block=${parseInt(rc2.blockNumber,16)}`);
  }

  // Get the 350.35 USDT tx details
  console.log('\n=== 350.35 USDT TX (0x6872b663 → Hanif) ===');
  // Get the hash from alchemy
  const hanifIn = call('alchemy_getAssetTransfers', [{
    toAddress: '0xb0be41f0e7f0ad49622b292da1322c2bea46fa1b',
    contractAddresses: [USDT],
    category: ['erc20'],
    withMetadata: true,
    excludeZeroValue: false,
    maxCount: '0x0a'
  }]);
  if (hanifIn && hanifIn.transfers) {
    for (const t of hanifIn.transfers) {
      if (Math.abs(t.value - 350.35) < 0.01 && parseInt(t.blockNum, 16) >= 122016821) {
        console.log(`Hash: ${t.hash}`);
        console.log(`From: ${t.from}`);
        console.log(`To: ${t.to}`);
        console.log(`Value: ${t.value} USDT`);
        console.log(`Block: ${t.blockNum} (${parseInt(t.blockNum, 16)})`);
        console.log(`Timestamp: ${t.metadata.blockTimestamp}`);
        
        const rc = call('eth_getTransactionReceipt', [t.hash]);
        if (rc && !rc.error) {
          console.log(`Status: ${rc.status}`);
          console.log(`Gas used: ${parseInt(rc.gasUsed, 16)}`);
        }
        break;
      }
    }
  }

  // Trace 0x6872b663 source
  console.log('\n=== 0x6872b663 SOURCE TRACE ===');
  const unknownIn = call('alchemy_getAssetTransfers', [{
    toAddress: '0x6872b6630a3afcd3117191a8403c2002e13df7de',
    contractAddresses: [USDT],
    category: ['erc20'],
    withMetadata: true,
    excludeZeroValue: false,
    maxCount: '0x0a'
  }]);
  if (unknownIn && unknownIn.transfers) {
    for (const t of unknownIn.transfers) {
      console.log(`  ${t.metadata.blockTimestamp} <- ${t.from.slice(0,20)} ${t.value} USDT`);
    }
  }

  // Check if 0x6872b663 is a known exchange
  const code = call('eth_getCode', ['0x6872b6630a3afcd3117191a8403c2002e13df7de', 'latest']);
  console.log(`\n0x6872b663 is contract: ${code && code.length > 2}`);
}
main();
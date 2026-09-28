import { execSync } from 'child_process';

const KEY = process.env.ALCHEMY_KEY ?? '';
const URL = `https://bnb-mainnet.g.alchemy.com/v2/${KEY}`;

function call(m, p) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p });
  const cmd = `curl -s -X POST '${URL}' -H 'Content-Type: application/json' -d '${body.replace(/'/g, "'\\''")}'`;
  try {
    const r = execSync(cmd, { timeout: 30000 }).toString();
    const j = JSON.parse(r);
    if (j.error) { console.log('ERROR:', j.error); return null; }
    return j.result;
  } catch (e) { return null; }
}

function main() {
  // Get the 300 USDT forward tx receipt
  console.log('=== 300 USDT FORWARD TX RECEIPT ===');
  const hash = '0x247403ea175a4a0f2d285c7637b7aed03ade3fdee77fcd6cd34277c438272b5f';
  const rc = call('eth_getTransactionReceipt', [hash]);
  if (rc) {
    console.log(`Hash: ${hash}`);
    console.log(`Status: ${rc.status}`);
    console.log(`From: ${rc.from}`);
    console.log(`To: ${rc.to}`);
    console.log(`Gas used: ${parseInt(rc.gasUsed, 16)}`);
    console.log(`Block: ${parseInt(rc.blockNumber, 16)}`);
  }

  // Get current balances
  console.log('\n=== CURRENT BALANCES ===');
  const USDT = '0x55d398326f99059ff775485246999027b3197955';
  const pad = a => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  
  const addrs = {
    'Main': '0x6816ba2cb2bc013a78225228a153586ca63b1548',
    'Hanif': '0xb0be41f0e7f0ad49622b292da1322c2bea46fa1b',
    '0x20148ab7': '0x20148ab7597a6ed17129f4ecac2bcbb2c8cbff0f',
    '0xec5f': '0xec5f1817a8fba834fdb444edc1fffa7544d11242',
    '0xd0784': '0xd0784cd963127c7d2d813bb395b91d98425b4350',
    '0x78751': '0x787513072f5ed215e14f488325a27185ca0bbec9',
  };
  
  let total = 0;
  for (const [label, addr] of Object.entries(addrs)) {
    const result = call('eth_call', [{ to: USDT, data: '0x70a08231' + pad(addr) }, 'latest']);
    const bal = result ? Number(BigInt(result)) / 1e18 : 0;
    total += bal;
    console.log(`${label}: ${bal.toFixed(8)} USDT`);
  }
  console.log(`TOTAL: ${total.toFixed(8)} USDT`);

  // Get the 300 USDT forward tx full details
  console.log('\n=== 300 USDT FORWARD TX FULL ===');
  const tx = call('eth_getTransactionByHash', [hash]);
  if (tx) {
    console.log(`Hash: ${tx.hash}`);
    console.log(`From: ${tx.from}`);
    console.log(`To: ${tx.to}`);
    console.log(`Value: ${tx.value ? Number(BigInt(tx.value)) / 1e18 : 0} BNB`);
    console.log(`Gas: ${parseInt(tx.gas, 16)}`);
    console.log(`Gas price: ${Number(BigInt(tx.gasPrice)) / 1e9} gwei`);
    console.log(`Nonce: ${parseInt(tx.nonce, 16)}`);
    console.log(`Input: ${tx.input.slice(0, 100)}...`);
  }

  // Get the 350.35 USDT forward tx
  console.log('\n=== 350.35 USDT FORWARD TX ===');
  const hash350 = '0x89d2a24aff716efeba';
  // Need full hash - get from alchemy_getAssetTransfers
  const hanifOut = call('alchemy_getAssetTransfers', [{
    fromAddress: '0xb0be41f0e7f0ad49622b292da1322c2bea46fa1b',
    contractAddresses: [USDT],
    category: ['erc20'],
    withMetadata: true,
    excludeZeroValue: false,
    maxCount: '0x14'
  }]);
  
  if (hanifOut && hanifOut.transfers) {
    for (const t of hanifOut.transfers) {
      if (Math.abs(t.value - 350.35) < 0.01) {
        console.log(`Hash: ${t.hash}`);
        console.log(`To: ${t.to}`);
        console.log(`Value: ${t.value} USDT`);
        console.log(`Block: ${t.blockNum} (${parseInt(t.blockNum, 16)})`);
        console.log(`Timestamp: ${t.metadata.blockTimestamp}`);
        break;
      }
    }
  }
}
main();
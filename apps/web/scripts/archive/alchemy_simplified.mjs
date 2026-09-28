import { execSync } from 'child_process';

const KEY = process.env.ALCHEMY_KEY ?? '';
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
  // Get the 300 USDT forward tx from Hanif to 0x20148ab7
  console.log('=== 300 USDT FORWARD FROM HANIF ===');
  const dest = '0x20148ab7597a6ed17129f4ecac2bcbb2c8cbff0f';
  
  // Get the specific tx
  const hanifOut = call('alchemy_getAssetTransfers', [{
    fromAddress: Hanif,
    contractAddresses: ['0x55d398326f99059ff775485246999027b3197955'],
    category: ['erc20'],
    withMetadata: true,
    excludeZeroValue: false,
    maxCount: '0x14'
  }]);
  
  if (hanifOut.transfers) {
    for (const t of hanifOut.transfers) {
      if (parseInt(t.blockNum, 16) >= 122016821) {
        console.log(`${t.metadata.blockTimestamp} blk ${t.blockNum} -> ${t.to} ${t.value} USDT [${t.hash.slice(0,20)}]`);
      }
    }
  }

  // Get the 300 USDT forward tx details
  console.log('\n=== 300 USDT FORWARD TX DETAILS ===');
  if (hanifOut.transfers) {
    for (const t of hanifOut.transfers) {
      if (Math.abs(t.value - 300) < 0.01 && parseInt(t.blockNum, 16) >= 122016821) {
        console.log(`Hash: ${t.hash}`);
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

  // Get the 350.35 USDT forward tx
  console.log('\n=== 350.35 USDT FORWARD TX DETAILS ===');
  if (hanifOut.transfers) {
    for (const t of hanifOut.transfers) {
      if (Math.abs(t.value - 350.35) < 0.01 && parseInt(t.blockNum, 16) >= 122016821) {
        console.log(`Hash: ${t.hash}`);
        console.log(`To: ${t.to}`);
        console.log(`Value: ${t.value} USDT`);
        console.log(`Block: ${t.blockNum} (${parseInt(t.blockNum, 16)})`);
        console.log(`Timestamp: ${t.metadata.blockTimestamp}`);
        break;
      }
    }
  }

  // Get current balance of 0x20148ab7
  console.log('\n=== 0x20148ab7 CURRENT BALANCE ===');
  const USDT = '0x55d398326f99059ff775485246999027b3197955';
  const pad = a => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const destBal = call('eth_call', [{ to: USDT, data: '0x70a08231' + pad(dest) }, 'latest']);
  console.log('Balance:', destBal ? Number(BigInt(destBal)) / 1e18 : 'null', 'USDT');

  // Get current balance of Main
  const mainBal = call('eth_call', [{ to: USDT, data: '0x70a08231' + pad(Main) }, 'latest']);
  console.log('\nMain balance:', mainBal ? Number(BigInt(mainBal)) / 1e18 : 'null', 'USDT');

  // Get current balance of Hanif
  const hanifBal = call('eth_call', [{ to: USDT, data: '0x70a08231' + pad(Hanif) }, 'latest']);
  console.log('Hanif balance:', hanifBal ? Number(BigInt(hanifBal)) / 1e18 : 'null', 'USDT');

  // Total
  const total = (mainBal && hanifBal && destBal) ? 
    (Number(BigInt(mainBal)) + Number(BigInt(hanifBal)) + Number(BigInt(destBal))) / 1e18 : null;
  console.log('Total (Main + Hanif + 0x20148ab7):', total ?? 'null', 'USDT');
}
main();
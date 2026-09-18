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
  // Get the specific tx that moved 300 USDT from Hanif
  console.log('=== TRACE 300 USDT FROM HANIF ===');
  const hanifRecentOut = call('alchemy_getAssetTransfers', [{
    fromAddress: Hanif,
    contractAddresses: ['0x55d398326f99059ff775485246999027b3197955'],
    category: ['erc20'],
    withMetadata: true,
    excludeZeroValue: false,
    maxCount: '0x14'
  }]);
  
  if (hanifRecentOut.transfers) {
    for (const t of hanifRecentOut.transfers) {
      if (parseInt(t.blockNum, 16) >= 122016821) {
        console.log(`${t.metadata.blockTimestamp} blk ${t.blockNum} -> ${t.to} ${t.value} USDT`);
      }
    }
  }

  // Get the full tx receipt for the 300 USDT forward
  console.log('\n=== HANIF 300 USDT FORWARD TX ===');
  // Find the hash from the transfer data
  if (hanifRecentOut.transfers) {
    for (const t of hanifRecentOut.transfers) {
      if (parseInt(t.blockNum, 16) >= 122016821 && t.value > 299) {
        console.log(`Hash: ${t.hash}`);
        const rc = call('eth_getTransactionReceipt', [t.hash]);
        if (rc) {
          console.log(`Status: ${rc.status}`);
          console.log(`From: ${rc.from}`);
          console.log(`To: ${rc.to}`);
          console.log(`Gas used: ${parseInt(rc.gasUsed, 16)}`);
        }
        break;
      }
    }
  }

  // Get current balances of ALL Hanif destination addresses
  console.log('\n=== CURRENT BALANCES OF DESTINATIONS ===');
  const USDT = '0x55d398326f99059ff775485246999027b3197955';
  const pad = a => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  
  const addrs = [
    '0xec5f1817a8fba834fdb444edc1fffa7544d11242',
    '0x20148ab7597a6ed17129f4ecac2bcbb2c8cbff0f',
    '0x82916c48225948887faae3c4b6b819f6bf773ca2',
    '0xd0784cd963127c7d2d813bb395b91d98425b4350',
    '0x787513072f5ed215e14f488325a27185ca0bbec9'
  ];
  
  for (const addr of addrs) {
    const bal = call('eth_call', [{ to: USDT, data: '0x70a08231' + pad(addr) }, 'latest']);
    console.log(`${addr}: ${bal ? Number(BigInt(bal)) / 1e18 : 'null'} USDT`);
  }

  // Compute total USDT held by Main + Hanif + all known destinations
  console.log('\n=== TOTAL USDT FOOTPRINT ===');
  let total = 0;
  for (const addr of [Main, Hanif, ...addrs]) {
    const bal = call('eth_call', [{ to: USDT, data: '0x70a08231' + pad(addr) }, 'latest']);
    if (bal) total += Number(BigInt(bal)) / 1e18;
  }
  console.log('Total USDT across all known addresses:', total.toFixed(8));

  // Get the balance of address 0x6872b663... (the one that sent 350 USDT to Hanif)
  console.log('\n=== ADDRESS 0x6872b663... ANALYSIS ===');
  const unknownAddr = '0x6872b6630a3afcd3117191a8403c2002e13df7de';
  const unknownBal = call('eth_call', [{ to: USDT, data: '0x70a08231' + pad(unknownAddr) }, 'latest']);
  const unknownCode = call('eth_getCode', [unknownAddr, 'latest']);
  console.log('Balance:', unknownBal ? Number(BigInt(unknownBal)) / 1e18 : 'null');
  console.log('Is contract:', unknownCode && unknownCode.length > 2);
}
main();
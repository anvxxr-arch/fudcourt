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
  // Get ALL Hanif incoming transfers (who sent to Hanif)
  console.log('=== HANIF INCOMING TRANSFERS ===');
  let pageKey = null;
  let allIncoming = [];
  do {
    const params = {
      toAddress: Hanif,
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
    console.log('Page:', transfers.length, 'transfers');
    for (const t of transfers) {
      console.log(`  ${t.metadata.blockTimestamp} blk ${t.blockNum} <- ${t.from} ${t.value} USDT`);
    }
    allIncoming.push(...transfers);
    pageKey = result.pageKey;
  } while (pageKey);
  
  console.log(`\nTotal Hanif incoming: ${allIncoming.length}`);

  // Get ALL Main incoming transfers
  console.log('\n=== MAIN INCOMING TRANSFERS ===');
  pageKey = null;
  let mainIncoming = [];
  do {
    const params = {
      toAddress: Main,
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
    console.log('Page:', transfers.length, 'transfers');
    for (const t of transfers) {
      console.log(`  ${t.metadata.blockTimestamp} blk ${t.blockNum} <- ${t.from} ${t.value} USDT`);
    }
    mainIncoming.push(...transfers);
    pageKey = result.pageKey;
  } while (pageKey);
  
  console.log(`\nTotal Main incoming: ${mainIncoming.length}`);

  // Also get the destination address info
  console.log('\n=== DESTINATION ADDRESSES ===');
  const addrs = ['0xec5f1817a8fba834fdb444edc1fffa7544d11242', '0x20148ab7597a6ed17129f4ecac2bcbb2c8cbff0f', '0x82916c48225948887faae3c4b6b819f6bf773ca2'];
  for (const addr of addrs) {
    const code = call('eth_getCode', [addr, 'latest']);
    const nonce = call('eth_getTransactionCount', [addr, 'latest']);
    console.log(`\n${addr}:`);
    console.log(`  isContract: ${code && code.length > 2}`);
    console.log(`  nonce: ${nonce ? Number(BigInt(nonce)) : 'null'}`);
  }

  // Check 200 USDT destinations
  console.log('\n=== 200 USDT DESTINATIONS ===');
  const dest200 = ['0xd0784cd963127c7d2d813bb395b91d98425b4350', '0x787513072f5ed215e14f488325a27185ca0bbec9'];
  for (const addr of dest200) {
    const code = call('eth_getCode', [addr, 'latest']);
    const nonce = call('eth_getTransactionCount', [addr, 'latest']);
    console.log(`\n${addr}:`);
    console.log(`  isContract: ${code && code.length > 2}`);
    console.log(`  nonce: ${nonce ? Number(BigInt(nonce)) : 'null'}`);
  }
}
main();
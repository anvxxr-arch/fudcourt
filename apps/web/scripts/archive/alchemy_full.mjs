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
  // Get ALL Hanif outgoing transfers (paginated)
  console.log('=== HANIF ALL OUTGOING TRANSFERS (USDT) ===');
  let pageKey = null;
  let allTransfers = [];
  do {
    const params = {
      fromAddress: Hanif,
      contractAddresses: ['0x55d398326f99059ff775485246999027b3197955'],
      category: ['erc20'],
      withMetadata: true,
      excludeZeroValue: false,
      maxCount: '0x64' // 100 per page
    };
    if (pageKey) params.pageKey = pageKey;
    
    const result = call('alchemy_getAssetTransfers', [params]);
    if (result.error) { console.log('error:', result.error); break; }
    
    const transfers = result.transfers || [];
    console.log('Page:', transfers.length, 'transfers');
    for (const t of transfers) {
      console.log(`  ${t.metadata.blockTimestamp} blk ${t.blockNum} -> ${t.to} ${t.value} USDT`);
    }
    allTransfers.push(...transfers);
    pageKey = result.pageKey;
  } while (pageKey);
  
  console.log(`\nTotal Hanif transfers: ${allTransfers.length}`);

  // Filter for recent (after Sep 15, block 122016821)
  console.log('\n=== RECENT HANIF TRANSFERS (after Sep 15) ===');
  const recent = allTransfers.filter(t => parseInt(t.blockNum, 16) >= 122016821);
  for (const t of recent) {
    console.log(`  ${t.metadata.blockTimestamp} blk ${t.blockNum} -> ${t.to} ${t.value} USDT`);
  }

  // Get ALL Main outgoing transfers
  console.log('\n=== MAIN ALL OUTGOING TRANSFERS (USDT) ===');
  pageKey = null;
  let mainTransfers = [];
  do {
    const params = {
      fromAddress: Main,
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
      console.log(`  ${t.metadata.blockTimestamp} blk ${t.blockNum} -> ${t.to} ${t.value} USDT`);
    }
    mainTransfers.push(...transfers);
    pageKey = result.pageKey;
  } while (pageKey);
  
  console.log(`\nTotal Main transfers: ${mainTransfers.length}`);

  // Check the destination address
  console.log('\n=== DESTINATION ADDRESS ANALYSIS ===');
  const dest = '0xec5f1817a8fba834fdb444edc1fffa7544d11242';
  const code = call('eth_getCode', [dest, 'latest']);
  const nonce = call('eth_getTransactionCount', [dest, 'latest']);
  console.log(`Destination: ${dest}`);
  console.log(`Is contract: ${code && code.length > 2}`);
  console.log(`Nonce: ${nonce ? Number(BigInt(nonce)) : 'null'}`);
}
main();
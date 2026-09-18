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
  // Full history of 0x20148ab7597a6ed17129f4ecac2bcbb2c8cbff0f
  console.log('=== 0x20148ab7 FULL OUTGOING HISTORY ===');
  const dest = '0x20148ab7597a6ed17129f4ecac2bcbb2c8cbff0f';
  let pageKey = null;
  let allOut = [];
  do {
    const params = {
      fromAddress: dest,
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
    allOut.push(...transfers);
    pageKey = result.pageKey;
  } while (pageKey);
  
  console.log(`Total outgoing from 0x20148ab7: ${allOut.length}`);
  for (const t of allOut.slice(0, 20)) {
    console.log(`  ${t.metadata.blockTimestamp} blk ${t.blockNum} -> ${t.to} ${t.value} USDT`);
  }

  // Full incoming history of 0x20148ab7
  console.log('\n=== 0x20148ab7 FULL INCOMING HISTORY ===');
  pageKey = null;
  let allIn = [];
  do {
    const params = {
      toAddress: dest,
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
    allIn.push(...transfers);
    pageKey = result.pageKey;
  } while (pageKey);
  
  console.log(`Total incoming to 0x20148ab7: ${allIn.length}`);
  for (const t of allIn.slice(0, 20)) {
    console.log(`  ${t.metadata.blockTimestamp} blk ${t.blockNum} <- ${t.from} ${t.value} USDT`);
  }

  // Compute total USDT received by 0x20148ab7 from Hanif
  const fromHanif = allIn.filter(t => t.from === Hanif);
  const totalFromHanif = fromHanif.reduce((s, t) => s + t.value, 0);
  console.log(`\nTotal USDT received by 0x20148ab7 from Hanif: ${totalFromHanif}`);

  // Compute total USDT received by 0x20148ab7 from Main
  const fromMain = allIn.filter(t => t.from === Main);
  const totalFromMain = fromMain.reduce((s, t) => s + t.value, 0);
  console.log(`Total USDT received by 0x20148ab7 from Main: ${totalFromMain}`);

  // Total received by 0x20148ab7 from ANY address
  const totalReceived = allIn.reduce((s, t) => s + t.value, 0);
  console.log(`Total USDT received by 0x20148ab7 (all): ${totalReceived}`);

  // Total sent by 0x20148ab7
  const totalSent = allOut.reduce((s, t) => s + t.value, 0);
  console.log(`Total USDT sent by 0x20148ab7: ${totalSent}`);

  // Unique counterparties
  const counterparties = new Set(allIn.map(t => t.from));
  console.log(`\nUnique senders to 0x20148ab7: ${counterparties.size}`);
  for (const c of counterparties) console.log(`  ${c}`);

  // Get the 300 USDT forward tx details
  console.log('\n=== 300 USDT FORWARD TX FROM HANIF ===');
  const forward300 = allIn.find(t => Math.abs(t.value - 300) < 0.01 && t.from === Hanif);
  if (forward300) {
    console.log(`Hash: ${forward300.hash}`);
    console.log(`Block: ${forward300.blockNum} (${parseInt(forward300.blockNum, 16)})`);
    console.log(`Timestamp: ${forward300.metadata.blockTimestamp}`);
    console.log(`From: ${forward300.from}`);
    console.log(`To: ${forward300.to}`);
  }

  // Get the tx that sent 350.35 USDT from Hanif
  console.log('\n=== 350.35 USDT FORWARD TX FROM HANIF ===');
  const forward350 = allIn.find(t => Math.abs(t.value - 350.35) < 0.01 && t.from === Hanif);
  if (forward350) {
    console.log(`Hash: ${forward350.hash}`);
    console.log(`Block: ${forward350.blockNum} (${parseInt(forward350.blockNum, 16)})`);
    console.log(`Timestamp: ${forward350.metadata.blockTimestamp}`);
  }

  // Check the unknown address 0x6872b663 that sent to Hanif
  console.log('\n=== 0x6872b663 HISTORY ===');
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
import { execSync } from 'child_process';

const KEY = 'RWwP0wKxdtABmUNcxTmuH';
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

  // Get all balances
  const addresses = {
    'Main (0x6816...)': '0x6816ba2cb2bc013a78225228a153586ca63b1548',
    'Hanif (0xb0be...)': '0xb0be41f0e7f0ad49622b292da1322c2bea46fa1b',
    '0x20148ab7': '0x20148ab7597a6ed17129f4ecac2bcbb2c8cbff0f',
    '0xec5f1817': '0xec5f1817a8fba834fdb444edc1fffa7544d11242',
    '0x82916c48': '0x82916c48225948887faae3c4b6b819f6bf773ca2',
    '0xd0784cd9 (200 dest)': '0xd0784cd963127c7d2d813bb395b91d98425b4350',
    '0x78751307 (200 dest)': '0x787513072f5ed215e14f488325a27185ca0bbec9',
    '0x6872b663 (source)': '0x6872b6630a3afcd3117191a8403c2002e13df7de',
  };

  let total = 0;
  console.log('=== FINAL BALANCES (BSC USDT) ===');
  for (const [label, addr] of Object.entries(addresses)) {
    const r = call('eth_call', [{ to: USDT, data: '0x70a08231' + pad(addr) }, 'latest']);
    const bal = r ? Number(BigInt(r)) / 1e18 : 0;
    total += bal;
    console.log(`${label.padEnd(25)} ${bal.toFixed(8)} USDT`);
  }
  console.log('='.repeat(50));
  console.log(`TOTAL: ${total.toFixed(8)} USDT`);

  // Get Main's net USDT from all known sources
  console.log('\n=== MAIN NET FLOW (from Alchemy) ===');
  const mainOut = call('alchemy_getAssetTransfers', [{
    fromAddress: addresses['Main (0x6816...)'],
    contractAddresses: [USDT],
    category: ['erc20'],
    withMetadata: false,
    excludeZeroValue: false,
    maxCount: '0x64'
  }]);

  let mainTotalOut = 0;
  if (mainOut && mainOut.transfers) {
    for (const t of mainOut.transfers) mainTotalOut += t.value;
  }

  const mainIn = call('alchemy_getAssetTransfers', [{
    toAddress: addresses['Main (0x6816...)'],
    contractAddresses: [USDT],
    category: ['erc20'],
    withMetadata: false,
    excludeZeroValue: false,
    maxCount: '0x64'
  }]);

  let mainTotalIn = 0;
  if (mainIn && mainIn.transfers) {
    for (const t of mainIn.transfers) mainTotalIn += t.value;
  }

  console.log(`Main total IN:  ${mainTotalIn.toFixed(8)} USDT`);
  console.log(`Main total OUT: ${mainTotalOut.toFixed(8)} USDT`);
  console.log(`Main NET:       ${(mainTotalIn - mainTotalOut).toFixed(8)} USDT`);
  console.log(`Main current:   ${call('eth_call', [{ to: USDT, data: '0x70a08231' + pad(addresses['Main (0x6816...)']) }, 'latest']) ? Number(BigInt(call('eth_call', [{ to: USDT, data: '0x70a08231' + pad(addresses['Main (0x6816...)']) }, 'latest']))) / 1e18 : 0} USDT`);

  // Get Hanif net flow
  console.log('\n=== HANIF NET FLOW ===');
  const hanifOut = call('alchemy_getAssetTransfers', [{
    fromAddress: addresses['Hanif (0xb0be...)'],
    contractAddresses: [USDT],
    category: ['erc20'],
    withMetadata: false,
    excludeZeroValue: false,
    maxCount: '0x64'
  }]);

  let hanifTotalOut = 0;
  if (hanifOut && hanifOut.transfers) {
    for (const t of hanifOut.transfers) hanifTotalOut += t.value;
  }

  const hanifIn = call('alchemy_getAssetTransfers', [{
    toAddress: addresses['Hanif (0xb0be...)'],
    contractAddresses: [USDT],
    category: ['erc20'],
    withMetadata: false,
    excludeZeroValue: false,
    maxCount: '0x64'
  }]);

  let hanifTotalIn = 0;
  if (hanifIn && hanifIn.transfers) {
    for (const t of hanifIn.transfers) hanifTotalIn += t.value;
  }

  console.log(`Hanif total IN:  ${hanifTotalIn.toFixed(8)} USDT`);
  console.log(`Hanif total OUT: ${hanifTotalOut.toFixed(8)} USDT`);
  console.log(`Hanif NET:       ${(hanifTotalIn - hanifTotalOut).toFixed(8)} USDT`);

  // Get 0x20148ab7 net flow
  console.log('\n=== 0x20148ab7 NET FLOW ===');
  const destOut = call('alchemy_getAssetTransfers', [{
    fromAddress: addresses['0x20148ab7'],
    contractAddresses: [USDT],
    category: ['erc20'],
    withMetadata: false,
    excludeZeroValue: false,
    maxCount: '0x64'
  }]);

  let destTotalOut = 0;
  if (destOut && destOut.transfers) {
    for (const t of destOut.transfers) destTotalOut += t.value;
  }

  const destIn = call('alchemy_getAssetTransfers', [{
    toAddress: addresses['0x20148ab7'],
    contractAddresses: [USDT],
    category: ['erc20'],
    withMetadata: false,
    excludeZeroValue: false,
    maxCount: '0x64'
  }]);

  let destTotalIn = 0;
  if (destIn && destIn.transfers) {
    for (const t of destIn.transfers) destTotalIn += t.value;
  }

  console.log(`0x20148ab7 total IN:  ${destTotalIn.toFixed(8)} USDT`);
  console.log(`0x20148ab7 total OUT: ${destTotalOut.toFixed(8)} USDT`);
  console.log(`0x20148ab7 NET:       ${(destTotalIn - destTotalOut).toFixed(8)} USDT`);
}
main();
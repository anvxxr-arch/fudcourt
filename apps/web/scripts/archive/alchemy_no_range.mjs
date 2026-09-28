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
  // Test alchemy_getAssetTransfers without block range
  console.log('=== alchemy_getAssetTransfers Hanif (no range) ===');
  const hanifAll = call('alchemy_getAssetTransfers', [{
    fromAddress: Hanif,
    contractAddresses: ['0x55d398326f99059ff775485246999027b3197955'],
    category: ['erc20'],
    withMetadata: true,
    excludeZeroValue: false
  }]);
  console.log('Hanif ALL:', JSON.stringify(hanifAll).slice(0, 3000));

  // Test with Main
  console.log('\n=== alchemy_getAssetTransfers Main (no range) ===');
  const mainAll = call('alchemy_getAssetTransfers', [{
    fromAddress: Main,
    contractAddresses: ['0x55d398326f99059ff775485246999027b3197955'],
    category: ['erc20'],
    withMetadata: true,
    excludeZeroValue: false
  }]);
  console.log('Main ALL:', JSON.stringify(mainAll).slice(0, 3000));

  // Test eth_getLogs with large range on Alchemy
  console.log('\n=== eth_getLogs range test on Alchemy ===');
  const logs = call('eth_getLogs', [{
    address: '0x55d398326f99059ff775485246999027b3197955',
    fromBlock: '0x745d435',
    toBlock: '0x7468e90',
    topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', null, '0x' + Hanif.toLowerCase().replace(/^0x/, '').padStart(64, '0')]
  }]);
  console.log('Logs Hanif RECEIVER (100k range):', JSON.stringify(logs).slice(0, 1000));
}
main();
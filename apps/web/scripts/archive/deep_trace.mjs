import { execSync } from 'child_process';

const BSC_KEY = process.env.ALCHEMY_KEY ?? '';
const BSC_URL = `https://bnb-mainnet.g.alchemy.com/v2/${BSC_KEY}`;
const SOL_KEY = 'ag2w7MCM9NnR6DmG9p6n2f3vX8q1K7yL'; // placeholder
const SOL_URL = `https://solana-mainnet.g.alchemy.com/v2/${SOL_KEY}`;

const MAIN = '0x6816ba2cb2bc013a78225228a153586ca63b1548';
const HANIF = '0xb0be41f0e7f0ad49622b292da1322c2bea46fa1b';
const AKANG = '7KMhEBFjmhhC1B2HqaJC7zvkyx9pJ9ryCXqUnGBThgFP';

function bscCall(m, p) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p });
  const cmd = `curl -s -X POST '${BSC_URL}' -H 'Content-Type: application/json' -d '${body.replace(/'/g, "'\\''")}'`;
  try {
    const r = execSync(cmd, { timeout: 30000 }).toString();
    const j = JSON.parse(r);
    if (j.error) return null;
    return j.result;
  } catch (e) { return null; }
}

function solCall(m, p) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p });
  const cmd = `curl -s -X POST '${SOL_URL}' -H 'Content-Type: application/json' -d '${body.replace(/'/g, "'\\''")}'`;
  try {
    const r = execSync(cmd, { timeout: 30000 }).toString();
    const j = JSON.parse(r);
    if (j.error) return null;
    return j.result;
  } catch (e) { return null; }
}

function main() {
  // === BSC: ALL TOKEN BALANCES ===
  const tokens = [
    { sym: 'USDT', addr: '0x55d398326f99059ff775485246999027b3197955', dec: 18 },
    { sym: 'USDC', addr: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', dec: 18 },
    { sym: 'BUSD', addr: '0xe9e7cea3dedca5984780bafc599bd69add087d56', dec: 18 },
    { sym: 'ETH', addr: '0x2170ed0880ac9a755fd29b2688956bd959f933f8', dec: 18 },
    { sym: 'WBNB', addr: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', dec: 18 },
    { sym: 'BTCB', addr: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', dec: 18 },
    { sym: 'CAKE', addr: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82', dec: 18 },
    { sym: 'ADA', addr: '0x3ee2200efb3400fabb9aacf31297cbdd1d435d47', dec: 18 },
    { sym: 'DOT', addr: '0x7083609fce4d1d8dc0c979aab8c869ea2c873402', dec: 18 },
    { sym: 'XRP', addr: '0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe', dec: 18 },
    { sym: 'LINK', addr: '0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd', dec: 18 },
    { sym: 'UNI', addr: '0xbf5140a22578168fd562dccf235e5d43a02ce9b1', dec: 18 },
    { sym: 'LTC', addr: '0x4338665cbb7b2485a8855a139b75d5e34ab0db94', dec: 18 },
    { sym: 'BCH', addr: '0x8ff795a6f4d97e7887c79bea79aba5cc76444adf', dec: 18 },
    { sym: 'DOGE', addr: '0xba2ae424d960c26247dd6c32edc70b295c744c43', dec: 8 },
    { sym: 'MATIC', addr: '0xcc42724c6683b7e57334c4e856f4c9965ed682bd', dec: 18 },
    { sym: 'AVAX', addr: '0x1ce0c2827e2ef14d5c4f29a091d735a204794041', dec: 18 },
    { sym: 'SOL', addr: '0x570a5d26f7765ecb712c0924e4de545b89fd43df', dec: 18 },
    { sym: 'TRX', addr: '0x85eac5ac2f758618dfa09bdbe0cf174e7d574d5b', dec: 6 },
    { sym: 'SHIB', addr: '0x2859e4544c4bb03966803b044a93563bd2d0dd4d', dec: 18 },
    { sym: 'ATOM', addr: '0x0eb3a705fc54725037cc9e008bdede697f62f2338', dec: 6 },
    { sym: 'TON', addr: '0x76a797a59ba2c17726896976b7b3747bfd1d220f', dec: 9 },
  ];

  const pad = a => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

  console.log('=== MAIN (0x6816...) ALL TOKEN BALANCES ===');
  let mainTotal = 0;
  for (const t of tokens) {
    const r = bscCall('eth_call', [{ to: t.addr, data: '0x70a08231' + pad(MAIN) }, 'latest']);
    if (r && typeof r === 'string' && r !== '0x') {
      const bal = Number(BigInt(r)) / Math.pow(10, t.dec);
      if (bal > 0) {
        console.log(`  ${t.sym}: ${bal.toFixed(8)}`);
        mainTotal += bal;
      }
    }
  }
  console.log(`  TOTAL TOKENS: ${mainTotal > 0 ? 'see above' : 'only dust/zero'}`);

  console.log('\n=== HANIF (0xb0be...) ALL TOKEN BALANCES ===');
  let hanifTotal = 0;
  for (const t of tokens) {
    const r = bscCall('eth_call', [{ to: t.addr, data: '0x70a08231' + pad(HANIF) }, 'latest']);
    if (r && typeof r === 'string' && r !== '0x') {
      const bal = Number(BigInt(r)) / Math.pow(10, t.dec);
      if (bal > 0) {
        console.log(`  ${t.sym}: ${bal.toFixed(8)}`);
        hanifTotal += bal;
      }
    }
  }
  console.log(`  TOTAL TOKENS: ${hanifTotal > 0 ? 'see above' : 'only dust/zero'}`);

  // Get BNB balance
  const mainBnb = bscCall('eth_getBalance', [MAIN, 'latest']);
  const hanifBnb = bscCall('eth_getBalance', [HANIF, 'latest']);
  console.log(`\nMain BNB: ${mainBnb ? Number(BigInt(mainBnb)) / 1e18 : 0}`);
  console.log(`Hanif BNB: ${hanifBnb ? Number(BigInt(hanifBnb)) / 1e18 : 0}`);

  // === SOLANA: AKANG ===
  console.log('\n=== AKANG (Solana) BALANCE ===');
  const solBalance = solCall('getBalance', [AKANG]);
  if (solBalance !== null) {
    console.log(`  SOL: ${solBalance / 1e9}`);
  } else {
    console.log('  Solana RPC not available (need API key)');
  }

  // Get Solana token accounts
  console.log('\n=== AKANG SOLANA TOKEN ACCOUNTS ===');
  const tokenAccounts = solCall('getTokenAccountsByOwner', [AKANG, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }]);
  if (tokenAccounts && tokenAccounts.value) {
    for (const ta of tokenAccounts.value) {
      const info = ta.account.data.parsed.info;
      console.log(`  ${info.mint}: ${info.tokenAmount.uiAmount} (${info.tokenAmount.decimals} decimals)`);
    }
  } else {
    console.log('  No token accounts or RPC unavailable');
  }

  // Get Solana transaction history
  console.log('\n=== AKANG SOLANA RECENT TRANSACTIONS ===');
  const sigs = solCall('getSignaturesForAddress', [AKANG, { limit: 20 }]);
  if (sigs && Array.isArray(sigs)) {
    for (const s of sigs) {
      console.log(`  ${s.signature.slice(0,20)} slot=${s.slot} ${s.blockTime ? new Date(s.blockTime*1000).toISOString() : ''} ${s.memo || ''}`);
    }
  } else {
    console.log('  No signatures or RPC unavailable');
  }

  // === DEEP TRACE: 200 USDT DESTINATIONS ===
  console.log('\n=== 200 USDT DESTINATION ANALYSIS ===');
  const dest200 = [
    { name: 'd0784cd9', addr: '0xd0784cd963127c7d2d813bb395b91d98425b4350' },
    { name: '78751307', addr: '0x787513072f5ed215e14f488325a27185ca0bbec9' },
  ];

  for (const d of dest200) {
    console.log(`\n--- ${d.name} (${d.addr}) ---`);
    const code = bscCall('eth_getCode', [d.addr, 'latest']);
    const nonce = bscCall('eth_getTransactionCount', [d.addr, 'latest']);
    const usdtBal = bscCall('eth_call', [{ to: '0x55d398326f99059ff775485246999027b3197955', data: '0x70a08231' + pad(d.addr) }, 'latest']);
    const bnbBal = bscCall('eth_getBalance', [d.addr, 'latest']);
    console.log(`  isContract: ${code && code.length > 2}`);
    console.log(`  nonce: ${nonce ? Number(BigInt(nonce)) : 'null'}`);
    console.log(`  USDT: ${usdtBal ? Number(BigInt(usdtBal)) / 1e18 : 0}`);
    console.log(`  BNB: ${bnbBal ? Number(BigInt(bnbBal)) / 1e18 : 0}`);

    // Get last 5 outgoing transfers
    const outTransfers = bscCall('alchemy_getAssetTransfers', [{
      fromAddress: d.addr,
      contractAddresses: ['0x55d398326f99059ff775485246999027b3197955'],
      category: ['erc20'],
      withMetadata: true,
      excludeZeroValue: false,
      maxCount: '0x05'
    }]);
    if (outTransfers && outTransfers.transfers && outTransfers.transfers.length > 0) {
      console.log(`  Recent outgoing:`);
      for (const t of outTransfers.transfers) {
        console.log(`    ${t.metadata.blockTimestamp} -> ${t.to.slice(0,20)} ${t.value} USDT`);
      }
    }

    // Get last 5 incoming transfers
    const inTransfers = bscCall('alchemy_getAssetTransfers', [{
      toAddress: d.addr,
      contractAddresses: ['0x55d398326f99059ff775485246999027b3197955'],
      category: ['erc20'],
      withMetadata: true,
      excludeZeroValue: false,
      maxCount: '0x05'
    }]);
    if (inTransfers && inTransfers.transfers && inTransfers.transfers.length > 0) {
      console.log(`  Recent incoming:`);
      for (const t of inTransfers.transfers) {
        console.log(`    ${t.metadata.blockTimestamp} <- ${t.from.slice(0,20)} ${t.value} USDT`);
      }
    }
  }

  // === MAIN NET FLOW BY TOKEN ===
  console.log('\n=== MAIN NET FLOW (ALL TOKENS) ===');
  for (const t of tokens.slice(0, 6)) {
    const mainIn = bscCall('alchemy_getAssetTransfers', [{
      toAddress: MAIN,
      contractAddresses: [t.addr],
      category: ['erc20'],
      withMetadata: false,
      excludeZeroValue: false,
      maxCount: '0x64'
    }]);
    const mainOut = bscCall('alchemy_getAssetTransfers', [{
      fromAddress: MAIN,
      contractAddresses: [t.addr],
      category: ['erc20'],
      withMetadata: false,
      excludeZeroValue: false,
      maxCount: '0x64'
    }]);
    let totalIn = 0, totalOut = 0;
    if (mainIn && mainIn.transfers) for (const tr of mainIn.transfers) totalIn += tr.value;
    if (mainOut && mainOut.transfers) for (const tr of mainOut.transfers) totalOut += tr.value;
    if (totalIn > 0 || totalOut > 0) {
      console.log(`  ${t.sym}: IN=${totalIn.toFixed(4)} OUT=${totalOut.toFixed(4)} NET=${(totalIn-totalOut).toFixed(4)}`);
    }
  }

  // === HANIF NET FLOW BY TOKEN ===
  console.log('\n=== HANIF NET FLOW (ALL TOKENS) ===');
  for (const t of tokens.slice(0, 6)) {
    const hIn = bscCall('alchemy_getAssetTransfers', [{
      toAddress: HANIF,
      contractAddresses: [t.addr],
      category: ['erc20'],
      withMetadata: false,
      excludeZeroValue: false,
      maxCount: '0x64'
    }]);
    const hOut = bscCall('alchemy_getAssetTransfers', [{
      fromAddress: HANIF,
      contractAddresses: [t.addr],
      category: ['erc20'],
      withMetadata: false,
      excludeZeroValue: false,
      maxCount: '0x64'
    }]);
    let totalIn = 0, totalOut = 0;
    if (hIn && hIn.transfers) for (const tr of hIn.transfers) totalIn += tr.value;
    if (hOut && hOut.transfers) for (const tr of hOut.transfers) totalOut += tr.value;
    if (totalIn > 0 || totalOut > 0) {
      console.log(`  ${t.sym}: IN=${totalIn.toFixed(4)} OUT=${totalOut.toFixed(4)} NET=${(totalIn-totalOut).toFixed(4)}`);
    }
  }
}
main();
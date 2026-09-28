import { execSync } from 'child_process';

const KEY = process.env.ALCHEMY_KEY ?? '';

// Chain RPC endpoints
const CHAINS = {
  eth: 'https://eth-mainnet.g.alchemy.com/v2/',
  bsc: 'https://bnb-mainnet.g.alchemy.com/v2/',
  polygon: 'https://polygon-mainnet.g.alchemy.com/v2/',
  avax: 'https://api.avax.network/ext/bc/C/rpc',
  arbitrum: 'https://arb-mainnet.g.alchemy.com/v2/',
  optimism: 'https://opt-mainnet.g.alchemy.com/v2/',
  base: 'https://base-mainnet.g.alchemy.com/v2/',
  linea: 'https://linea-mainnet.g.alchemy.com/v2/',
  scroll: 'https://scroll-mainnet.g.alchemy.com/v2/',
  mantle: 'https://mantle-mainnet.g.alchemy.com/v2/',
  zksync: 'https://zksync-mainnet.g.alchemy.com/v2/',
  blast: 'https://blast-mainnet.g.alchemy.com/v2/',
};

const MAIN = '0x6816ba2cb2bc013a78225228a153586ca63b1548';
const HANIF = '0xb0be41f0e7f0ad49622b292da1322c2bea46fa1b';

// Token addresses per chain
const TOKENS = {
  eth: [
    { sym: 'USDT', addr: '0xdAC17F958D2ee523a2206206994597C13D831ec7', dec: 6 },
    { sym: 'USDC', addr: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', dec: 6 },
    { sym: 'WBTC', addr: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', dec: 8 },
    { sym: 'WETH', addr: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', dec: 18 },
    { sym: 'DAI', addr: '0x6B175474E89094C44Da98b954EedeAC495271d0F', dec: 18 },
    { sym: 'LINK', addr: '0x514910771AF9Ca656af840dff83E8264EcF986CA', dec: 18 },
    { sym: 'UNI', addr: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', dec: 18 },
    { sym: 'AAVE', addr: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', dec: 18 },
    { sym: 'CRV', addr: '0xD533a949740bb3306d119CC777fa900bA034cd52', dec: 18 },
    { sym: 'LDO', addr: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', dec: 18 },
  ],
  bsc: [
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
    { sym: 'DOGE', addr: '0xba2ae424d960c26247dd6c32edc70b295c744c43', dec: 8 },
    { sym: 'MATIC', addr: '0xcc42724c6683b7e57334c4e856f4c9965ed682bd', dec: 18 },
    { sym: 'AVAX', addr: '0x1ce0c2827e2ef14d5c4f29a091d735a204794041', dec: 18 },
    { sym: 'SOL', addr: '0x570a5d26f7765ecb712c0924e4de545b89fd43df', dec: 18 },
  ],
  polygon: [
    { sym: 'USDT', addr: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', dec: 6 },
    { sym: 'USDC', addr: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', dec: 6 },
    { sym: 'WBTC', addr: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', dec: 8 },
    { sym: 'WETH', addr: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', dec: 18 },
    { sym: 'DAI', addr: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', dec: 18 },
    { sym: 'MATIC', addr: '0x0000000000000000000000000000000000001010', dec: 18 }, // native
    { sym: 'LINK', addr: '0xb0897686c545045aFc77CF20eC7A532E3120E0F1', dec: 18 },
    { sym: 'UNI', addr: '0xb33EaAd8d922B1083446DC23f610c2567fB5180f', dec: 18 },
    { sym: 'AAVE', addr: '0xD6DF932A45C0f255f85145f286eA0b292B21C90B', dec: 18 },
    { sym: 'CRV', addr: '0x172370d5Cd63279eFa6d502DAB29171933a610AF', dec: 18 },
  ],
  arbitrum: [
    { sym: 'USDT', addr: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', dec: 6 },
    { sym: 'USDC', addr: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', dec: 6 },
    { sym: 'WBTC', addr: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', dec: 8 },
    { sym: 'WETH', addr: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', dec: 18 },
    { sym: 'DAI', addr: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', dec: 18 },
    { sym: 'ARB', addr: '0x912CE59144191C1204E64559FE8253a0e49E6548', dec: 18 },
    { sym: 'LINK', addr: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', dec: 18 },
    { sym: 'UNI', addr: '0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0', dec: 18 },
    { sym: 'GMX', addr: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a', dec: 18 },
  ],
  optimism: [
    { sym: 'USDT', addr: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', dec: 6 },
    { sym: 'USDC', addr: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', dec: 6 },
    { sym: 'WBTC', addr: '0x68f180fcCe6836688e9084f035309E29Bf0A2095', dec: 8 },
    { sym: 'WETH', addr: '0x4200000000000000000000000000000000000006', dec: 18 },
    { sym: 'DAI', addr: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', dec: 18 },
    { sym: 'OP', addr: '0x4200000000000000000000000000000000000042', dec: 18 },
    { sym: 'LINK', addr: '0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6', dec: 18 },
    { sym: 'UNI', addr: '0x6fd9d7AD17242c41f7131d257212c54A0e816691', dec: 18 },
    { sym: 'VELO', addr: '0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db', dec: 18 },
  ],
  base: [
    { sym: 'USDC', addr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dec: 6 },
    { sym: 'WETH', addr: '0x4200000000000000000000000000000000000006', dec: 18 },
    { sym: 'DAI', addr: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', dec: 18 },
    { sym: 'AERO', addr: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', dec: 18 },
    { sym: 'BRETT', addr: '0x532f27101965dd16442E59d40670FaF5eBB142E4', dec: 18 },
    { sym: 'DEGEN', addr: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', dec: 18 },
  ],
};

function call(chainUrl, m, p) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p });
  const cmd = `curl -s -X POST '${chainUrl}' -H 'Content-Type: application/json' -d '${body.replace(/'/g, "'\\''")}'`;
  try {
    const r = execSync(cmd, { timeout: 15000 }).toString();
    const j = JSON.parse(r);
    if (j.error) return null;
    return j.result;
  } catch (e) { return null; }
}

function main() {
  const pad = a => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

  // Native token addresses for native balance checks
  const NATIVE = {
    eth: 'ETH', bsc: 'BNB', polygon: 'MATIC', arbitrum: 'ETH',
    optimism: 'ETH', base: 'ETH', avax: 'AVAX',
  };

  const allBalances = {};

  for (const [chainName, tokens] of Object.entries(TOKENS)) {
    const url = CHAINS[chainName] + KEY;
    allBalances[chainName] = {};

    // Native balance
    const nativeBal = call(url, 'eth_getBalance', [MAIN, 'latest']);
    if (nativeBal) {
      const nativeSym = NATIVE[chainName] || chainName.toUpperCase();
      const nativeBalNum = Number(BigInt(nativeBal)) / 1e18;
      if (nativeBalNum > 0.0001) {
        allBalances[chainName][nativeSym] = nativeBalNum;
        console.log(`${chainName}: ${nativeSym} = ${nativeBalNum.toFixed(8)}`);
      }
    }

    // Token balances
    for (const t of tokens) {
      const r = call(url, 'eth_call', [{ to: t.addr, data: '0x70a08231' + pad(MAIN) }, 'latest']);
      if (r && typeof r === 'string' && r !== '0x') {
        const bal = Number(BigInt(r)) / Math.pow(10, t.dec);
        if (bal > 0.0001) {
          allBalances[chainName][t.sym] = bal;
          console.log(`${chainName}: ${t.sym} = ${bal.toFixed(8)}`);
        }
      }
    }
  }

  // Solana
  console.log('\n=== SOLANA ===');
  try {
    const solBal = execSync(`curl -s -X POST 'https://api.mainnet-beta.solana.com' -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["7KMhEBFjmhhC1B2HqaJC7zvkyx9pJ9ryCXqUnGBThgFP"]}'`, { timeout: 15000 }).toString();
    const solJson = JSON.parse(solBal);
    const lamports = solJson.result?.value || 0;
    console.log(`SOL: ${(lamports / 1e9).toFixed(8)}`);
  } catch (e) {
    console.log('SOL: unavailable');
  }

  // Bitcoin (using blockstream API)
  console.log('\n=== BITCOIN ===');
  try {
    const btcAddr = 'bc1q...'; // Need to find Main's BTC address
    const btcBal = execSync(`curl -s 'https://blockstream.info/api/address/${btcAddr}'`, { timeout: 15000 }).toString();
    const btcJson = JSON.parse(btcBal);
    const funded = btcJson.chain_stats?.funded_txo_sum || 0;
    const spent = btcJson.chain_stats?.spent_txo_sum || 0;
    console.log(`BTC: ${((funded - spent) / 1e8).toFixed(8)}`);
  } catch (e) {
    console.log('BTC: need address or unavailable');
  }

  // Save balances
  const fs = require('fs');
  fs.writeFileSync('/tmp/all_chain_balances.json', JSON.stringify(allBalances, null, 2));
  console.log('\nSaved to /tmp/all_chain_balances.json');
}
main();
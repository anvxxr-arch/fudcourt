import { execSync } from 'child_process';
import fs from 'fs';

const KEY = 'RWwP0wKxdtABmUNcxTmuH';
const CHAINS = {
  eth: 'https://eth-mainnet.g.alchemy.com/v2/',
  bsc: 'https://bnb-mainnet.g.alchemy.com/v2/',
  polygon: 'https://polygon-mainnet.g.alchemy.com/v2/',
  arbitrum: 'https://arb-mainnet.g.alchemy.com/v2/',
  optimism: 'https://opt-mainnet.g.alchemy.com/v2/',
  base: 'https://base-mainnet.g.alchemy.com/v2/',
  avax: 'https://api.avax.network/ext/bc/C/rpc',
};
const MAIN = '0x6816ba2cb2bc013a78225228a153586ca63b1548';

const TOKENS = {
  eth: [
    { sym: 'USDT', addr: '0xdAC17F958D2ee523a2206206994597C13D831ec7', dec: 6 },
    { sym: 'USDC', addr: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', dec: 6 },
    { sym: 'WBTC', addr: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', dec: 8 },
    { sym: 'WETH', addr: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', dec: 18 },
    { sym: 'DAI', addr: '0x6B175474E89094C44Da98b954EedeAC495271d0F', dec: 18 },
  ],
  bsc: [
    { sym: 'USDT', addr: '0x55d398326f99059ff775485246999027b3197955', dec: 18 },
    { sym: 'USDC', addr: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', dec: 18 },
    { sym: 'BUSD', addr: '0xe9e7cea3dedca5984780bafc599bd69add087d56', dec: 18 },
    { sym: 'ETH', addr: '0x2170ed0880ac9a755fd29b2688956bd959f933f8', dec: 18 },
    { sym: 'BTCB', addr: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', dec: 18 },
  ],
  polygon: [
    { sym: 'USDT', addr: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', dec: 6 },
    { sym: 'USDC', addr: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', dec: 6 },
    { sym: 'WBTC', addr: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', dec: 8 },
    { sym: 'WETH', addr: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', dec: 18 },
    { sym: 'DAI', addr: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', dec: 18 },
    { sym: 'MATIC', addr: '0x0000000000000000000000000000000000001010', dec: 18 },
  ],
  arbitrum: [
    { sym: 'USDT', addr: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', dec: 6 },
    { sym: 'USDC', addr: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', dec: 6 },
    { sym: 'WBTC', addr: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', dec: 8 },
    { sym: 'WETH', addr: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', dec: 18 },
    { sym: 'ARB', addr: '0x912CE59144191C1204E64559FE8253a0e49E6548', dec: 18 },
  ],
  optimism: [
    { sym: 'USDT', addr: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', dec: 6 },
    { sym: 'USDC', addr: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', dec: 6 },
    { sym: 'WBTC', addr: '0x68f180fcCe6836688e9084f035309E29Bf0A2095', dec: 8 },
    { sym: 'WETH', addr: '0x4200000000000000000000000000000000000006', dec: 18 },
    { sym: 'OP', addr: '0x4200000000000000000000000000000000000042', dec: 18 },
  ],
  base: [
    { sym: 'USDC', addr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dec: 6 },
    { sym: 'WETH', addr: '0x4200000000000000000000000000000000000006', dec: 18 },
    { sym: 'AERO', addr: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', dec: 18 },
  ],
};

function call(url, m, p) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p });
  const cmd = `curl -s -X POST '${url}' -H 'Content-Type: application/json' -d '${body.replace(/'/g, "'\\''")}'`;
  try {
    const r = execSync(cmd, { timeout: 15000 }).toString();
    const j = JSON.parse(r);
    if (j.error) return null;
    return j.result;
  } catch (e) { return null; }
}

function main() {
  const pad = a => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const allBalances = {};

  for (const [chainName, tokens] of Object.entries(TOKENS)) {
    const url = CHAINS[chainName] + KEY;
    allBalances[chainName] = {};

    // Native balance
    const nativeBal = call(url, 'eth_getBalance', [MAIN, 'latest']);
    if (nativeBal) {
      const bal = Number(BigInt(nativeBal)) / 1e18;
      if (bal > 0.0001) {
        const sym = chainName === 'polygon' ? 'MATIC' : chainName === 'avax' ? 'AVAX' : 'ETH';
        allBalances[chainName][sym] = bal;
        console.log(`${chainName}: ${sym} = ${bal.toFixed(8)}`);
      }
    }

    // Token balances
    for (const t of tokens) {
      const r = call(url, 'eth_call', [{ to: t.addr, data: '0x70a08231' + pad(MAIN) }, 'latest']);
      if (r && typeof r === 'string' && r !== '0x') {
        const bal = Number(BigInt(r)) / Math.pow(10, t.dec);
        if (bal > 0.001) {
          allBalances[chainName][t.sym] = bal;
          console.log(`${chainName}: ${t.sym} = ${bal.toFixed(8)}`);
        }
      }
    }
  }

  // Solana
  console.log('\n=== SOLANA ===');
  const solBal = call('https://api.mainnet-beta.solana.com', 'getBalance', ['7KMhEBFjmhhC1B2HqaJC7zvkyx9pJ9ryCXqUnGBThgFP']);
  if (solBal !== null) {
    console.log(`SOL: ${(solBal / 1e9).toFixed(8)}`);
  }

  // Avalanche native
  console.log('\n=== AVALANCHE ===');
  const avaxBal = call('https://api.avax.network/ext/bc/C/rpc', 'eth_getBalance', [MAIN, 'latest']);
  if (avaxBal && Number(avaxBal) > 0) {
    console.log(`AVAX: ${(Number(avaxBal) / 1e18).toFixed(8)}`);
  }

  fs.writeFileSync('/tmp/all_chain_balances.json', JSON.stringify(allBalances, null, 2));
  console.log('\nSaved to /tmp/all_chain_balances.json');
}
main();
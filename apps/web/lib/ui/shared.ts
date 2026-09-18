export const C = {
  bg: '#07110f',
  card: '#0d1f1a',
  border: '#1c3a31',
  accent: '#3ddc97',
  green: '#3ddc97',
  dim: '#6b8f82',
  red: '#ff6b6b',
  white: '#e8fff7',
};

export type Asset = {
  id: number; chain: string; asset: string; quantity: number;
  value_usd: number; share_pct?: number; wallet: string; updated_at?: string;
};

export type Wallet = {
  address: string; label: string; chain: string; monitored: number;
  alias: string; emoji: string; color: string; notes: string | null;
};

export const CHAIN_COLOR: Record<string, string> = {
  BSC: '#f0b90b', Ethereum: '#8a92b2', Polygon: '#8247e5',
  Solana: '#14f195', Hyperliquid: '#3ddc97', Base: '#0052ff',
  Arbitrum: '#28a0f0', Optimism: '#ff0420', Binance: '#f0b90b', Fiat: '#888',
};

export const EMOJI_PRESETS = ['💰','🎒','🦊','🐋','🤖','🏦','💳','🔒','🌐','💎','👛','🎮','📈','🛡️','✈️','🍕','🎯','🧊'];
export const COLOR_PRESETS = ['#3ddc97','#f0b90b','#8a92b2','#8247e5','#14f195','#0052ff','#28a0f0','#ff0420','#ff6b6b','#ffd166','#06d6a0','#118ab2'];
export const EVENT_PRESETS = ['Deposit','Withdrawal','Trade','Transfer','Fee','Interest','Airdrop','Payment','Refund','Swap','Other'];

export function buildWalletMap(wallets: Wallet[]) {
  const map: Record<string, Wallet> = {};
  for (const w of wallets) map[w.label] = w;
  return map;
}

export function getAlias(label: string, walletByLabel: Record<string, Wallet>) {
  const w = walletByLabel[label];
  if (!w) return label;
  return `${w.emoji} ${w.alias || w.label}`;
}

export function getColor(label: string, walletByLabel: Record<string, Wallet>) {
  return walletByLabel[label]?.color || C.accent;
}

export function groupBy<T>(items: T[], key: (item: T) => string) {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    if (!groups[k]) groups[k] = [];
    groups[k].push(item);
  }
  return groups;
}

export function groupSum<T>(items: T[], key: (item: T) => string, val: (item: T) => number) {
  const sums: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    sums[k] = (sums[k] || 0) + val(item);
  }
  return sums;
}

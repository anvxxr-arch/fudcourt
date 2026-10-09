import { getJSON } from '@/lib/fetch';
import { MUT_HEADERS } from '@/lib/http';
import type { Asset, Wallet } from '@/lib/format';

export type OverviewTransaction = {
  id: number;
  date: string;
  chain: string;
  asset: string;
  event: string;
  amount_usd: number;
  direction: string;
  memo: string | null;
  wallet_to: string | null;
  hash: string | null;
  url: string | null;
  source: string;
  venue_id: string | null;
  trade_id: string | null;
};

/**
 * A treasury venue — the 12-row reference dimension (`venues` in pg-schema.sql).
 * `transactions.venue_id` points at `id` (and `wallets.chain` matches it
 * case-insensitively: 'BSC' -> 'bsc'). `type` is one of exchange/wallet/bank/other.
 */
export type Venue = {
  id: string;
  name: string;
  type: string;
};

export type OverviewCoin = {
  asset: string;
  total_usd: number;
  total_qty: number;
  chains: number;
  wallets: number;
};

export type OverviewReconRow = {
  wallet: string;
  asset: string;
  current: number;
  in_sum: number;
  out_sum: number;
  expected: number;
  diff: number;
};

export type AllData = {
  assets?: Asset[];
  transactions?: OverviewTransaction[];
  venues?: Venue[];
  period?: string;
  net_worth?: number;
};

export type CoinsData = {
  coins?: OverviewCoin[];
  total?: number;
};

export type ReconData = {
  rows?: OverviewReconRow[];
  wallets?: Wallet[];
};

export type TrackerCoin = {
  baseAsset: string;
  name?: string;
  lastPrice: number;
  priceChangePercent: number | null;
  quoteVolume: number | null;
  marketCap: number;
};

export async function loadOverviewBundle(): Promise<{
  allData: AllData;
  wallets: Wallet[];
  coinsData: CoinsData;
  reconData: ReconData;
}> {
  const [allData, wallets, coinsData, reconData] = await Promise.all([
    getJSON<AllData>('/api/all', { cache: 'no-store' }),
    getJSON<Wallet[]>('/api/wallets', { cache: 'no-store' }).catch((e): Wallet[] => {
      // An empty list and a broken endpoint must not look the same to an operator: this
      // catch is why a 500 on the wallet list rendered as a calm "Wallets (0)".
      console.warn('[overview] /api/wallets failed; the wallet list renders empty', e);
      return [];
    }),
    getJSON<CoinsData>('/api/coins', { cache: 'no-store' }).catch(() => ({ coins: [], total: 0 })),
    getJSON<ReconData>('/api/reconcile', { cache: 'no-store' }).catch(() => ({ rows: [], wallets: [] })),
  ]);
  return { allData, wallets, coinsData, reconData };
}

export function saveWallet(w: unknown): Promise<unknown> {
  return getJSON<unknown>('/api/wallets', { method: 'POST', headers: MUT_HEADERS, body: JSON.stringify(w) });
}

export function fetchTrackerCoins(): Promise<{ coins?: TrackerCoin[] }> {
  return getJSON<{ coins?: TrackerCoin[] }>('/api/markets?sort=mcap&order=desc&limit=50', { cache: 'no-store' });
}

export function deleteTransaction(id: number): Promise<unknown> {
  return getJSON<unknown>(`/api/transactions/${id}`, { method: 'DELETE', headers: MUT_HEADERS });
}

export function bulkDeleteTransactions(ids: number[]): Promise<unknown> {
  return getJSON<unknown>('/api/transactions', { method: 'DELETE', headers: MUT_HEADERS, body: JSON.stringify({ ids }) });
}

export function createTransaction(tx: unknown): Promise<unknown> {
  return getJSON<unknown>('/api/transactions', { method: 'POST', headers: MUT_HEADERS, body: JSON.stringify(tx) });
}

export function patchTransaction(id: number, u: unknown): Promise<unknown> {
  return getJSON<unknown>(`/api/transactions/${id}`, { method: 'PATCH', headers: MUT_HEADERS, body: JSON.stringify(u) });
}

export function bulkPatchTransactions(ids: number[], updates: unknown): Promise<unknown> {
  return getJSON<unknown>('/api/transactions', { method: 'PUT', headers: MUT_HEADERS, body: JSON.stringify({ ids, updates }) });
}

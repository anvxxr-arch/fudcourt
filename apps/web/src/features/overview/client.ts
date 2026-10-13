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
  /**
   * The endpoints that fell back to an empty payload, by name. Returned so the
   * shell can SAY SO on screen instead of rendering an empty board that reads
   * as real data — an empty reconciliation table looks like "everything
   * reconciles" and a zero coin count looks like "no coins", and both are lies
   * when the cause is a failed request.
   */
  failed: string[];
}> {
  const failed: string[] = [];
  const [allData, wallets, coinsData, reconData] = await Promise.all([
    getJSON<AllData>('/api/all', { cache: 'no-store' }),
    getJSON<Wallet[]>('/api/wallets', { cache: 'no-store' }).catch((e): Wallet[] => {
      // An empty list and a broken endpoint must not look the same to an operator: this
      // catch is why a 500 on the wallet list rendered as a calm "Wallets (0)".
      console.warn('[overview] /api/wallets failed; the wallet list renders empty', e);
      failed.push('/api/wallets');
      return [];
    }),
    // These two catches are LOUD on purpose. A silent fallback here is the
    // worst outcome on this surface: `/api/reconcile` failing must never render
    // Reconciliation as zero rows — an empty diff table reads as "everything
    // reconciles", which is the fabrication the house refuses and the exact
    // shape the reconciler's own Rust service guards against with a 500. The
    // console line keeps the real cause (endpoint, status, body) where an
    // operator can see it, `failed` puts it on screen, and the board stays up.
    getJSON<CoinsData>('/api/coins', { cache: 'no-store' }).catch((e): CoinsData => {
      console.warn('[overview] /api/coins failed; the coin directory renders empty', e);
      failed.push('/api/coins');
      return { coins: [], total: 0 };
    }),
    getJSON<ReconData>('/api/reconcile', { cache: 'no-store' }).catch((e): ReconData => {
      console.warn('[overview] /api/reconcile failed; reconciliation renders empty — NOT a clean reconciliation', e);
      failed.push('/api/reconcile');
      return { rows: [], wallets: [] };
    }),
  ]);
  return { allData, wallets, coinsData, reconData, failed };
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

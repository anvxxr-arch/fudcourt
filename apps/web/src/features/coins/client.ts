/**
 * The coin directory's client — the five upstream reads, typed.
 *
 * TYPING / DISPLAY MIRROR ONLY. Every read goes through the collapsed API
 * gateway (`app/(frontend)/api/[...path]/route.ts`), which forwards verbatim to
 * the `:3101` Go sidecar; that sidecar owns every validation (the `mode` table,
 * the required `key`/`slug`/`symbol` params, the slice arithmetic, the 404 on an
 * unknown coin). This file must NEVER grow a guard or a validator: a second one
 * is the one thing that could drift from the sidecar's, which is the same rule
 * `features/risk/client.ts` records for the prediction family.
 *
 * What it does own: the shapes the board renders with (so a component reads a
 * typed row instead of `any`) and the reading of a FAILED upstream, which is an
 * error to surface — never an empty board.
 */
import { getJSON } from '@/lib/fetch';
import type {
  CoinsChangeSource,
  CoinsRow,
  CoinDetail,
  ListingsAnchors,
  ListingsRow,
  ListingsWidgets,
  MarketPairRow,
  OpenInterestRow,
} from './model';

/** A read that either resolved to a payload or failed with a reason — never both. */
export type Source<T> = { data: T | null; error: string | null };

/**
 * One read. A rejection is captured as the error side rather than thrown, so
 * the board can render "the read failed" for THIS panel while the other panels
 * keep their own state: "no rows" and "the read broke" are different claims.
 */
async function read<T>(url: string, signal?: AbortSignal): Promise<Source<T>> {
  try {
    const data = await getJSON<T>(url, { signal, cache: 'no-store' });
    return { data, error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The envelope fields every CryptoRank mode shares. */
export type CryptorankEnvelope = {
  kind: string;
  upstream: string;
  fetchedAt: number;
  cache: string;
  count: number;
  /** Present when upstream states a full table size. */
  upstreamTotal?: number | null;
  /** Slice provenance, as the sidecar words it. */
  slice?: string;
  /** How the change column was obtained, when the mode carries one. */
  changeSource?: CoinsChangeSource;
};

/** `mode=coins` — the all-coins directory (100 of 100). */
export type CoinsEnvelope = CryptorankEnvelope & { kind: 'coins'; rows?: CoinsRow[] };

/** `mode=listings` — the three discovery widgets plus their anchor counts. */
export type ListingsEnvelope = CryptorankEnvelope & {
  kind: 'listings';
  anchor24h?: ListingsAnchors;
  anchor7d?: ListingsAnchors;
  listings?: ListingsWidgets;
};

/** `mode=coin&key=<slug>` — one coin's detail. Unknown key -> upstream 404. */
export type CoinEnvelope = CryptorankEnvelope & { kind: 'coin'; detail?: CoinDetail };

/** The market-pairs page CoinMarketCap ships for one slug. */
export type MarketPairsEnvelope = {
  kind: 'marketPairs';
  upstream: string;
  fetchedAt: number;
  auth: string;
  slug: string;
  start: number;
  limit: number;
  upstreamCode: string;
  upstreamMsg: string;
  upstreamCount?: number;
  data?: {
    id: number;
    name: string;
    symbol: string;
    numMarketPairs: number;
    marketPairs: MarketPairRow[];
  } | null;
};

/** The CoinGlass open-interest read (an ARRAY of exchange rows). */
export type OpenInterestEnvelope = {
  kind: 'openInterest';
  upstream: string;
  fetchedAt: number;
  cipher: string;
  encrypted: boolean;
  upstreamCode: string;
  upstreamMsg: string;
  upstreamCount?: number;
  data?: OpenInterestRow[];
};

/** `mode=coins` — the ranked all-coins directory. */
export function fetchCoins(signal?: AbortSignal): Promise<Source<CoinsEnvelope>> {
  return read<CoinsEnvelope>('/api/cryptorank?mode=coins', signal);
}

/** `mode=listings` — the recently-added / most-searched / most-visited widgets. */
export function fetchListings(signal?: AbortSignal): Promise<Source<ListingsEnvelope>> {
  return read<ListingsEnvelope>('/api/cryptorank?mode=listings', signal);
}

/** `mode=coin&key=…` — one coin's detail (the `key` is the CryptoRank slug). */
export function fetchCoin(key: string, signal?: AbortSignal): Promise<Source<CoinEnvelope>> {
  return read<CoinEnvelope>(`/api/cryptorank?mode=coin&key=${encodeURIComponent(key)}`, signal);
}

/** `mode=marketPairs&slug=…` — CoinMarketCap's pair page for one slug. */
export function fetchMarketPairs(slug: string, signal?: AbortSignal): Promise<Source<MarketPairsEnvelope>> {
  return read<MarketPairsEnvelope>(`/api/coinmarketcap?mode=marketPairs&slug=${encodeURIComponent(slug)}`, signal);
}

/** `mode=openInterest&symbol=…` — CoinGlass OI for one SYMBOL (upper case). */
export function fetchOpenInterest(symbol: string, signal?: AbortSignal): Promise<Source<OpenInterestEnvelope>> {
  return read<OpenInterestEnvelope>(`/api/coinglass?mode=openInterest&symbol=${encodeURIComponent(symbol)}`, signal);
}

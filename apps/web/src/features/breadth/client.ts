/**
 * The breadth boards' client — the five upstream reads, typed.
 *
 * TYPING / DISPLAY MIRROR ONLY. Every read goes through the collapsed API
 * gateway (`app/(frontend)/api/[...path]/route.ts`), which forwards verbatim to
 * the `:3101` Go sidecar; that sidecar owns every validation (the `mode` table,
 * the `key` whitelists, the slice arithmetic). This file must never grow a guard
 * or a validator: a second one is the one thing that could drift from the
 * sidecar's, which is the same rule `features/risk/client.ts` records for the
 * prediction family.
 *
 * What it does own: the shapes the board renders with (so a component reads a
 * typed row instead of `any`) and the reading of a FAILED upstream, which is an
 * error to surface — never an empty board.
 */
import { getJSON } from '@/lib/fetch';
import type {
  BreadthCategoryInfo,
  BreadthCategoryRow,
  BreadthChangeSource,
  BreadthExchangeKey,
  BreadthExchangeRow,
  BreadthLaunchpoolRow,
  BreadthLpKey,
  BreadthNdKey,
  BreadthNodesaleRow,
  BreadthRwaRow,
} from './model';

/** The envelope fields every CryptoRank mode shares. */
export type CryptorankEnvelope = {
  kind: string;
  upstream: string;
  fetchedAt: number;
  cache: string;
  count: number;
  /** Present when upstream states a full table size (rwa, launchpool, nodesale). */
  upstreamTotal?: number | null;
  /** Slice provenance, as the sidecar words it. */
  slice?: string;
  /** How the change column was obtained, when the mode carries one. */
  changeSource?: BreadthChangeSource;
};

/** `mode=rwa` — the RWA index, page 1. */
export type RwaEnvelope = CryptorankEnvelope & { kind: 'rwa'; rwaRows?: BreadthRwaRow[] };
/** `mode=launchpool&key=<past|upcoming|active>`. */
export type LaunchpoolEnvelope = CryptorankEnvelope & { kind: 'launchpool'; launchpoolRows?: BreadthLaunchpoolRow[] };
/** `mode=nodesale&key=<past|active|upcoming>`. */
export type NodesaleEnvelope = CryptorankEnvelope & { kind: 'nodesale'; nodesaleRows?: BreadthNodesaleRow[] };
/** `mode=categories&key=<slug>` — `category` is the header, `rows` the coins. */
export type CategoriesEnvelope = CryptorankEnvelope & {
  kind: 'categories';
  category?: BreadthCategoryInfo;
  rows?: BreadthCategoryRow[];
};
/** `mode=exchanges&key=<variant>` — the ranked venues. */
export type ExchangesEnvelope = CryptorankEnvelope & { kind: 'exchanges'; rows?: BreadthExchangeRow[] };

/** A read that either resolved to a payload or failed with a reason — never both. */
export type Source<T> = { data: T | null; error: string | null };

/**
 * One read. A rejection is captured as the error side rather than thrown, so the
 * board can render "the read failed" for THIS section while the other three keep
 * their own state: "no rows" and "the read broke" are different claims.
 */
async function read<T>(url: string, signal?: AbortSignal): Promise<Source<T>> {
  try {
    const data = await getJSON<T>(url, { signal, cache: 'no-store' });
    return { data, error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** `mode=rwa` — the tokenized real-world-asset index (25 of 210). */
export function fetchRwa(signal?: AbortSignal): Promise<Source<RwaEnvelope>> {
  return read<RwaEnvelope>('/api/cryptorank?mode=rwa', signal);
}

/** `mode=launchpool&key=…` — the launchpool event list for one window. */
export function fetchLaunchpool(key: BreadthLpKey, signal?: AbortSignal): Promise<Source<LaunchpoolEnvelope>> {
  return read<LaunchpoolEnvelope>(`/api/cryptorank?mode=launchpool&key=${key}`, signal);
}

/** `mode=nodesale&key=…` — the node-sale event list for one window. */
export function fetchNodesale(key: BreadthNdKey, signal?: AbortSignal): Promise<Source<NodesaleEnvelope>> {
  return read<NodesaleEnvelope>(`/api/cryptorank?mode=nodesale&key=${key}`, signal);
}

/** `mode=categories&key=…` — one sector's board (header + coins). */
export function fetchCategories(slug: string, signal?: AbortSignal): Promise<Source<CategoriesEnvelope>> {
  return read<CategoriesEnvelope>(`/api/cryptorank?mode=categories&key=${slug}`, signal);
}

/** `mode=exchanges&key=…` — the venue ranking for one variant. */
export function fetchExchanges(key: BreadthExchangeKey, signal?: AbortSignal): Promise<Source<ExchangesEnvelope>> {
  return read<ExchangesEnvelope>(`/api/cryptorank?mode=exchanges&key=${key}`, signal);
}

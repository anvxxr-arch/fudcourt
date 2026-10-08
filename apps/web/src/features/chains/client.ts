/**
 * The chain & ecosystem directory's client — the four upstream reads, typed.
 *
 * TYPING / DISPLAY MIRROR ONLY. Every read goes through the collapsed API
 * gateway (`app/(frontend)/api/[...path]/route.ts`), which forwards verbatim to
 * the `:3101` Go sidecar; that sidecar owns every validation (the `mode` table,
 * the `key` whitelist, the slice arithmetic). This file must never grow a guard
 * or a validator: a second one is the one thing that could drift from the
 * sidecar's, which is the same rule `features/risk/client.ts` records for the
 * prediction family.
 *
 * What it does own: the shapes the board renders with (so a component reads a
 * typed row instead of `any`) and the reading of a FAILED upstream, which is an
 * error to surface — never an empty board.
 */
import { getJSON } from '@/lib/fetch';
import type { ChainDetail, ChainRow, ChainTokenRow, ChainsChangeSource, EcosystemCoinRow, EcosystemDetail, EcosystemRow } from './model';

/** The envelope fields every CryptoRank mode shares. */
export type CryptorankEnvelope = {
  kind: string;
  upstream: string;
  fetchedAt: number;
  cache: string;
  count: number;
  /** Present when upstream states a full table size (the ecosystem index). */
  upstreamTotal?: number | null;
  /** Slice provenance, as the sidecar words it. */
  slice?: string;
  /** How the change column was obtained, when the mode carries one. */
  changeSource?: ChainsChangeSource;
};

/** `mode=blockchains` — the chain directory (277 rows, no pagination). */
export type BlockchainsEnvelope = CryptorankEnvelope & { kind: 'blockchains'; chainRows?: ChainRow[] };
/** `mode=ecosystems` — the ecosystem index (20 of 106 on SSR page 1). */
export type EcosystemsEnvelope = CryptorankEnvelope & { kind: 'ecosystems'; ecosystemRows?: EcosystemRow[] };
/** `mode=chain&key=<slug>` — the chain header (`chain`) plus its token array (`rows`). */
export type ChainEnvelope = CryptorankEnvelope & { kind: 'chain'; chain?: ChainDetail; rows?: ChainTokenRow[] };
/** `mode=ecosystem&key=<slug>` — the ecosystem header (`ecosystem`) plus its coin rows (`rows`). */
export type EcosystemEnvelope = CryptorankEnvelope & { kind: 'ecosystem'; ecosystem?: EcosystemDetail; rows?: EcosystemCoinRow[] };

/** A read that either resolved to a payload or failed with a reason — never both. */
export type Source<T> = { data: T | null; error: string | null };

/**
 * One read. A rejection is captured as the error side rather than thrown, so the
 * board can render "the read failed" for THIS section while the others keep
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

/** `mode=blockchains` — the chain directory the keyed detail is selected from. */
export function fetchBlockchains(signal?: AbortSignal): Promise<Source<BlockchainsEnvelope>> {
  return read<BlockchainsEnvelope>('/api/cryptorank?mode=blockchains', signal);
}

/** `mode=ecosystems` — the ecosystem index (20 of 106). */
export function fetchEcosystems(signal?: AbortSignal): Promise<Source<EcosystemsEnvelope>> {
  return read<EcosystemsEnvelope>('/api/cryptorank?mode=ecosystems', signal);
}

/** `mode=chain&key=<slug>` — one chain's header and its ecosystem tokens. */
export function fetchChain(slug: string, signal?: AbortSignal): Promise<Source<ChainEnvelope>> {
  return read<ChainEnvelope>(`/api/cryptorank?mode=chain&key=${slug}`, signal);
}

/** `mode=ecosystem&key=<slug>` — one ecosystem's header and its coin rows. */
export function fetchEcosystem(slug: string, signal?: AbortSignal): Promise<Source<EcosystemEnvelope>> {
  return read<EcosystemEnvelope>(`/api/cryptorank?mode=ecosystem&key=${slug}`, signal);
}

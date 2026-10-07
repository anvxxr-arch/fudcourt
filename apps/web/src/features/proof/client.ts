/**
 * The proof page's client — one typed read of the public commitment.
 *
 * TYPING ONLY. Every rule about what the envelope may say lives in the server
 * model (`@/lib/proof`); this file re-exports the shape so the board renders a
 * typed envelope instead of `any`, and reads a FAILED request as an error to
 * surface — never as an empty proof. "The treasury is worth nothing" and "the
 * proof could not be read" are different claims and the board must show which.
 */
import { getJSON } from '@/lib/fetch';
import type { ProofEnvelope } from '@/lib/proof';

export type { ProofEnvelope, ProofPublished, ProofRefused, ChainSlice } from '@/lib/proof';

export function fetchProof(signal?: AbortSignal): Promise<ProofEnvelope> {
  return getJSON<ProofEnvelope>('/api/proof', { signal, cache: 'no-store' });
}

import type { Venue } from './client';

/**
 * The `venues` table is the single vocabulary for "where a thing lives", and two
 * writers reference it: `transactions.venue_id` and `wallets.chain`. The index is
 * built in ONE place so the two surfaces cannot resolve it two different ways.
 *
 * Both the verbatim id and a case-folded alias are indexed, because the two writers
 * disagree on case BY CONSTRUCTION: `transactions.venue_id` stores the key verbatim
 * (measured on the live DB: 48/48 resolve exactly), while `wallets.chain` stores a
 * presentation string ('BSC', 'Solana') against keys 'bsc'/'solana' (measured:
 * exact 0/3, folded 3/3). Folding is a READ-side accommodation — the stored value is
 * never rewritten, because `CHAIN_COLOR[w.chain]` keys off it. The 12 ids are
 * case-unique when folded, so an alias cannot shadow a different row (verify with
 * `SELECT lower(id), count(*) FROM venues GROUP BY 1 HAVING count(*) > 1`).
 */
export function buildVenueIndex(venues: Venue[]): Map<string, Venue> {
  const index = new Map<string, Venue>();
  for (const v of venues) {
    if (!v?.id) continue;
    index.set(v.id, v);
    index.set(v.id.toLowerCase(), v);
  }
  return index;
}

/** A raw reference (a `venue_id` or a wallet's `chain`) → its row, or `undefined`. */
export function resolveVenue(index: Map<string, Venue>, raw: string | null | undefined): Venue | undefined {
  if (!raw) return undefined;
  return index.get(raw) ?? index.get(raw.toLowerCase());
}

/** What a surface renders: the vocabulary's own name, and the type it is filed under. */
export function venueLabel(v: Venue): string {
  return `${v.name} · ${v.type}`;
}

import { failInternal, publicJson } from '../_lib/http';
import { treasuryProof } from '@/server/proof';
/**
 * How long the public commitment may be reused. The proof describes the LATEST
 * sync run (`@/server/proof`); the sync writes on a 5-minute cadence, so 300s
 * is the longest a reader can be shown the previous run, and the digest has not
 * changed within that window by construction.
 */
const PROOF_TTL_SECONDS = 300;

/**
 * GET /api/proof — the public proof-of-treasury read.
 *
 * PUBLIC, and deliberately so: it publishes only AGGREGATE facts (a total, a
 * per-chain breakdown, counts) and a SHA-256 commitment to the detail. No wallet
 * address, no per-asset position and no journal row leaves this route — the
 * private holdings are the team's books and stay behind `/api/all` and friends.
 * It is NOT in `@/server/auth`'s `TEAM_API_ROUTES`, which is the single place
 * that decides; a public route is public by omission from that table, not by a
 * flag here.
 *
 * The read refuses rather than fabricating: a snapshot with no observation, or
 * with no holdings, answers a `published: false` envelope with its reason, never
 * a zero total. See `@/lib/proof` for the rules.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<Response> {
  try {
    return publicJson(await treasuryProof(), PROOF_TTL_SECONDS);
  } catch (e: unknown) {
    return failInternal(e);
  }
}

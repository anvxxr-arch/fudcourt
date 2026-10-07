/**
 * proof.ts — the public proof-of-treasury commitment, as a PURE read.
 *
 * WHY A PUBLIC PROOF AT ALL. The treasury's holdings are private: wallet
 * addresses, per-asset positions and the journal behind them are the team's
 * books, and every board that reads them is tier-gated. This is the opposite
 * surface — it publishes AGGREGATE facts only (a total, a per-chain breakdown,
 * counts) plus a COMMITMENT to the detail, so anyone can see the treasury is
 * real and see that a later disclosure will match what was published. The
 * commitment is a SHA-256 over the canonical holdings; the holdings themselves
 * stay private and can be revealed later, at which point anyone can recompute
 * the digest and confirm nothing changed.
 *
 * WHAT THIS MODEL REFUSES. A published total must never be a partial book
 * stated as whole. A holding the snapshot cannot price is NOT counted as $0 —
 * it is NAMED, and the total states how many holdings it covers. A snapshot
 * with no observation, or with no holdings at all, publishes nothing and says
 * why: "there is no treasury to prove" and "the treasury is worth $0" are
 * different claims and only one of them is ever true.
 *
 * The digest is over the FULL snapshot (priced and unpriced alike), because the
 * commitment is to what was actually held, not to the part that happens to be
 * priced. The published total is over the PRICED part, and the envelope carries
 * the coverage so the two can never be read as the same thing.
 *
 * Everything here is pure except `commitmentDigest`, which uses the Web Crypto
 * API — available in the browser, in Node and in the Edge runtime — so the same
 * code runs in the route handler and could run in a client-side verifier.
 */

/** One holdings row, as the read layer hands it to the model. */
export type HoldingRow = {
  chain: string;
  /** A wallet label. Private — it never leaves the digest, never the envelope. */
  wallet: string | null;
  asset: string;
  quantity: number | null;
  valueUsd: number | null;
};

/** One recorded movement, the ledger the snapshot is the running total of. */
export type JournalRow = {
  date: string;
  chain: string;
  asset: string;
  event: string;
  amountUsd: number | null;
  direction: string;
  hash: string | null;
  source: string;
};

export type ChainSlice = {
  chain: string;
  valueUsd: number;
  holdings: number;
  /** Share of the PUBLISHED (priced) total, percent. Null when the total is 0. */
  sharePct: number | null;
};

export type JournalSummary = {
  entries: number;
  /** Entries carrying an on-chain transaction hash. */
  withHash: number;
  from: string | null;
  to: string | null;
};

export type ProofPublished = {
  published: true;
  /** The observation time, ISO. */
  asOf: string;
  /** Sum over the PRICED holdings only. */
  totalUsd: number;
  /** Every holding in the snapshot, priced or not. */
  holdings: number;
  /** Holdings with a finite, positive valuation. */
  priced: number;
  /** Unpriced holdings, named `chain/asset` — never silently dropped. */
  unpriced: string[];
  chains: number;
  wallets: number;
  slices: ChainSlice[];
  /** SHA-256 (hex) over the canonical full snapshot. */
  digest: string;
  /** The canonical form's version tag, so a verifier knows the recipe. */
  format: string;
  journal: JournalSummary;
  /** The stated derivation — what the total covers and what the digest binds. */
  derived: string;
};

export type ProofRefused = {
  published: false;
  asOf: string | null;
  /** Why nothing is published. Always a stated reason, never an empty page. */
  reason: string;
  /** Holdings named as the reason, when the refusal is about specific rows. */
  skipped: string[];
};

export type ProofEnvelope = ProofPublished | ProofRefused;

/** The canonical serialisation's version. A change here invalidates old digests. */
export const PROOF_FORMAT = 'fudcourt-proof/v1';

/** A quantity at fixed precision, or empty when absent. */
const qty = (v: number | null): string => (v === null || !Number.isFinite(v) ? '' : v.toFixed(8));

/** A USD value at fixed precision, or empty when absent. */
const usd = (v: number | null): string => (v === null || !Number.isFinite(v) ? '' : v.toFixed(2));

/** A holding is PRICED when its value is a finite number greater than zero. */
export function isPriced(h: HoldingRow): boolean {
  return h.valueUsd !== null && Number.isFinite(h.valueUsd) && h.valueUsd > 0;
}

/** The public name of a holding — chain and asset, never the wallet. */
export const holdingName = (h: HoldingRow): string => `${h.chain}/${h.asset}`;

/**
 * The canonical string a digest is taken over.
 *
 * Deterministic and ORDER-INDEPENDENT: rows are rendered to one tab-separated
 * line each and the LINES are sorted, so the same holdings serialise identically
 * whatever order the read returned them in. The header binds the version, the
 * observation time and the row count, so a truncated or re-dated snapshot
 * cannot collide with a complete one.
 *
 * The wallet label IS included — this string is the private side of the
 * commitment and never leaves the server. That is the point: the digest fixes
 * the detail (who held what, where) while only the digest is published.
 */
export function canonicalHoldings(rows: readonly HoldingRow[], asOf: string): string {
  const lines = rows
    .map((r) => [r.chain, r.wallet ?? '', r.asset, qty(r.quantity), usd(r.valueUsd)].join('\t'))
    .sort();
  return [`${PROOF_FORMAT}`, `as-of\t${asOf}`, `rows\t${rows.length}`, ...lines].join('\n');
}

/**
 * The SHA-256 of the canonical snapshot, lowercase hex.
 *
 * Web Crypto rather than `node:crypto` on purpose: the route handler, a Bun
 * script and a browser verifier must all be able to run this one function.
 */
export async function commitmentDigest(canonical: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonical);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type ProofInput = {
  holdings: readonly HoldingRow[];
  journal: readonly JournalRow[];
  /** The observation time, ISO — null when the window holds no observation. */
  asOf: string | null;
  /** The commitment digest of `holdings`. Null only when it could not be taken. */
  digest: string | null;
};

/**
 * Build the public envelope from a snapshot. Pure and synchronous — the digest
 * is computed by the caller (see `commitmentDigest`) so this stays testable
 * against fixed input with no crypto in the path.
 *
 * The refusals are FIRST-CLASS and ordered from the most fundamental: no
 * observation and an empty snapshot publish nothing at all; a snapshot that
 * cannot be digested publishes nothing (a proof without its commitment is not a
 * proof). Only then is a total stated — and always with its coverage.
 */
export function buildProof(input: ProofInput): ProofEnvelope {
  const { holdings, journal, asOf, digest } = input;

  if (asOf === null) {
    return {
      published: false,
      asOf: null,
      reason: 'no observation in the window — there is no snapshot to prove',
      skipped: [],
    };
  }
  if (holdings.length === 0) {
    return {
      published: false,
      asOf,
      reason: 'the observation holds no holdings — an empty book is not a zero-valued one',
      skipped: [],
    };
  }
  if (digest === null) {
    return {
      published: false,
      asOf,
      reason: 'no commitment digest could be taken — a proof without its commitment is not a proof',
      skipped: [],
    };
  }

  const unpricedRows = holdings.filter((h) => !isPriced(h));
  const pricedRows = holdings.filter(isPriced);
  const totalUsd = pricedRows.reduce((a, h) => a + (h.valueUsd ?? 0), 0);

  const byChain = new Map<string, { valueUsd: number; holdings: number }>();
  for (const h of pricedRows) {
    const cur = byChain.get(h.chain) ?? { valueUsd: 0, holdings: 0 };
    cur.valueUsd += h.valueUsd ?? 0;
    cur.holdings += 1;
    byChain.set(h.chain, cur);
  }
  const slices: ChainSlice[] = [...byChain.entries()]
    .map(([chain, v]) => ({
      chain,
      valueUsd: v.valueUsd,
      holdings: v.holdings,
      sharePct: totalUsd !== 0 ? (v.valueUsd / totalUsd) * 100 : null,
    }))
    .sort((a, b) => b.valueUsd - a.valueUsd || a.chain.localeCompare(b.chain));

  const wallets = new Set<string>();
  for (const h of holdings) if (h.wallet) wallets.add(h.wallet);

  const dates = journal.map((j) => j.date).filter(Boolean).sort();

  return {
    published: true,
    asOf,
    totalUsd,
    holdings: holdings.length,
    priced: pricedRows.length,
    unpriced: unpricedRows.map(holdingName).sort(),
    chains: new Set(holdings.map((h) => h.chain)).size,
    wallets: wallets.size,
    slices,
    digest,
    format: PROOF_FORMAT,
    journal: {
      entries: journal.length,
      withHash: journal.filter((j) => j.hash !== null && j.hash !== '').length,
      from: dates.length ? dates[0] : null,
      to: dates.length ? dates[dates.length - 1] : null,
    },
    derived:
      `Total covers ${pricedRows.length} of ${holdings.length} holdings; ` +
      `${unpricedRows.length} unpriced${unpricedRows.length ? ' and named below' : ''}. ` +
      `The digest is SHA-256 over the FULL snapshot (${PROOF_FORMAT}) — priced and unpriced alike — ` +
      'published as a commitment: the holdings behind it are private, and a later disclosure ' +
      'reproduces this digest byte for byte.',
  };
}

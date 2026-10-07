/**
 * proof.ts — the read behind the public proof-of-treasury page.
 *
 * One read of the LATEST sync run, turned into the public commitment by the
 * pure model in `@/lib/proof`. This module owns only the database access and
 * the digest; every rule about what may be published lives in the model, so it
 * is unit-tested offline against fixed rows.
 *
 * THE LATEST RUN, NOT THE LIVE TABLE. `asset_history` is the trigger-appended
 * time series; a "run" is the set of rows one sync wrote. The private treasury
 * board sessionizes the series with a 60-second gap rule (see
 * `@/server/treasury`), so this read uses the SAME window — rows within 60s of
 * the newest — which is exactly one run for the 5-minute sync and keeps the two
 * surfaces from disagreeing about which snapshot they are describing.
 *
 * The digest is over the canonical full snapshot (see `canonicalHoldings`),
 * which carries the wallet labels. That string never leaves this module: only
 * the digest is returned, and only the digest is published.
 */
import 'server-only';
import { query, type Row } from './db';
import {
  buildProof,
  canonicalHoldings,
  commitmentDigest,
  type HoldingRow,
  type JournalRow,
  type ProofEnvelope,
} from '@/lib/proof';

/** Two rows further apart than this are different sync runs, not one snapshot. */
const RUN_GAP = "INTERVAL '60 seconds'";

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(String(v)).toISOString());

/** The newest run of `asset_history`, as holding rows. */
async function latestHoldings(): Promise<{ rows: HoldingRow[]; asOf: string | null }> {
  const raw = await query(
    `SELECT chain, coalesce(wallet, '') AS wallet, asset, quantity, value_usd, ts
     FROM asset_history
     WHERE ts >= (SELECT max(ts) FROM asset_history) - ${RUN_GAP}
     ORDER BY chain, wallet, asset`,
  );
  const rows: HoldingRow[] = (raw as Row[]).map((r) => ({
    chain: String(r.chain ?? ''),
    wallet: r.wallet === null || r.wallet === undefined || r.wallet === '' ? null : String(r.wallet),
    asset: String(r.asset ?? ''),
    quantity: num(r.quantity),
    valueUsd: num(r.value_usd),
  }));
  const asOf = raw.length ? iso((raw[0] as Row).ts) : null;
  return { rows, asOf };
}

/** The recorded movements — the ledger the snapshot is the running total of. */
async function journalRows(): Promise<JournalRow[]> {
  const raw = await query(
    `SELECT date, chain, asset, event, amount_usd, direction, hash, source
     FROM transactions
     ORDER BY date DESC, id DESC`,
  );
  return (raw as Row[]).map((r) => ({
    date: r.date === null || r.date === undefined ? '' : String(r.date),
    chain: String(r.chain ?? ''),
    asset: String(r.asset ?? ''),
    event: String(r.event ?? ''),
    amountUsd: num(r.amount_usd),
    direction: String(r.direction ?? ''),
    hash: r.hash === null || r.hash === undefined || r.hash === '' ? null : String(r.hash),
    source: String(r.source ?? ''),
  }));
}

/** The public proof envelope. Never throws for a sparse world — it refuses. */
export async function treasuryProof(): Promise<ProofEnvelope> {
  const [{ rows, asOf }, journal] = await Promise.all([latestHoldings(), journalRows()]);
  const digest = asOf !== null && rows.length > 0 ? await commitmentDigest(canonicalHoldings(rows, asOf)) : null;
  return buildProof({ holdings: rows, journal, asOf, digest });
}

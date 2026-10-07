'use client';

/**
 * The proof of treasury (F11) — `/proof`: the treasury's public commitment.
 *
 * WHAT THIS BOARD MUST NOT DO.
 *  - It must never print a total it cannot stand behind. When the read refuses
 *    (no observation, an empty book, no digest) the page shows the REFUSAL and
 *    its reason — never a zero, never a blank table.
 *  - It must never let a partial total read as the whole book. A holding the
 *    snapshot could not price is NAMED and the total states how many holdings
 *    it covers; the coverage line is not decoration.
 *  - It must never publish the private detail. Only aggregates and the digest
 *    are rendered — no wallet label, no per-asset position, no journal row.
 *  - It must never imply the digest proves on-chain ownership by itself. It is
 *    a commitment to a snapshot: it fixes what was held and lets a later
 *    disclosure be checked against it. The page says exactly that.
 */
import { useEffect, useState } from 'react';
import { alpha, themeColor, fontFamily, fontSize, fontWeight, letterSpacing, lineHeight, radius, space } from '@/styles/tokens';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { EmptyState, ErrorState, Loading } from '@/ui/feedback';
import { Stat } from '@/ui/stat';
import { fetchProof, type ProofEnvelope, type ProofRefused } from './client';

/**
 * Narrow to the refusal arm.
 *
 * A type-guard FUNCTION rather than `!envelope.published`: this project builds
 * with `strict: false`, and a negated boolean-literal discriminant does not
 * narrow the union reliably there. The guard is explicit and cannot be
 * defeated by a compiler flag.
 */
function isRefused(e: ProofEnvelope): e is ProofRefused {
  return e.published === false;
}

/** A USD amount, at cents — the treasury is a book, not a market quote. */
function usd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A share, one decimal, or the em dash when none is stated. */
function pct(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)}%`;
}

/** How long ago an ISO instant was, compactly. */
function ageOf(iso: string | null): string {
  if (iso === null) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const min = ms / 60000;
  if (min < 60) return `${Math.round(min)}m ago`;
  const h = min / 60;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function ProofPage() {
  const [envelope, setEnvelope] = useState<ProofEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchProof(ac.signal).then(
      (e) => !ac.signal.aborted && setEnvelope(e),
      (e: unknown) => !ac.signal.aborted && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => ac.abort();
  }, []);

  if (error !== null) {
    return <ErrorState title="Could not read the treasury proof" detail={error} />;
  }
  if (envelope === null) return <Loading what="the treasury proof" />;

  if (isRefused(envelope)) {
    return (
      <ErrorState
        title="Nothing is published — the proof refuses rather than guess"
        detail={
          `${envelope.reason}.` +
          (envelope.asOf ? ` Last observation: ${envelope.asOf}.` : '') +
          (envelope.skipped.length ? ` Named: ${envelope.skipped.join(' · ')}.` : '')
        }
      />
    );
  }

  const e = envelope;
  const coveragePct = e.holdings > 0 ? (e.priced / e.holdings) * 100 : null;

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
        <Stat
          label="Treasury value"
          value={usd(e.totalUsd)}
          hint={`over ${e.priced} of ${e.holdings} holdings priced`}
          valueSize={fontSize[22]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
        <Stat
          label="As of"
          value={ageOf(e.asOf)}
          hint={e.asOf}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
        <Stat
          label="Composition"
          value={`${e.chains} chains`}
          hint={`${e.wallets} wallets · ${e.holdings} holdings`}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 140px' }}
        />
        <Stat
          label="Ledger behind it"
          value={String(e.journal.entries)}
          hint={
            e.journal.entries === 0
              ? 'no recorded movements'
              : `${e.journal.withHash} with an on-chain hash · ${e.journal.from ?? '—'} → ${e.journal.to ?? '—'}`
          }
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 160px' }}
        />
      </div>

      <div style={{ marginTop: space[12] }}>
        <Card
          title="Commitment"
          subtitle={`SHA-256 over the full snapshot (${e.format}) — the holdings behind it stay private`}
        >
          <div
            style={{
              background: themeColor.bgBase,
              border: `1px solid ${themeColor.separator}`,
              borderRadius: radius[8],
              padding: `${space[12]}px ${space[12]}px`,
              fontFamily: fontFamily.mono,
              fontSize: fontSize[12],
              color: themeColor.labelPrimary,
              wordBreak: 'break-all',
              lineHeight: lineHeight.normal,
              userSelect: 'all',
            }}
          >
            {e.digest}
          </div>
          <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
            This digest fixes the exact set of holdings behind the total above, priced and unpriced alike. The wallet
            labels and per-asset positions it covers are private; a later disclosure of the snapshot reproduces this
            digest byte for byte. It is a commitment, not a proof of ownership on its own — ownership is what the
            ledger's recorded movements carry hashes for.
          </p>
        </Card>
      </div>

      <div style={{ marginTop: space[12] }}>
        <Card title="By chain" subtitle="the priced book, split by chain — the slices sum to the published total">
          {e.slices.length === 0 ? (
            <EmptyState>No chain carries a priced holding in this snapshot.</EmptyState>
          ) : (
            <DataTable
              head={['Chain', 'Value', 'Share', 'Holdings']}
              rows={e.slices.map((s) => ({
                cells: [
                  <span key="c" style={{ fontWeight: fontWeight.semibold }}>{s.chain}</span>,
                  <span key="v">{usd(s.valueUsd)}</span>,
                  <span key="s" style={{ color: themeColor.labelTertiary }}>{pct(s.sharePct)}</span>,
                  <span key="h" style={{ color: themeColor.labelTertiary }}>{s.holdings}</span>,
                ],
              }))}
            />
          )}
        </Card>
      </div>

      {e.unpriced.length > 0 && (
        <div style={{ marginTop: space[12] }}>
          <div
            style={{
              background: alpha(themeColor.orange, 0.08),
              border: `1px solid ${alpha(themeColor.orange, 0.4)}`,
              borderRadius: radius[8],
              padding: `${space[12]}px ${space[12]}px`,
              color: themeColor.labelPrimary,
            }}
          >
            <strong>{e.unpriced.length} holding(s) carry no price</strong>
            <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[12], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
              Named rather than counted as $0 — an unpriced holding is not a worthless one. The published total covers
              the priced {e.priced} of {e.holdings} holdings{coveragePct !== null ? ` (${coveragePct.toFixed(1)}% coverage)` : ''}: {e.unpriced.join(' · ')}.
            </p>
          </div>
        </div>
      )}

      <p style={{ marginTop: space[16], fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        {e.derived}
      </p>

      <div style={{ marginTop: space[12] }}>
        <Card title="What this page does and does not prove" subtitle="stated, so a reader does not have to assume">
          <ul style={{ margin: 0, paddingLeft: space[20], fontSize: fontSize[12], color: themeColor.labelSecondary, lineHeight: lineHeight.loose, letterSpacing: letterSpacing.none }}>
            <li>The total is the sum of the priced holdings in the latest sync snapshot, read from the same time series the private board reads — the two cannot disagree.</li>
            <li>Each chain slice above sums into that total; a reader can add them and get the published figure.</li>
            <li>The digest binds the team to that snapshot: the number cannot be restated later without changing it.</li>
            <li>It does not, by itself, prove on-chain ownership — that is what the recorded movements with hashes in the ledger are for, and those hashes are public to anyone who has them.</li>
            <li>Holdings the snapshot could not price are excluded from the total and named above — the total is never a partial book stated as whole.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}

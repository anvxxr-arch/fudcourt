'use client';

import { useCallback, useEffect, useState } from 'react';
import { themeColor, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { Loading } from '@/ui/feedback';
import { Banner } from '@/ui/banner';
import { loadPnl, loadPriceCoverage, type PnlSummary, type PriceCoverageRow } from './client';
import { DASH, shortTs, toneOf, usd } from './format';
import { Board, Td, Th } from './parts';

/**
 * The P&L board (DR-046). Cost basis and realized/unrealized P&L over the
 * transaction ledger, plus the coverage of the materialized implied-price
 * series.
 *
 * The board is built to show its own limits: a holding with no acquisition on
 * record prints `—` for cost basis (not `0`), and a realized figure that could
 * not be computed — because an OUT matched no open lot — prints `—` with the
 * unmatched proceeds shown beside it. The `unbasis` count in the header is the
 * honest denominator: this many holdings have a value but no cost history, so
 * the totals below them are a floor, not the whole truth.
 */

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ background: themeColor.bgSecondary, border: `1px solid ${themeColor.separator}`, borderRadius: radius[8], padding: space[12], minWidth: 148 }}>
      <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], textTransform: 'uppercase' }}>{label}</div>
      <div style={{ color: color ?? themeColor.labelPrimary, fontSize: fontSize[20], fontWeight: fontWeight.bold, marginTop: space[4] }}>{value}</div>
      {sub && <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginTop: space[4] }}>{sub}</div>}
    </div>
  );
}

/** The realized/unrealized pair, as a signed figure or the honest gap. */
function PnlCell({ v, unmatched, note }: { v: number | null; unmatched?: number; note?: string }) {
  if (v === null) {
    return (
      <span style={{ color: themeColor.labelTertiary }}>
        {DASH}
        {note ? <span style={{ fontSize: fontSize[11] }}> ({note})</span> : null}
        {unmatched && unmatched > 0 ? <span style={{ fontSize: fontSize[11] }}> (unmatched {usd(unmatched)})</span> : null}
      </span>
    );
  }
  return <span style={{ color: toneOf(v) }}>{usd(v)}</span>;
}

export default function PnlPanel() {
  const [summary, setSummary] = useState<PnlSummary | null>(null);
  const [coverage, setCoverage] = useState<PriceCoverageRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [s, c] = await Promise.allSettled([loadPnl(), loadPriceCoverage()]);
    if (s.status === 'fulfilled') setSummary(s.value);
    if (c.status === 'fulfilled') setCoverage(c.value.rows);
    const firstErr = [s, c].find((r) => r.status === 'rejected');
    if (firstErr && firstErr.status === 'rejected') setError(String(firstErr.reason));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const coveredPoints = coverage.reduce((a, r) => a + r.points, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[16] }}>
      {error && <Banner>Some panels failed to load: {error}</Banner>}

      {summary ? (
        <>
          <div style={{ display: 'flex', gap: space[8], flexWrap: 'wrap' }}>
            <Stat label="Cost basis" value={usd(summary.totalCostBasisUsd)} sub={`${summary.rows.filter((r) => r.costBasisUsd !== null).length} holdings with a basis`} />
            <Stat label="Basis value" value={usd(summary.basisCurrentValueUsd)} sub="current value of those holdings" />
            <Stat label="Unrealized P&L" value={usd(summary.totalUnrealizedUsd)} sub="basis value − cost basis" color={toneOf(summary.totalUnrealizedUsd)} />
            <Stat label="Realized P&L" value={usd(summary.totalRealizedUsd)} sub="closed FIFO lots" color={toneOf(summary.totalRealizedUsd)} />
            <Stat label="Portfolio value" value={usd(summary.totalCurrentValueUsd)} sub="all holdings" />
            <Stat label="No cost history" value={String(summary.unbasisAssets)} sub="holdings with value, no basis" color={summary.unbasisAssets > 0 ? themeColor.orange : themeColor.labelPrimary} />
            <Stat label="Stranded" value={String(summary.strandedAssets)} sub="basis known, position closed" color={summary.strandedAssets > 0 ? themeColor.orange : themeColor.labelPrimary} />
            <Stat label="Ledger rows" value={String(summary.txCount)} sub="transactions read" />
          </div>

          <Board
            title="Cost basis & P&L by holding (USD-level FIFO)"
            right={
              <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>
                {summary.rows.length} holdings · {loading ? '⟳' : 'live'}
              </span>
            }
          >
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <Th>Holding</Th>
                    <Th right>In</Th>
                    <Th right>Out</Th>
                    <Th right>Cost basis</Th>
                    <Th right>Current</Th>
                    <Th right>Unrealized</Th>
                    <Th right>Realized</Th>
                    <Th right>Lots</Th>
                    <Th right>Tx</Th>
                  </tr>
                </thead>
                <tbody>
                  {summary.rows.map((r) => (
                    <tr key={`${r.chain}-${r.asset}`}>
                      <Td>
                        <span style={{ color: themeColor.labelSecondary }}>{r.chain}</span> {r.asset}
                      </Td>
                      <Td right color={themeColor.labelTertiary}>{r.inUsd > 0 ? usd(r.inUsd) : DASH}</Td>
                      <Td right color={themeColor.labelTertiary}>{r.outUsd > 0 ? usd(r.outUsd) : DASH}</Td>
                      <Td right color={r.costBasisUsd === null ? themeColor.labelTertiary : themeColor.labelPrimary}>{usd(r.costBasisUsd)}</Td>
                      <Td right color={themeColor.labelSecondary}>{usd(r.currentValueUsd)}</Td>
                      <Td right>
                        <PnlCell v={r.unrealizedUsd} note={r.stranded ? 'stranded' : undefined} />
                      </Td>
                      <Td right>
                        <PnlCell v={r.realizedUsd} unmatched={r.unmatchedOutUsd} />
                      </Td>
                      <Td right color={themeColor.labelTertiary}>{r.lots > 0 ? String(r.lots) : DASH}</Td>
                      <Td right color={themeColor.labelTertiary}>{String(r.txCount)}</Td>
                    </tr>
                  ))}
                  {summary.rows.length === 0 && (
                    <tr>
                      <Td>No holdings or transactions on record.</Td>
                      <Td right>{DASH}</Td>
                      <Td right>{DASH}</Td>
                      <Td right>{DASH}</Td>
                      <Td right>{DASH}</Td>
                      <Td right>{DASH}</Td>
                      <Td right>{DASH}</Td>
                      <Td right>{DASH}</Td>
                      <Td right>{DASH}</Td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Board>

          <Board
            title="Implied price series (materialized into price_history)"
            right={
              <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>
                {coverage.length} symbols · {coveredPoints.toLocaleString('en-US')} points
              </span>
            }
          >
            <div style={{ overflowX: 'auto', maxHeight: 320, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <Th>Symbol</Th>
                    <Th>Source</Th>
                    <Th right>Points</Th>
                    <Th right>First</Th>
                    <Th right>Last</Th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.map((r) => (
                    <tr key={`${r.symbol}-${r.source}`}>
                      <Td>{r.symbol}</Td>
                      <Td color={themeColor.labelTertiary}>{r.source}</Td>
                      <Td right>{r.points.toLocaleString('en-US')}</Td>
                      <Td right color={themeColor.labelSecondary}>{shortTs(r.firstTs)}</Td>
                      <Td right color={themeColor.labelSecondary}>{shortTs(r.lastTs)}</Td>
                    </tr>
                  ))}
                  {coverage.length === 0 && (
                    <tr>
                      <Td>No price series materialized yet.</Td>
                      <Td>{DASH}</Td>
                      <Td right>{DASH}</Td>
                      <Td right>{DASH}</Td>
                      <Td right>{DASH}</Td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginTop: space[8] }}>
              Price = <code>value_usd / quantity</code> from each `asset_history` observation, tagged <code>source=implied</code>. Materialized by
              an idempotent backfill; a real feed can coexist and be compared.
            </div>
          </Board>
        </>
      ) : loading ? (
        <Loading label="Computing cost basis and P&L…" />
      ) : null}

      {summary && (
        <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>
          Basis is USD-level FIFO over signed `amount_usd` rows — the ledger carries no per-unit quantity, so lots are cost buckets, not coin
          lots. A sale with no matching purchase prints {DASH} rather than a fabricated gain. Unrealized uses the current holding value; it is not a
          tax figure.
        </div>
      )}
    </div>
  );
}

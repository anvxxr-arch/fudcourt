'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { themeColor, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { Loading } from '@/ui/feedback';
import { Banner } from '@/ui/banner';
import { loadBreakdown, type BreakdownResult, type BreakdownRow, type TreasuryDimension, type TreasuryRange } from './client';
import { DASH, medal, pct, toneOf, usd } from './format';
import { Board, Segmented, Td, Th } from './parts';

/**
 * The treasury leaderboard (DR-045). Ranks each dimension — chains, wallets,
 * assets — against its own peers over the selected window.
 *
 * It is a *view over the breakdown read*, not a new query: `treasuryBreakdown`
 * already returns every row with current, window-start, delta, share and peak,
 * so ranking is a pure sort of data the time machine already trusts. Building a
 * separate SQL path here would let the two boards disagree about the same
 * window, which is exactly the class of bug the single read layer exists to
 * prevent.
 *
 * Three rankings, because "who is winning" has three honest answers and picking
 * one silently would be a lie:
 *   - performance — biggest gain over the window (Δ%)
 *   - exposure    — biggest position now (share of the total)
 *   - peak        — biggest value reached inside the window
 * A `null` percentage (no start value to compare against) always sorts last, so
 * a new holding never out-ranks a real gainer on a missing number.
 */

type Metric = 'performance' | 'exposure' | 'peak';

const METRICS: readonly { key: Metric; label: string }[] = [
  { key: 'performance', label: 'Performance' },
  { key: 'exposure', label: 'Exposure' },
  { key: 'peak', label: 'Peak' },
];

const RANGES: readonly { key: TreasuryRange; label: string }[] = [
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
];

const DIMENSIONS: readonly { key: TreasuryDimension; label: string }[] = [
  { key: 'wallet', label: 'Wallets' },
  { key: 'chain', label: 'Chains' },
  { key: 'asset', label: 'Assets' },
];

/** The sort key for a metric. A null/absent metric ranks last, never first. */
function sortRows(rows: BreakdownRow[], metric: Metric): BreakdownRow[] {
  const key = (r: BreakdownRow): number => {
    switch (metric) {
      case 'performance':
        return r.changePct ?? Number.NEGATIVE_INFINITY;
      case 'peak':
        return r.peak;
      case 'exposure':
      default:
        return r.current;
    }
  };
  return [...rows].sort((a, b) => key(b) - key(a));
}

function metricValue(r: BreakdownRow, metric: Metric): string {
  switch (metric) {
    case 'performance':
      return pct(r.changePct);
    case 'peak':
      return usd(r.peak);
    case 'exposure':
    default:
      return usd(r.current);
  }
}

function RankBoard({
  dimension,
  result,
  metric,
  loading,
}: {
  dimension: TreasuryDimension;
  result: BreakdownResult | null;
  metric: Metric;
  loading: boolean;
}) {
  const rows = useMemo(() => (result ? sortRows(result.rows, metric) : []), [result, metric]);
  const label = DIMENSIONS.find((d) => d.key === dimension)?.label ?? dimension;

  return (
    <Board
      title={
        <>
          {label} — {result?.range ?? '—'} · ranked by {metric}
        </>
      }
      right={
        result ? (
          <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>
            {result.rows.length} entries · {result.observations.toLocaleString('en-US')} obs
          </span>
        ) : undefined
      }
    >
      {loading && !result ? (
        <Loading label={`Ranking ${label.toLowerCase()}…`} />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <Th>#</Th>
                <Th>{label.replace(/s$/, '')}</Th>
                <Th right>{metric === 'performance' ? 'Δ %' : metric === 'peak' ? 'Peak' : 'Current'}</Th>
                <Th right>Current</Th>
                <Th right>Share</Th>
                <Th right>Δ %</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.key}>
                  <Td color={i < 3 ? themeColor.labelPrimary : themeColor.labelTertiary}>{medal(i)}</Td>
                  <Td>
                    {r.emoji ? `${r.emoji} ` : ''}
                    <span style={{ color: r.color ?? themeColor.labelPrimary, fontWeight: i === 0 ? fontWeight.semibold : fontWeight.regular }}>{r.label}</span>
                  </Td>
                  <Td right color={metric === 'performance' ? toneOf(r.changePct) : themeColor.labelPrimary}>
                    {metricValue(r, metric)}
                  </Td>
                  <Td right color={themeColor.labelSecondary}>{usd(r.current)}</Td>
                  <Td right color={themeColor.labelSecondary}>{pct(r.sharePct, 1)}</Td>
                  <Td right color={toneOf(r.changePct)}>{pct(r.changePct)}</Td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <Td>{DASH}</Td>
                  <Td>No entries in this window.</Td>
                  <Td right>{DASH}</Td>
                  <Td right>{DASH}</Td>
                  <Td right>{DASH}</Td>
                  <Td right>{DASH}</Td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Board>
  );
}

/**
 * The leaderboard panel. Fetches the three dimensions for the selected window
 * in parallel and renders one ranked board each. Each fetch is independent: a
 * dimension that fails to load blanks its own board and leaves the other two.
 */
export default function LeaderboardPanel() {
  const [range, setRange] = useState<TreasuryRange>('7d');
  const [metric, setMetric] = useState<Metric>('performance');
  const [byDim, setByDim] = useState<Record<TreasuryDimension, BreakdownResult | null>>({
    wallet: null,
    chain: null,
    asset: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const dims: TreasuryDimension[] = ['wallet', 'chain', 'asset'];
    const settled = await Promise.allSettled(dims.map((d) => loadBreakdown(d, range)));
    const next = { ...byDim };
    let firstErr: string | null = null;
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') next[dims[i]] = s.value;
      else if (!firstErr) firstErr = String(s.reason);
    });
    setByDim(next);
    setError(firstErr);
    setLoading(false);
    // `byDim` is intentionally not a dependency: the setter form above reads the
    // latest state, and including it would refetch on every successful load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  // The champion line: the leader of the currently-selected dimension+metric.
  const champion = useMemo(() => {
    const rows = byDim.wallet ? sortRows(byDim.wallet.rows, metric) : [];
    return rows[0] ?? null;
  }, [byDim.wallet, metric]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[16] }}>
      <div style={{ display: 'flex', gap: space[16], flexWrap: 'wrap', alignItems: 'center' }}>
        <Segmented<TreasuryRange> label="Window" value={range} options={RANGES} onChange={setRange} />
        <Segmented<Metric> label="Rank by" value={metric} options={METRICS} onChange={setMetric} />
        {loading && <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>⟳ refreshing</span>}
      </div>

      {error && <Banner>Some boards failed to load: {error}</Banner>}

      {champion && (
        <div style={{ background: themeColor.bgSecondary, border: `1px solid ${themeColor.separator}`, borderRadius: radius[12], padding: space[12], display: 'flex', gap: space[12], alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ fontSize: fontSize[20] }}>🏆</span>
          <span style={{ color: themeColor.labelPrimary, fontSize: fontSize[15], fontWeight: fontWeight.semibold }}>
            {champion.emoji ? `${champion.emoji} ` : ''}
            {champion.label}
          </span>
          <span style={{ color: themeColor.labelSecondary, fontSize: fontSize[12] }}>leads the wallet board on {metric}</span>
          <span style={{ color: toneOf(champion.changePct), fontSize: fontSize[13], fontWeight: fontWeight.semibold }}>{pct(champion.changePct)}</span>
          <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>{usd(champion.current)} now · share {pct(champion.sharePct, 1)}</span>
        </div>
      )}

      <RankBoard dimension="wallet" result={byDim.wallet} metric={metric} loading={loading} />
      <RankBoard dimension="chain" result={byDim.chain} metric={metric} loading={loading} />
      <RankBoard dimension="asset" result={byDim.asset} metric={metric} loading={loading} />
    </div>
  );
}

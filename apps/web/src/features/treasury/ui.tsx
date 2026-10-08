'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { themeColor, fontFamily, fontSize, fontWeight, letterSpacing, radius, space } from '@/styles/tokens';
import { seriesColor } from '@/ui';
import { Loading } from '@/ui/feedback';
import { Banner } from '@/ui/banner';
import {
  RANGE_BUCKET,
  loadAnalytics,
  loadBreakdown,
  loadDiff,
  loadHistory,
  type Analytics,
  type BreakdownResult,
  type DiffResult,
  type HistoryPoint,
  type HistoryResult,
  type TreasuryDimension,
  type TreasuryGroup,
  type TreasuryRange,
} from './client';
import { DASH, usd, pct, shortTs, toneOf } from './format';
import { Segmented, Td, Th } from './parts';

// ---------------------------------------------------------------------------
// The chart. A self-contained SVG so the panel owns no charting dependency:
// one area+line for the total, one line per key for a grouped series, all in
// the official categorical palette (`seriesColor`), which the design gate
// accepts because it resolves to a `var(--fc-…)` string, not a literal.
// ---------------------------------------------------------------------------
const CHART_W = 960;
const CHART_H = 260;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 12;
const PAD_B = 18;

type Series = { key: string; color: string; points: { t: number; v: number }[] };

function buildSeries(history: HistoryResult): Series[] {
  const byKey = new Map<string, { t: number; v: number }[]>();
  for (const p of history.points) {
    const t = new Date(p.t).getTime();
    if (!Number.isFinite(t) || !Number.isFinite(p.v)) continue;
    const arr = byKey.get(p.key) ?? [];
    arr.push({ t, v: p.v });
    byKey.set(p.key, arr);
  }
  const keys = [...byKey.keys()].sort();
  return keys.map((key, i) => ({
    key,
    color: history.group === 'total' ? seriesColor('price') : seriesColor('categorical', i),
    points: (byKey.get(key) ?? []).sort((a, b) => a.t - b.t),
  }));
}

function SeriesChart({ history }: { history: HistoryResult }) {
  const series = useMemo(() => buildSeries(history), [history]);
  const all = series.flatMap((s) => s.points);
  if (all.length < 2) {
    return (
      <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[12], padding: space[16] }}>
        Not enough observations in this window to draw a trend.
      </div>
    );
  }
  const tMin = Math.min(...all.map((p) => p.t));
  const tMax = Math.max(...all.map((p) => p.t));
  const vMin = Math.min(...all.map((p) => p.v));
  const vMax = Math.max(...all.map((p) => p.v));
  const tSpan = tMax - tMin || 1;
  const vSpan = vMax - vMin || 1;
  const x = (t: number) => PAD_L + ((t - tMin) / tSpan) * (CHART_W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (1 - (v - vMin) / vSpan) * (CHART_H - PAD_T - PAD_B);

  const isSingle = series.length === 1;

  return (
    <div>
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        width="100%"
        height={CHART_H}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Net worth over time, ${series.length} series, ${all.length} points`}
        style={{ display: 'block', background: themeColor.bgSecondary, borderRadius: radius[8] }}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const gy = PAD_T + f * (CHART_H - PAD_T - PAD_B);
          return <line key={f} x1={PAD_L} x2={CHART_W - PAD_R} y1={gy} y2={gy} stroke={themeColor.separator} strokeWidth={1} />;
        })}
        {series.map((s) => {
          const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
          const area = `${d} L${x(s.points[s.points.length - 1].t).toFixed(1)},${(CHART_H - PAD_B).toFixed(1)} L${x(s.points[0].t).toFixed(1)},${(CHART_H - PAD_B).toFixed(1)} Z`;
          return (
            <g key={s.key}>
              {isSingle && <path d={area} fill={s.color} opacity={0.12} />}
              <path d={d} fill="none" stroke={s.color} strokeWidth={1.5} />
            </g>
          );
        })}
        {isSingle &&
          series[0].points.slice(-1).map((p) => (
            <circle key="last" cx={x(p.t)} cy={y(p.v)} r={3} fill={series[0].color} />
          ))}
      </svg>
      <div style={{ display: 'flex', gap: space[12], flexWrap: 'wrap', marginTop: space[8] }}>
        <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>
          {shortTs(new Date(tMin).toISOString())} → {shortTs(new Date(tMax).toISOString())}
        </span>
        <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>
          low {usd(vMin)} · high {usd(vMax)}
        </span>
        {!isSingle &&
          series.map((s) => (
            <span key={s.key} style={{ color: s.color, fontSize: fontSize[11] }}>
              ● {s.key}
            </span>
          ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A single figure. `sub` carries the qualifier (a timestamp, a window) so a
// headline number is never read without its context.
// ---------------------------------------------------------------------------
function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ background: themeColor.bgSecondary, border: `1px solid ${themeColor.separator}`, borderRadius: radius[8], padding: space[12], minWidth: 132 }}>
      <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], letterSpacing: letterSpacing.xs, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ color: color ?? themeColor.labelPrimary, fontSize: fontSize[20], fontWeight: fontWeight.bold, marginTop: space[4] }}>{value}</div>
      {sub && <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginTop: space[4] }}>{sub}</div>}
    </div>
  );
}

const RANGES: readonly { key: TreasuryRange; label: string }[] = [
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
];
const GROUPS: readonly { key: TreasuryGroup; label: string }[] = [
  { key: 'total', label: 'Total' },
  { key: 'chain', label: 'Chain' },
  { key: 'wallet', label: 'Wallet' },
  { key: 'asset', label: 'Asset' },
];
const DIMENSIONS: readonly { key: TreasuryDimension; label: string }[] = [
  { key: 'chain', label: 'Chain' },
  { key: 'wallet', label: 'Wallet' },
  { key: 'asset', label: 'Asset' },
];

/**
 * The Net-Worth Time Machine. Fetches the four `/api/treasury` modes for the
 * selected window and renders: the stat block (now / change / ATH / drawdown /
 * volatility), the chart, the per-dimension breakdown, and the movement board
 * (what changed and the transactions that explain it).
 *
 * Every fetch is independent and each failure is contained: a broken breakdown
 * does not blank the chart, and a broken chart does not hide the stat block.
 * `null` metrics render the em dash, never a 0 — the panel is built to show an
 * honest gap rather than a confident lie.
 */
export default function TreasuryPanel() {
  const [range, setRange] = useState<TreasuryRange>('7d');
  const [group, setGroup] = useState<TreasuryGroup>('total');
  const [dimension, setDimension] = useState<TreasuryDimension>('wallet');

  const [history, setHistory] = useState<HistoryResult | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [breakdown, setBreakdown] = useState<BreakdownResult | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const bucket = RANGE_BUCKET[range];
    const [h, a, b, d] = await Promise.allSettled([
      loadHistory(group, range, bucket),
      loadAnalytics(range),
      loadBreakdown(dimension, range),
      loadDiff(range),
    ]);
    if (h.status === 'fulfilled') setHistory(h.value);
    if (a.status === 'fulfilled') setAnalytics(a.value);
    if (b.status === 'fulfilled') setBreakdown(b.value);
    if (d.status === 'fulfilled') setDiff(d.value);
    const firstErr = [h, a, b, d].find((r) => r.status === 'rejected');
    if (firstErr && firstErr.status === 'rejected') setError(String(firstErr.reason));
    setLoading(false);
  }, [range, group, dimension]);

  useEffect(() => {
    void load();
  }, [load]);

  const cur = analytics?.current ?? null;
  const chg = analytics?.changeUsd ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[16] }}>
      <div style={{ display: 'flex', gap: space[16], flexWrap: 'wrap', alignItems: 'center' }}>
        <Segmented<TreasuryRange> label="Window" value={range} options={RANGES} onChange={setRange} />
        <Segmented<TreasuryGroup> label="Chart by" value={group} options={GROUPS} onChange={setGroup} />
        <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>
          {analytics ? `${analytics.observations.toLocaleString('en-US')} sync observations` : ''}
          {loading ? ' ⟳' : ''}
        </span>
      </div>

      {error && <Banner>Some panels failed to load: {error}</Banner>}

      {analytics ? (
        <div style={{ display: 'flex', gap: space[8], flexWrap: 'wrap' }}>
          <Stat label="Net worth" value={usd(cur)} sub={analytics.lastTs ? `as of ${shortTs(analytics.lastTs)}` : undefined} />
          <Stat label={`Change (${range})`} value={usd(chg)} sub={pct(analytics.changePct)} color={toneOf(chg)} />
          <Stat label="All-time high" value={usd(analytics.ath)} sub={analytics.athTs ? shortTs(analytics.athTs) : undefined} color={themeColor.green} />
          <Stat label="Drawdown" value={pct(analytics.drawdownPct)} sub={analytics.low ? `low ${usd(analytics.low)}` : undefined} color={toneOf(analytics.drawdownPct)} />
          <Stat label="Volatility (daily)" value={pct(analytics.volatilityDailyPct)} sub="σ of daily returns" />
        </div>
      ) : loading ? (
        <Loading label="Loading treasury analytics…" />
      ) : null}

      {history && (
        <div style={{ background: themeColor.bgBase, border: `1px solid ${themeColor.separator}`, borderRadius: radius[12], padding: space[12] }}>
          <div style={{ color: themeColor.blue, fontSize: fontSize[13], fontWeight: fontWeight.semibold, marginBottom: space[8] }}>
            Net worth — {history.group} · {history.range} · {history.bucket} buckets
          </div>
          <SeriesChart history={history} />
        </div>
      )}

      {breakdown && (
        <div style={{ background: themeColor.bgBase, border: `1px solid ${themeColor.separator}`, borderRadius: radius[12], padding: space[12] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: space[8], marginBottom: space[8] }}>
            <div style={{ color: themeColor.blue, fontSize: fontSize[13], fontWeight: fontWeight.semibold }}>
              Breakdown by {breakdown.dimension} — {breakdown.range}
            </div>
            <Segmented<TreasuryDimension> label="By" value={dimension} options={DIMENSIONS} onChange={setDimension} />
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <Th>{breakdown.dimension}</Th>
                  <Th right>Current</Th>
                  <Th right>Window start</Th>
                  <Th right>Δ</Th>
                  <Th right>Δ %</Th>
                  <Th right>Share</Th>
                  <Th right>Peak</Th>
                </tr>
              </thead>
              <tbody>
                {breakdown.rows.map((r) => (
                  <tr key={r.key}>
                    <Td>
                      {r.emoji ? `${r.emoji} ` : ''}
                      <span style={{ color: r.color ?? themeColor.labelPrimary }}>{r.label}</span>
                    </Td>
                    <Td right>{usd(r.current)}</Td>
                    <Td right color={themeColor.labelSecondary}>{usd(r.first)}</Td>
                    <Td right color={toneOf(r.changeUsd)}>{usd(r.changeUsd)}</Td>
                    <Td right color={toneOf(r.changePct)}>{pct(r.changePct)}</Td>
                    <Td right color={themeColor.labelSecondary}>{pct(r.sharePct, 1)}</Td>
                    <Td right color={themeColor.labelTertiary}>{usd(r.peak)}</Td>
                  </tr>
                ))}
                {breakdown.rows.length === 0 && (
                  <tr>
                    <Td>{DASH}</Td>
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
        </div>
      )}

      {diff && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', gap: space[12] }}>
          <div style={{ background: themeColor.bgBase, border: `1px solid ${themeColor.separator}`, borderRadius: radius[12], padding: space[12] }}>
            <div style={{ color: themeColor.blue, fontSize: fontSize[13], fontWeight: fontWeight.semibold, marginBottom: space[8] }}>
              What moved — {diff.range} ({shortTs(diff.fromTs)} → {shortTs(diff.toTs)})
            </div>
            <div style={{ overflowX: 'auto', maxHeight: 360, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <Th>Holding</Th>
                    <Th right>From</Th>
                    <Th right>To</Th>
                    <Th right>Δ</Th>
                  </tr>
                </thead>
                <tbody>
                  {diff.rows.map((r) => (
                    <tr key={`${r.chain}-${r.asset}-${r.wallet}`}>
                      <Td>
                        <span style={{ color: themeColor.labelSecondary }}>{r.chain}</span> {r.asset}
                        {r.wallet ? <span style={{ color: themeColor.labelTertiary }}> · {r.wallet}</span> : null}
                      </Td>
                      <Td right color={themeColor.labelSecondary}>{usd(r.from)}</Td>
                      <Td right>{usd(r.to)}</Td>
                      <Td right color={toneOf(r.delta)}>{usd(r.delta)}</Td>
                    </tr>
                  ))}
                  {diff.rows.length === 0 && (
                    <tr>
                      <Td>No holding changed in this window.</Td>
                      <Td right>{DASH}</Td>
                      <Td right>{DASH}</Td>
                      <Td right>{DASH}</Td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ background: themeColor.bgBase, border: `1px solid ${themeColor.separator}`, borderRadius: radius[12], padding: space[12] }}>
            <div style={{ color: themeColor.blue, fontSize: fontSize[13], fontWeight: fontWeight.semibold, marginBottom: space[8] }}>
              Why — transactions in the window
            </div>
            <div style={{ overflowX: 'auto', maxHeight: 360, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Event</Th>
                    <Th>Asset</Th>
                    <Th right>Amount</Th>
                  </tr>
                </thead>
                <tbody>
                  {diff.reasons.map((r, i) => (
                    <tr key={`${r.date}-${r.hash ?? i}`}>
                      <Td color={themeColor.labelSecondary}>{r.date}</Td>
                      <Td>
                        {r.event}
                        <span style={{ color: themeColor.labelTertiary }}> · {r.chain}</span>
                      </Td>
                      <Td color={themeColor.labelSecondary}>{r.asset}</Td>
                      <Td right color={r.direction === 'IN' ? themeColor.green : themeColor.red}>
                        {r.direction === 'IN' ? '+' : '−'}
                        {usd(Math.abs(r.amountUsd ?? 0))}
                      </Td>
                    </tr>
                  ))}
                  {diff.reasons.length === 0 && (
                    <tr>
                      <Td>No transactions recorded in this window.</Td>
                      <Td>{DASH}</Td>
                      <Td>{DASH}</Td>
                      <Td right>{DASH}</Td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { chainColor } from '@/lib/format';
import { alpha, themeColor, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { Loading } from '@/ui/feedback';
import { Table, TBody, THead } from '@/ui/table';
import { Toolbar } from '@/ui/toolbar';
import { Meter } from '@/ui/meter';
import { fetchScoreboard } from './client';

type Bucket = { day: string; n: number; run: number; flat: number; dump: number; unknown: number };
type Catch = {
  mint: string; symbol: string; score: number; decision: string;
  peak24: number; chain: string; day: string; x24h?: number;
};
type ChainBoard = { latest: Bucket; cohortDays: number; series: Bucket[]; catches: Catch[] };
type Board = {
  kind: string; generatedAt: number; cohortDays: number;
  chains: Record<string, ChainBoard>; error?: string;
};

const CHAIN_LABEL: Record<string, { label: string; color: string }> = {
  solana: { label: '◎ Solana', color: chainColor('solana') },
  robinhood: { label: '🪶 Robinhood', color: themeColor.blue },
};

const DECISION_COLOR: Record<string, string> = {
  surfaced: themeColor.blue, watching: themeColor.orange, 'low score': themeColor.labelTertiary,
  vetoed: themeColor.red, blocked: themeColor.red, bundle: themeColor.orange,
};

// Bucket shares are computed from n, which upstream guarantees equals
// run+flat+dump+unknown (verified across all 20 series points). If a future
// upstream revision breaks that identity, render the raw parts and a
// mismatch warning rather than silently normalizing the wrong total.
function parts(b: Bucket) {
  const sum = b.run + b.flat + b.dump + b.unknown;
  return { sum, ok: sum === b.n, pct: (v: number) => (b.n > 0 ? (v / b.n) * 100 : 0) };
}

export default function ScoreboardPage() {
  const [data, setData] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [chain, setChain] = useState<string>('solana');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const json = await fetchScoreboard<Board>();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const chains = useMemo(() => Object.keys(data?.chains || {}), [data]);
  const active = chain && data?.chains?.[chain] ? chain : chains[0] || '';
  const board = active ? data?.chains?.[active] : undefined;
  const mismatches = useMemo(() => {
    let n = 0;
    for (const ch of Object.values(data?.chains || {}))
      for (const s of ch.series || []) if (!parts(s).ok) n++;
    return n;
  }, [data]);

  const totals = useMemo(() => {
    const s = board?.series || [];
    if (!s.length) return null;
    const t = s.reduce(
      (a, b) => ({ n: a.n + b.n, run: a.run + b.run, flat: a.flat + b.flat, dump: a.dump + b.dump, unknown: a.unknown + b.unknown }),
      { n: 0, run: 0, flat: 0, dump: 0, unknown: 0 }
    );
    return {
      ...t,
      hitRate: t.n > 0 ? ((t.run + t.flat) / t.n) * 100 : null,
      runRate: t.n > 0 ? (t.run / t.n) * 100 : null,
    };
  }, [board]);

  return (
    <div>
      <Toolbar style={{ flexWrap: 'wrap', gap: space[8] }}>
        <div>
          <h2 style={{ color: themeColor.blue, margin: 0, fontSize: fontSize[17] }}>Scoreboard</h2>
          <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], margin: '2px 0 0' }}>
            daily cohort outcomes{data?.cohortDays ? ` · ${data.cohortDays}d cohort` : ''}
            {data ? ` · generated ${new Date(data.generatedAt * 1000).toISOString().replace('T', ' ').slice(0, 16)}` : ''}
          </p>
        </div>
        <button onClick={load} style={{ background: themeColor.bgSecondary, color: themeColor.labelPrimary, border: `1px solid ${themeColor.separator}`, padding: `${space[8]}px ${space[12]}px`, borderRadius: radius[8], fontSize: fontSize[11], cursor: 'pointer' }}>
          ↻ Refresh
        </button>
      </Toolbar>

      {error && (
        <p style={{ color: themeColor.red, fontSize: fontSize[12], background: alpha(themeColor.red, 0.08), border: `1px solid ${themeColor.red}`, borderRadius: radius[8], padding: space[8] }}>
          scoreboard failed: {error} — nothing faked
        </p>
      )}

      {mismatches > 0 && (
        <p style={{ color: themeColor.orange, fontSize: fontSize[11], margin: `0 0 ${space[8]}px` }}>
          ⚠ {mismatches} bucket(s) where run+flat+dump+unknown ≠ n — upstream schema changed, shares shown raw
        </p>
      )}

      <div style={{ display: 'flex', gap: space[8], marginBottom: space[12], flexWrap: 'wrap' }}>
        {chains.map(c => (
          <button
            key={c}
            onClick={() => setChain(c)}
            style={{
              background: c === active ? (CHAIN_LABEL[c]?.color || themeColor.blue) : themeColor.bgSecondary,
              color: c === active ? themeColor.labelOnAccent : themeColor.labelSecondary,
              border: `1px solid ${themeColor.separator}`, padding: `${space[8]}px ${space[12]}px`, borderRadius: radius[8],
              fontSize: fontSize[11], cursor: 'pointer', fontWeight: fontWeight.bold,
            }}
          >
            {CHAIN_LABEL[c]?.label || c}
          </button>
        ))}
      </div>

      {loading ? (
        <Loading label="loading scoreboard…" />
      ) : error ? (
        // Same rule as SignalsPage: a failed fetch must never fall through to
        // the "no data for this chain" branch, which reads as a real empty
        // result rather than a dead upstream.
        <p style={{ color: themeColor.red, fontSize: fontSize[12] }}>
          no data loaded — cohorts and catches withheld because the upstream fetch failed.
        </p>
      ) : !board ? (
        <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>no scoreboard data for this chain</p>
      ) : (
        <>
          {totals && (
            <div style={{ display: 'flex', gap: space[8], flexWrap: 'wrap', marginBottom: space[12], fontSize: fontSize[11] }}>
              {[
                ['scored', totals.n.toLocaleString()],
                ['run', `${totals.run.toLocaleString()} (${totals.runRate?.toFixed(1)}%)`],
                ['flat', totals.flat.toLocaleString()],
                ['dump', totals.dump.toLocaleString()],
                ['unknown', totals.unknown.toLocaleString()],
                ['run+flat hit rate', totals.hitRate === null ? '—' : `${totals.hitRate.toFixed(1)}%`],
                ['days', String((board.series || []).length)],
              ].map(([k, v]) => (
                <div key={k} style={{ background: themeColor.bgSecondary, border: `1px solid ${themeColor.separator}`, borderRadius: radius[8], padding: `${space[8]}px ${space[8]}px` }}>
                  <span style={{ color: themeColor.labelTertiary }}>{k} </span>
                  <span style={{ color: themeColor.blue, fontWeight: fontWeight.bold }}>{v}</span>
                </div>
              ))}
            </div>
          )}

          {totals && (
            <div style={{ marginBottom: space[16] }}>
              <h4 style={{ color: themeColor.labelPrimary, fontSize: fontSize[12], margin: `0 0 ${space[8]}px` }}>Outcome composition</h4>
              <Meter
                parts={[
                  { label: 'run', value: totals.run, color: themeColor.blue },
                  { label: 'flat', value: totals.flat, color: themeColor.orange },
                  { label: 'dump', value: totals.dump, color: themeColor.red },
                  { label: 'unknown', value: totals.unknown, color: themeColor.separator },
                ]}
              />
            </div>
          )}
          <h4 style={{ color: themeColor.labelPrimary, fontSize: fontSize[12], margin: `0 0 ${space[8]}px` }}>Daily cohorts</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: space[4], marginBottom: space[20] }}>
            {(board.series || []).map(s => {
              const p = parts(s);
              return (
                <div key={s.day} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[8], fontSize: fontSize[11] }}>
                  <span style={{ color: themeColor.labelTertiary, width: 84, flexShrink: 0 }}>{s.day}</span>
                  <span style={{ color: themeColor.labelPrimary, width: 46, flexShrink: 0, textAlign: 'right' }}>{s.n}</span>
                  <div
                    style={{
                      flex: 1, display: 'flex', height: space[12], borderRadius: radius[8], overflow: 'hidden',
                      background: themeColor.bgSecondary, border: `1px solid ${themeColor.separator}`,
                    }}
                    title={`run ${s.run} · flat ${s.flat} · dump ${s.dump} · unknown ${s.unknown}`}
                  >
                    <div style={{ width: `${p.pct(s.run)}%`, background: themeColor.blue }} />
                    <div style={{ width: `${p.pct(s.flat)}%`, background: themeColor.orange }} />
                    <div style={{ width: `${p.pct(s.dump)}%`, background: themeColor.red }} />
                    <div style={{ width: `${p.pct(s.unknown)}%`, background: themeColor.separator }} />
                  </div>
                  <span style={{ color: themeColor.labelTertiary, width: 150, flexShrink: 0 }}>
                    {s.run}/{s.flat}/{s.dump}/{s.unknown}
                    {!p.ok && <span style={{ color: themeColor.orange }}> ≠{s.n}</span>}
                  </span>
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: space[12], fontSize: fontSize[11], color: themeColor.labelTertiary, marginBottom: space[20] }}>
            {[['run', themeColor.blue], ['flat', themeColor.orange], ['dump', themeColor.red], ['unknown', themeColor.separator]].map(([l, c]) => (
              <span key={l as string} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: space[8], height: space[8], background: c as string, borderRadius: radius[8], display: 'inline-block' }} />
                {l as string}
              </span>
            ))}
          </div>

          <h4 style={{ color: themeColor.labelPrimary, fontSize: fontSize[12], margin: `0 0 ${space[8]}px` }}>
            Top catches ({(board.catches || []).length})
          </h4>
          <div style={{ overflowX: 'auto' }}>
            <Table style={{ fontSize: fontSize[11] }}>
              <THead>
                <tr style={{ color: themeColor.labelTertiary, textAlign: 'left', borderBottom: `1px solid ${themeColor.separator}` }}>
                  {['day', 'symbol', 'mint', 'score', 'decision', 'peak24', 'x24h'].map(h => (
                    <th key={h} style={{ padding: `${space[8]}px ${space[8]}px`, fontWeight: fontWeight.medium, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </THead>
              <TBody>
                {(board.catches || []).map((c, i) => (
                  <tr key={`${c.mint}-${c.day}-${i}`} style={{ borderBottom: `1px solid ${alpha(themeColor.separator, 0.4)}` }}>
                    <td style={{ padding: `${space[8]}px ${space[8]}px`, color: themeColor.labelTertiary, whiteSpace: 'nowrap' }}>{c.day}</td>
                    <td style={{ padding: `${space[8]}px ${space[8]}px`, color: themeColor.labelPrimary, fontWeight: fontWeight.bold, whiteSpace: 'nowrap' }}>{c.symbol || '?'}</td>
                    <td style={{ padding: `${space[8]}px ${space[8]}px`, color: themeColor.labelTertiary }}>
                      {c.mint.length > 14 ? `${c.mint.slice(0, 6)}…${c.mint.slice(-4)}` : c.mint}
                    </td>
                    <td style={{ padding: `${space[8]}px ${space[8]}px`, color: themeColor.blue }}>{c.score?.toFixed(1) ?? '—'}</td>
                    <td style={{ padding: `${space[8]}px ${space[8]}px`, color: DECISION_COLOR[c.decision] || themeColor.labelTertiary }}>{c.decision || '—'}</td>
                    <td style={{ padding: `${space[8]}px ${space[8]}px`, color: themeColor.labelPrimary }}>{typeof c.peak24 === 'number' ? `${c.peak24.toFixed(2)}×` : '—'}</td>
                    <td style={{ padding: `${space[8]}px ${space[8]}px`, color: themeColor.labelPrimary }}>{typeof c.x24h === 'number' ? `${c.x24h.toFixed(2)}×` : '—'}</td>
                  </tr>
                ))}
              </TBody>
            </Table>
            {(board.catches || []).length === 0 && (
              <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>no catches in this cohort window</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

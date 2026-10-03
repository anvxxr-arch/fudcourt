'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { chainColor } from '@/styles/shared';
import { alpha, color, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { Loading } from '@/components/ui/feedback';
import { Table, TBody, THead } from '@/components/ui/table';
import { Toolbar } from '@/components/ui/toolbar';

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
  robinhood: { label: '🪶 Robinhood', color: color.accent },
};

const DECISION_COLOR: Record<string, string> = {
  surfaced: color.accent, watching: color.warn, 'low score': color.textMuted,
  vetoed: color.negative, blocked: color.negative, bundle: color.attention,
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
      const res = await fetch('/api/signals?type=scoreboard', { cache: 'no-store' });
      const json: Board = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
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
      <Toolbar style={{ flexWrap: 'wrap', gap: space[10] }}>
        <div>
          <h3 style={{ color: color.accent, margin: 0 }}>Scoreboard</h3>
          <p style={{ color: color.textMuted, fontSize: fontSize[10], margin: '2px 0 0' }}>
            daily cohort outcomes{data?.cohortDays ? ` · ${data.cohortDays}d cohort` : ''}
            {data ? ` · generated ${new Date(data.generatedAt * 1000).toISOString().replace('T', ' ').slice(0, 16)}` : ''}
          </p>
        </div>
        <button onClick={load} style={{ background: color.surface, color: color.text, border: `1px solid ${color.border}`, padding: `${space[6]}px ${space[14]}px`, borderRadius: radius[6], fontSize: fontSize[11], cursor: 'pointer' }}>
          ↻ Refresh
        </button>
      </Toolbar>

      {error && (
        <p style={{ color: color.negative, fontSize: fontSize[12], background: alpha(color.negative, 0.08), border: `1px solid ${color.negative}`, borderRadius: radius[6], padding: space[8] }}>
          scoreboard failed: {error} — nothing faked
        </p>
      )}

      {mismatches > 0 && (
        <p style={{ color: color.attention, fontSize: fontSize[11], margin: `0 0 ${space[10]}px` }}>
          ⚠ {mismatches} bucket(s) where run+flat+dump+unknown ≠ n — upstream schema changed, shares shown raw
        </p>
      )}

      <div style={{ display: 'flex', gap: space[8], marginBottom: space[12], flexWrap: 'wrap' }}>
        {chains.map(c => (
          <button
            key={c}
            onClick={() => setChain(c)}
            style={{
              background: c === active ? (CHAIN_LABEL[c]?.color || color.accent) : color.surface,
              color: c === active ? color.textOnAccent : color.textMuted,
              border: `1px solid ${color.border}`, padding: `${space[6]}px ${space[12]}px`, borderRadius: radius[6],
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
        <p style={{ color: color.negative, fontSize: fontSize[12] }}>
          no data loaded — cohorts and catches withheld because the upstream fetch failed.
        </p>
      ) : !board ? (
        <p style={{ color: color.textMuted, fontSize: fontSize[12] }}>no scoreboard data for this chain</p>
      ) : (
        <>
          {totals && (
            <div style={{ display: 'flex', gap: space[8], flexWrap: 'wrap', marginBottom: space[14], fontSize: fontSize[10] }}>
              {[
                ['scored', totals.n.toLocaleString()],
                ['run', `${totals.run.toLocaleString()} (${totals.runRate?.toFixed(1)}%)`],
                ['flat', totals.flat.toLocaleString()],
                ['dump', totals.dump.toLocaleString()],
                ['unknown', totals.unknown.toLocaleString()],
                ['run+flat hit rate', totals.hitRate === null ? '—' : `${totals.hitRate.toFixed(1)}%`],
                ['days', String((board.series || []).length)],
              ].map(([k, v]) => (
                <div key={k} style={{ background: color.surface, border: `1px solid ${color.border}`, borderRadius: radius[6], padding: `${space[6]}px ${space[10]}px` }}>
                  <span style={{ color: color.textMuted }}>{k} </span>
                  <span style={{ color: color.accent, fontWeight: fontWeight.bold }}>{v}</span>
                </div>
              ))}
            </div>
          )}

          <h4 style={{ color: color.text, fontSize: fontSize[12], margin: `0 0 ${space[8]}px` }}>Daily cohorts</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: space[4], marginBottom: space[20] }}>
            {(board.series || []).map(s => {
              const p = parts(s);
              return (
                <div key={s.day} style={{ display: 'flex', alignItems: 'center', gap: space[8], fontSize: fontSize[10] }}>
                  <span style={{ color: color.textMuted, width: 84, flexShrink: 0 }}>{s.day}</span>
                  <span style={{ color: color.text, width: 46, flexShrink: 0, textAlign: 'right' }}>{s.n}</span>
                  <div
                    style={{
                      flex: 1, display: 'flex', height: space[14], borderRadius: radius[4], overflow: 'hidden',
                      background: color.surface, border: `1px solid ${color.border}`,
                    }}
                    title={`run ${s.run} · flat ${s.flat} · dump ${s.dump} · unknown ${s.unknown}`}
                  >
                    <div style={{ width: `${p.pct(s.run)}%`, background: color.accent }} />
                    <div style={{ width: `${p.pct(s.flat)}%`, background: color.warn }} />
                    <div style={{ width: `${p.pct(s.dump)}%`, background: color.negative }} />
                    <div style={{ width: `${p.pct(s.unknown)}%`, background: color.border }} />
                  </div>
                  <span style={{ color: color.textMuted, width: 150, flexShrink: 0 }}>
                    {s.run}/{s.flat}/{s.dump}/{s.unknown}
                    {!p.ok && <span style={{ color: color.attention }}> ≠{s.n}</span>}
                  </span>
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: space[12], fontSize: fontSize[10], color: color.textMuted, marginBottom: space[20] }}>
            {[['run', color.accent], ['flat', color.warn], ['dump', color.negative], ['unknown', color.border]].map(([l, c]) => (
              <span key={l as string} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: space[10], height: space[10], background: c as string, borderRadius: radius[4], display: 'inline-block' }} />
                {l as string}
              </span>
            ))}
          </div>

          <h4 style={{ color: color.text, fontSize: fontSize[12], margin: `0 0 ${space[8]}px` }}>
            Top catches ({(board.catches || []).length})
          </h4>
          <div style={{ overflowX: 'auto' }}>
            <Table style={{ fontSize: fontSize[11] }}>
              <THead>
                <tr style={{ color: color.textMuted, textAlign: 'left', borderBottom: `1px solid ${color.border}` }}>
                  {['day', 'symbol', 'mint', 'score', 'decision', 'peak24', 'x24h'].map(h => (
                    <th key={h} style={{ padding: `${space[6]}px ${space[8]}px`, fontWeight: fontWeight.medium, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </THead>
              <TBody>
                {(board.catches || []).map((c, i) => (
                  <tr key={`${c.mint}-${c.day}-${i}`} style={{ borderBottom: `1px solid ${alpha(color.border, 0.4)}` }}>
                    <td style={{ padding: `${space[6]}px ${space[8]}px`, color: color.textMuted, whiteSpace: 'nowrap' }}>{c.day}</td>
                    <td style={{ padding: `${space[6]}px ${space[8]}px`, color: color.text, fontWeight: fontWeight.bold, whiteSpace: 'nowrap' }}>{c.symbol || '?'}</td>
                    <td style={{ padding: `${space[6]}px ${space[8]}px`, color: color.textMuted }}>
                      {c.mint.length > 14 ? `${c.mint.slice(0, 6)}…${c.mint.slice(-4)}` : c.mint}
                    </td>
                    <td style={{ padding: `${space[6]}px ${space[8]}px`, color: color.accent }}>{c.score?.toFixed(1) ?? '—'}</td>
                    <td style={{ padding: `${space[6]}px ${space[8]}px`, color: DECISION_COLOR[c.decision] || color.textMuted }}>{c.decision || '—'}</td>
                    <td style={{ padding: `${space[6]}px ${space[8]}px`, color: color.text }}>{typeof c.peak24 === 'number' ? `${c.peak24.toFixed(2)}×` : '—'}</td>
                    <td style={{ padding: `${space[6]}px ${space[8]}px`, color: color.text }}>{typeof c.x24h === 'number' ? `${c.x24h.toFixed(2)}×` : '—'}</td>
                  </tr>
                ))}
              </TBody>
            </Table>
            {(board.catches || []).length === 0 && (
              <p style={{ color: color.textMuted, fontSize: fontSize[12] }}>no catches in this cohort window</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { C } from '../../lib/ui/shared';

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
  solana: { label: '◎ Solana', color: '#14f195' },
  robinhood: { label: '🪶 Robinhood', color: '#3ddc97' },
};

const DECISION_COLOR: Record<string, string> = {
  surfaced: C.green, watching: '#ffd166', 'low score': C.dim,
  vetoed: C.red, blocked: C.red, bundle: '#ff9f43',
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <div>
          <h3 style={{ color: C.accent, margin: 0 }}>Scoreboard</h3>
          <p style={{ color: C.dim, fontSize: 10, margin: '2px 0 0' }}>
            daily cohort outcomes{data?.cohortDays ? ` · ${data.cohortDays}d cohort` : ''}
            {data ? ` · generated ${new Date(data.generatedAt * 1000).toISOString().replace('T', ' ').slice(0, 16)}` : ''}
          </p>
        </div>
        <button onClick={load} style={{ background: C.card, color: C.white, border: `1px solid ${C.border}`, padding: '6px 14px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
          ↻ Refresh
        </button>
      </div>

      {error && (
        <p style={{ color: C.red, fontSize: 12, background: 'rgba(255,107,107,0.08)', border: `1px solid ${C.red}`, borderRadius: 6, padding: 8 }}>
          scoreboard failed: {error} — nothing faked
        </p>
      )}

      {mismatches > 0 && (
        <p style={{ color: '#ff9f43', fontSize: 11, margin: '0 0 10px' }}>
          ⚠ {mismatches} bucket(s) where run+flat+dump+unknown ≠ n — upstream schema changed, shares shown raw
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {chains.map(c => (
          <button
            key={c}
            onClick={() => setChain(c)}
            style={{
              background: c === active ? (CHAIN_LABEL[c]?.color || C.accent) : C.card,
              color: c === active ? '#04140f' : C.dim,
              border: `1px solid ${C.border}`, padding: '6px 12px', borderRadius: 6,
              fontSize: 11, cursor: 'pointer', fontWeight: 700,
            }}
          >
            {CHAIN_LABEL[c]?.label || c}
          </button>
        ))}
      </div>

      {loading ? (
        <p style={{ color: C.dim, fontSize: 12 }}>loading scoreboard…</p>
      ) : !board ? (
        <p style={{ color: C.dim, fontSize: 12 }}>no scoreboard data for this chain</p>
      ) : (
        <>
          {totals && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14, fontSize: 10 }}>
              {[
                ['scored', totals.n.toLocaleString()],
                ['run', `${totals.run.toLocaleString()} (${totals.runRate?.toFixed(1)}%)`],
                ['flat', totals.flat.toLocaleString()],
                ['dump', totals.dump.toLocaleString()],
                ['unknown', totals.unknown.toLocaleString()],
                ['run+flat hit rate', totals.hitRate === null ? '—' : `${totals.hitRate.toFixed(1)}%`],
                ['days', String((board.series || []).length)],
              ].map(([k, v]) => (
                <div key={k} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 10px' }}>
                  <span style={{ color: C.dim }}>{k} </span>
                  <span style={{ color: C.accent, fontWeight: 700 }}>{v}</span>
                </div>
              ))}
            </div>
          )}

          <h4 style={{ color: C.white, fontSize: 12, margin: '0 0 8px' }}>Daily cohorts</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 20 }}>
            {(board.series || []).map(s => {
              const p = parts(s);
              return (
                <div key={s.day} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10 }}>
                  <span style={{ color: C.dim, width: 84, flexShrink: 0 }}>{s.day}</span>
                  <span style={{ color: C.white, width: 46, flexShrink: 0, textAlign: 'right' }}>{s.n}</span>
                  <div
                    style={{
                      flex: 1, display: 'flex', height: 14, borderRadius: 3, overflow: 'hidden',
                      background: C.card, border: `1px solid ${C.border}`,
                    }}
                    title={`run ${s.run} · flat ${s.flat} · dump ${s.dump} · unknown ${s.unknown}`}
                  >
                    <div style={{ width: `${p.pct(s.run)}%`, background: C.green }} />
                    <div style={{ width: `${p.pct(s.flat)}%`, background: '#ffd166' }} />
                    <div style={{ width: `${p.pct(s.dump)}%`, background: C.red }} />
                    <div style={{ width: `${p.pct(s.unknown)}%`, background: C.border }} />
                  </div>
                  <span style={{ color: C.dim, width: 150, flexShrink: 0 }}>
                    {s.run}/{s.flat}/{s.dump}/{s.unknown}
                    {!p.ok && <span style={{ color: '#ff9f43' }}> ≠{s.n}</span>}
                  </span>
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 12, fontSize: 10, color: C.dim, marginBottom: 20 }}>
            {[['run', C.green], ['flat', '#ffd166'], ['dump', C.red], ['unknown', C.border]].map(([l, c]) => (
              <span key={l as string} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 10, height: 10, background: c as string, borderRadius: 2, display: 'inline-block' }} />
                {l as string}
              </span>
            ))}
          </div>

          <h4 style={{ color: C.white, fontSize: 12, margin: '0 0 8px' }}>
            Top catches ({(board.catches || []).length})
          </h4>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ color: C.dim, textAlign: 'left', borderBottom: `1px solid ${C.border}` }}>
                  {['day', 'symbol', 'mint', 'score', 'decision', 'peak24', 'x24h'].map(h => (
                    <th key={h} style={{ padding: '6px 8px', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(board.catches || []).map((c, i) => (
                  <tr key={`${c.mint}-${c.day}-${i}`} style={{ borderBottom: '1px solid rgba(28,58,49,0.4)' }}>
                    <td style={{ padding: '6px 8px', color: C.dim, whiteSpace: 'nowrap' }}>{c.day}</td>
                    <td style={{ padding: '6px 8px', color: C.white, fontWeight: 700, whiteSpace: 'nowrap' }}>{c.symbol || '?'}</td>
                    <td style={{ padding: '6px 8px', color: C.dim }}>
                      {c.mint.length > 14 ? `${c.mint.slice(0, 6)}…${c.mint.slice(-4)}` : c.mint}
                    </td>
                    <td style={{ padding: '6px 8px', color: C.accent }}>{c.score?.toFixed(1) ?? '—'}</td>
                    <td style={{ padding: '6px 8px', color: DECISION_COLOR[c.decision] || C.dim }}>{c.decision || '—'}</td>
                    <td style={{ padding: '6px 8px', color: C.white }}>{typeof c.peak24 === 'number' ? `${c.peak24.toFixed(2)}×` : '—'}</td>
                    <td style={{ padding: '6px 8px', color: C.white }}>{typeof c.x24h === 'number' ? `${c.x24h.toFixed(2)}×` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(board.catches || []).length === 0 && (
              <p style={{ color: C.dim, fontSize: 12 }}>no catches in this cohort window</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

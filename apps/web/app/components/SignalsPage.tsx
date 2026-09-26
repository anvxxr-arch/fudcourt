'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { C } from '../../lib/ui/shared';

type Sighting = { n: number; spanH: number; sources: number; surfaced: number };
type Social = { type: string; url: string };

type SignalRow = {
  id: number;
  ts: number;
  kind: string;
  chain: string;
  mint: string;
  symbol: string;
  name: string;
  url: string;
  mcap: number;
  liq?: number;
  price?: number;
  ageMin?: number;
  score?: number;
  decision?: string;
  source?: string;
  image?: string;
  holdersCount?: number;
  vetoes?: string[];
  volTrend?: number;
  topHolderPct?: number;
  nameReuse?: number;
  persistCount?: number;
  registryReuse?: number;
  sightings?: Sighting;
  socials?: Social[];
};

type Counts = { rows?: number; rh?: number; sol?: number; surfaced?: number; runs?: number; revivals?: number };
type Payload = {
  rows: SignalRow[];
  counts: Counts;
  generatedAt: number;
  pages?: number;
  page?: number;
  windowH?: number;
  solDelayMin?: number;
  upstream?: string;
  error?: string;
};

const CHAINS = [
  { key: 'solana', label: '◎ Solana', color: '#14f195' },
  { key: 'robinhood', label: '🪶 Robinhood Chain', color: '#3ddc97' },
] as const;
type ChainKey = (typeof CHAINS)[number]['key'];

const MODES = [
  { key: 'index', label: '168h index', hint: 'full 168h screening window. Carries only mcap/liq/score/decision — holders, top-holder % and sightings are absent on every row.' },
  { key: 'feed', label: '24h feed', hint: 'last 24h, 500 newest rows. Richer per row, but still sparse: measured 213/500 carry holders + top-holder %, 483/500 carry sightings/price/ageMin.' },
] as const;
type Mode = (typeof MODES)[number]['key'];

const DECISION_COLOR: Record<string, string> = {
  surfaced: C.green,
  watching: '#ffd166',
  'low score': C.dim,
  vetoed: C.red,
  blocked: C.red,
  bundle: '#ff9f43',
};

// A missing metric is NOT zero. Upstream omits fields per row (e.g. liq on
// 23 of 7730 solana rows), so every formatter renders an em-dash for
// undefined rather than coercing to 0.
const n2 = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 2 });

function usd(v: number) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

function ago(ts: number) {
  const m = Math.max(0, Math.floor((Date.now() / 1000 - ts) / 60));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

function shortAddr(a: string) {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export default function SignalsPage() {
  const [chain, setChain] = useState<ChainKey>('solana');
  const [mode, setMode] = useState<Mode>('index');
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [onlyDecision, setOnlyDecision] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/signals?chain=${chain}&type=${mode}`, { cache: 'no-store' });
      const json: Payload = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [chain, mode]);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const all = data?.rows || [];
    const needle = q.trim().toLowerCase();
    return all.filter(r => {
      if (onlyDecision && r.decision !== onlyDecision) return false;
      if (!needle) return true;
      return (
        r.symbol.toLowerCase().includes(needle) ||
        r.name.toLowerCase().includes(needle) ||
        r.mint.toLowerCase().includes(needle)
      );
    });
  }, [data, q, onlyDecision]);

  const decisions = useMemo(
    () => Array.from(new Set((data?.rows || []).map(r => r.decision).filter((d): d is string => !!d))).sort(),
    [data]
  );

  const stats = useMemo(() => {
    const all = data?.rows || [];
    const scored = all.filter(r => typeof r.score === 'number');
    const surfaced = all.filter(r => r.decision === 'surfaced');
    const withLiq = all.filter(r => typeof r.liq === 'number');
    const withHolders = all.filter(r => typeof r.holdersCount === 'number');
    const withSightings = all.filter(r => !!r.sightings);
    return {
      total: all.length,
      avgScore: scored.length ? scored.reduce((s, r) => s + (r.score as number), 0) / scored.length : null,
      surfaced: surfaced.length,
      vetoed: all.filter(r => r.decision === 'vetoed').length,
      liqCoverage: all.length ? Math.round((withLiq.length / all.length) * 100) : 0,
      holderCoverage: all.length ? Math.round((withHolders.length / all.length) * 100) : 0,
      sightingCoverage: all.length ? Math.round((withSightings.length / all.length) * 100) : 0,
    };
  }, [data]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <div>
          <h3 style={{ color: C.accent, margin: 0 }}>Signals Feed</h3>
          <p style={{ color: C.dim, fontSize: 10, margin: '2px 0 0' }}>
            read-only screening output · {data ? `${data.windowH}h window` : '—'}
            {data?.solDelayMin ? ` · solana delayed ${data.solDelayMin}m` : ''}
            {' · '}not trading signals, not financial advice
          </p>
        </div>
        <button onClick={load} style={{ background: C.card, color: C.white, border: `1px solid ${C.border}`, padding: '6px 14px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
          ↻ Refresh
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        {CHAINS.map(c => (
          <button
            key={c.key}
            onClick={() => setChain(c.key)}
            style={{
              background: chain === c.key ? c.color : C.card,
              color: chain === c.key ? '#04140f' : C.dim,
              border: `1px solid ${C.border}`,
              padding: '6px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer', fontWeight: 700,
            }}
          >
            {c.label}
          </button>
        ))}

        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="filter symbol / name / mint…"
          style={{
            flex: '1 1 200px', minWidth: 160, background: C.card, color: C.white,
            border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 11, outline: 'none',
          }}
        />

        <select
          value={onlyDecision}
          onChange={e => setOnlyDecision(e.target.value)}
          style={{ background: C.card, color: C.white, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 11 }}
        >
          <option value="">all decisions</option>
          {decisions.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {MODES.map(m => (
          <button
            key={m.key}
            onClick={() => setMode(m.key)}
            title={m.hint}
            style={{
              background: mode === m.key ? C.accent : C.card,
              color: mode === m.key ? '#04140f' : C.dim,
              border: `1px solid ${C.border}`, padding: '5px 10px', borderRadius: 6,
              fontSize: 10, cursor: 'pointer', fontWeight: 700,
            }}
          >
            {m.label}
          </button>
        ))}
        {data?.windowH !== undefined && (
          <span style={{ color: C.dim, fontSize: 10, alignSelf: 'center' }}>
            window {data.windowH}h · {stats.liqCoverage}% liq coverage
            {stats.holderCoverage < 100 && ` · ${stats.holderCoverage}% holders`}
          </span>
        )}
      </div>

      {error && (
        <p style={{ color: C.red, fontSize: 12, background: 'rgba(255,107,107,0.08)', border: `1px solid ${C.red}`, borderRadius: 6, padding: 8 }}>
          upstream failed: {error} — no data faked, retry or check data-public.vercel.app
        </p>
      )}

      {!error && data && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, fontSize: 10 }}>
          {[
            ['rows', n2(stats.total)],
            ['avg score', stats.avgScore === null ? '—' : stats.avgScore.toFixed(1)],
            ['surfaced', n2(stats.surfaced)],
            ['vetoed', n2(stats.vetoed)],
            ['liq coverage', `${stats.liqCoverage}%`],
            ['generated', new Date(data.generatedAt * 1000).toISOString().replace('T', ' ').slice(0, 16)],
          ].map(([k, v]) => (
            <div key={k} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 10px' }}>
              <span style={{ color: C.dim }}>{k} </span>
              <span style={{ color: C.accent, fontWeight: 700 }}>{v}</span>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <p style={{ color: C.dim, fontSize: 12 }}>loading signals…</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ color: C.dim, textAlign: 'left', borderBottom: `1px solid ${C.border}` }}>
                {['age', 'token', 'decision', 'score', 'mcap', 'liq', 'price', 'holders', 'top%', 'sight', 'src', 'kind'].map(h => (
                  <th key={h} style={{ padding: '6px 8px', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 300).map(r => (
                <tr
                  key={`${r.id}-${r.mint}`}
                  onClick={() => window.open(r.url, '_blank')}
                  style={{ borderBottom: '1px solid rgba(28,58,49,0.4)', cursor: 'pointer' }}
                  onMouseOver={e => { e.currentTarget.style.background = 'rgba(61,220,151,0.05)'; }}
                  onMouseOut={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <td style={{ padding: '6px 8px', color: C.dim, whiteSpace: 'nowrap' }}>{ago(r.ts)}</td>
                  <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {r.image
                        ? <img src={r.image} alt="" style={{ width: 16, height: 16, borderRadius: '50%' }} />
                        : <span style={{ width: 16, height: 16, borderRadius: '50%', background: C.border, display: 'inline-block' }} />}
                      <span style={{ color: C.white, fontWeight: 700 }}>{r.symbol || '?'}</span>
                      <span style={{ color: C.dim }}>{shortAddr(r.mint)}</span>
                    </span>
                  </td>
                  <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                    {r.decision
                      ? <span style={{ color: DECISION_COLOR[r.decision] || C.dim }}>{r.decision}</span>
                      : <span style={{ color: C.dim }}>—</span>}
                  </td>
                  <td style={{ padding: '6px 8px', color: C.accent }}>{typeof r.score === 'number' ? r.score.toFixed(1) : '—'}</td>
                  <td style={{ padding: '6px 8px', color: C.white }}>{usd(r.mcap)}</td>
                  <td style={{ padding: '6px 8px', color: C.white }}>{typeof r.liq === 'number' ? usd(r.liq) : '—'}</td>
                  <td style={{ padding: '6px 8px', color: C.white }}>{typeof r.price === 'number' ? `$${r.price.toPrecision(4)}` : '—'}</td>
                  <td style={{ padding: '6px 8px', color: C.white }}>{typeof r.holdersCount === 'number' ? n2(r.holdersCount) : '—'}</td>
                  <td style={{ padding: '6px 8px', color: C.white }}>{typeof r.topHolderPct === 'number' ? `${r.topHolderPct.toFixed(1)}%` : '—'}</td>
                  <td style={{ padding: '6px 8px', color: C.dim }}>
                    {r.sightings ? `${r.sightings.n}×/${r.sightings.spanH}h` : typeof r.persistCount === 'number' ? `×${r.persistCount}` : '—'}
                  </td>
                  <td style={{ padding: '6px 8px', color: C.dim }}>{r.source || '—'}</td>
                  <td style={{ padding: '6px 8px', color: C.dim }}>{r.kind}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && !loading && (
            <p style={{ color: C.dim, fontSize: 12, marginTop: 10 }}>no rows match filter</p>
          )}
          {rows.length > 300 && (
            <p style={{ color: C.dim, fontSize: 10, marginTop: 8 }}>
              showing first 300 of {n2(rows.length)} — narrow the filter to see more
            </p>
          )}
        </div>
      )}
    </div>
  );
}

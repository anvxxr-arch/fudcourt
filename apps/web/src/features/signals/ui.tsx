'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { C } from '@/styles/shared';

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
  { key: 'all', label: '⧉ Both', color: '#ffd166' },
] as const;
type ChainKey = (typeof CHAINS)[number]['key'];

// chain=all is a merged view, so its per-row breakdown comes from the row's
// own `chain` field -- the header counts (rh/sol) are the reliable totals.
const MERGED: ChainKey[] = ['all'];

const MODES = [
  { key: 'index', label: '168h index', hint: 'full 168h screening window. Carries only mcap/liq/score/decision — holders, top-holder % and sightings are absent on every row. chain=all is not offered upstream for this mode.', chains: ['solana', 'robinhood'] as ChainKey[] },
  { key: 'feed', label: '24h feed', hint: 'last 24h, 500 newest rows. Richer per row, but still sparse: measured 213/500 carry holders + top-holder %, 483/500 carry sightings/price/ageMin.', chains: ['solana', 'robinhood', 'all'] as ChainKey[] },
  { key: 'page', label: 'paged', hint: 'same data as the feed, paged 500 rows at a time. Upstream serves pages 2..10 only — page 1 is the feed.', chains: ['solana', 'robinhood', 'all'] as ChainKey[] },
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
  const [page, setPage] = useState(2);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [onlyDecision, setOnlyDecision] = useState('');

  const activeMode = MODES.find(m => m.key === mode) || MODES[0];
  const chainAllowed = activeMode.chains.includes(chain);

  // Switching to a mode that does not serve the current chain must reset the
  // chain, or the next load 400s against upstream.
  useEffect(() => {
    if (!chainAllowed) setChain(activeMode.chains[0]);
  }, [chainAllowed, activeMode]);

  const load = useCallback(async () => {
    if (!chainAllowed) return;
    setLoading(true);
    setError('');
    try {
      const suffix = mode === 'page' ? `&n=${page}` : '';
      const res = await fetch(`/api/signals?chain=${chain}&type=${mode}${suffix}`, { cache: 'no-store' });
      const json: Payload = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [chain, mode, page, chainAllowed]);

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
        {CHAINS.map(c => {
          const allowed = activeMode.chains.includes(c.key);
          return (
            <button
              key={c.key}
              onClick={() => allowed && setChain(c.key)}
              disabled={!allowed}
              title={allowed ? c.label : `${c.label} is not served by the ${activeMode.label} endpoint`}
              style={{
                background: chain === c.key ? c.color : C.card,
                color: chain === c.key ? '#04140f' : allowed ? C.dim : 'rgba(107,143,130,0.35)',
                border: `1px solid ${C.border}`,
                padding: '6px 12px', borderRadius: 6, fontSize: 11,
                cursor: allowed ? 'pointer' : 'not-allowed',
                fontWeight: 700, textDecoration: allowed ? 'none' : 'line-through',
              }}
            >
              {c.label}
            </button>
          );
        })}

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
        {mode === 'page' && data?.pages && (
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', marginLeft: 6 }}>
            <button
              onClick={() => setPage(p => Math.max(2, p - 1))}
              disabled={page <= 2}
              style={{
                background: C.card, color: page <= 2 ? 'rgba(107,143,130,0.35)' : C.white,
                border: `1px solid ${C.border}`, padding: '5px 10px', borderRadius: 6,
                fontSize: 10, cursor: page <= 2 ? 'not-allowed' : 'pointer', fontWeight: 700,
              }}
            >
              ← prev
            </button>
            <span style={{ color: C.accent, fontSize: 10, fontWeight: 700 }}>
              page {data.page ?? page} / {data.pages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(data.pages || 10, p + 1))}
              disabled={page >= (data.pages || 10)}
              style={{
                background: C.card, color: page >= (data.pages || 10) ? 'rgba(107,143,130,0.35)' : C.white,
                border: `1px solid ${C.border}`, padding: '5px 10px', borderRadius: 6,
                fontSize: 10, cursor: page >= (data.pages || 10) ? 'not-allowed' : 'pointer', fontWeight: 700,
              }}
            >
              next →
            </button>
            <span style={{ color: C.dim, fontSize: 10 }}>page 1 = feed</span>
          </span>
        )}
        {data?.windowH !== undefined && (
          <span style={{ color: C.dim, fontSize: 10, alignSelf: 'center' }}>
            window {data.windowH}h · {stats.liqCoverage}% liq coverage
            {stats.holderCoverage < 100 && ` · ${stats.holderCoverage}% holders`}
            {MERGED.includes(chain) && data.counts.rh !== undefined && data.counts.sol !== undefined &&
              ` · ${data.counts.rh} rh / ${data.counts.sol} sol`}
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
      ) : error && !data ? (
        // A failed fetch with nothing cached must NOT render as a zero-row
        // table. An empty grid with "no rows match filter" reads as a
        // legitimate empty result, which is exactly the silent fake this
        // project must never produce.
        <p style={{ color: C.red, fontSize: 12 }}>
          no data loaded — the table is withheld because the upstream fetch failed.
        </p>
      ) : error && data ? (
        // Stale-but-real data is still worth showing, provided it is labelled
        // with the timestamp it was actually generated at.
        <p style={{ color: '#ff9f43', fontSize: 11, marginBottom: 8 }}>
          ⚠ stale — showing the last successful load from{' '}
          {new Date(data.generatedAt * 1000).toISOString().replace('T', ' ').slice(0, 16)}
          , not live data. Refresh failed: {error}
        </p>
      ) : null}

      {!loading && data && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ color: C.dim, textAlign: 'left', borderBottom: `1px solid ${C.border}` }}>
                {['age', ...(MERGED.includes(chain) ? ['chain'] : []), 'token', 'decision', 'score', 'mcap', 'liq', 'price', 'holders', 'top%', 'sight', 'src', 'kind'].map(h => (
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
                  {MERGED.includes(chain) && (
                    <td style={{ padding: '6px 8px', color: r.chain === 'robinhood' ? C.accent : '#14f195', whiteSpace: 'nowrap' }}>
                      {r.chain === 'robinhood' ? '🪶 rh' : r.chain === 'solana' ? '◎ sol' : r.chain || '—'}
                    </td>
                  )}
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
            <p style={{ color: C.dim, fontSize: 12, marginTop: 10 }}>
              {error ? 'upstream failed — row list withheld, not empty' : 'no rows match filter'}
            </p>
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

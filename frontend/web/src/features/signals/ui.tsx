'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { alpha, color, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { Loading } from '@/components/ui/feedback';
import { chainColor } from '@/styles/shared';
import { Table, TBody, THead } from '@/components/ui/table';
import { Toolbar } from '@/components/ui/toolbar';

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
  { key: 'solana', label: '◎ Solana', color: chainColor('solana') },
  { key: 'robinhood', label: '🪶 Robinhood Chain', color: chainColor('robinhood') },
  { key: 'all', label: '⧉ Both', color: color.warn },
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
  surfaced: color.accent,
  watching: color.warn,
  'low score': color.textMuted,
  vetoed: color.negative,
  blocked: color.negative,
  bundle: color.attention,
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
      <Toolbar style={{ flexWrap: 'wrap', gap: space[10] }}>
        <div>
          <h3 style={{ color: color.accent, margin: 0 }}>Signals Feed</h3>
          <p style={{ color: color.textMuted, fontSize: fontSize[10], margin: '2px 0 0' }}>
            read-only screening output · {data ? `${data.windowH}h window` : '—'}
            {data?.solDelayMin ? ` · solana delayed ${data.solDelayMin}m` : ''}
            {' · '}not trading signals, not financial advice
          </p>
        </div>
        <button onClick={load} style={{ background: color.surface, color: color.text, border: `1px solid ${color.border}`, padding: `${space[6]}px ${space[14]}px`, borderRadius: radius[6], fontSize: fontSize[11], cursor: 'pointer' }}>
          ↻ Refresh
        </button>
      </Toolbar>

      <div style={{ display: 'flex', gap: space[8], alignItems: 'center', flexWrap: 'wrap', marginBottom: space[10] }}>
        {CHAINS.map(c => {
          const allowed = activeMode.chains.includes(c.key);
          return (
            <button
              key={c.key}
              onClick={() => allowed && setChain(c.key)}
              disabled={!allowed}
              title={allowed ? c.label : `${c.label} is not served by the ${activeMode.label} endpoint`}
              style={{
                background: chain === c.key ? c.color : color.surface,
                color: chain === c.key ? color.textOnAccent : allowed ? color.textMuted : alpha(color.textMuted, 0.35),
                border: `1px solid ${color.border}`,
                padding: `${space[6]}px ${space[12]}px`, borderRadius: radius[6], fontSize: fontSize[11],
                cursor: allowed ? 'pointer' : 'not-allowed',
                fontWeight: fontWeight.bold, textDecoration: allowed ? 'none' : 'line-through',
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
            flex: '1 1 200px', minWidth: 160, background: color.surface, color: color.text,
            border: `1px solid ${color.border}`, borderRadius: radius[6], padding: `${space[6]}px ${space[10]}px`, fontSize: fontSize[11], outline: 'none',
          }}
        />

        <select
          value={onlyDecision}
          onChange={e => setOnlyDecision(e.target.value)}
          style={{ background: color.surface, color: color.text, border: `1px solid ${color.border}`, borderRadius: radius[6], padding: `${space[6]}px ${space[8]}px`, fontSize: fontSize[11] }}
        >
          <option value="">all decisions</option>
          {decisions.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', gap: space[6], marginBottom: space[12], flexWrap: 'wrap' }}>
        {MODES.map(m => (
          <button
            key={m.key}
            onClick={() => setMode(m.key)}
            title={m.hint}
            style={{
              background: mode === m.key ? color.accent : color.surface,
              color: mode === m.key ? color.textOnAccent : color.textMuted,
              border: `1px solid ${color.border}`, padding: '5px 10px', borderRadius: radius[6],
              fontSize: fontSize[10], cursor: 'pointer', fontWeight: fontWeight.bold,
            }}
          >
            {m.label}
          </button>
        ))}
        {mode === 'page' && data?.pages && (
          <span style={{ display: 'inline-flex', gap: space[4], alignItems: 'center', marginLeft: space[6] }}>
            <button
              onClick={() => setPage(p => Math.max(2, p - 1))}
              disabled={page <= 2}
              style={{
                background: color.surface, color: page <= 2 ? alpha(color.textMuted, 0.35) : color.text,
                border: `1px solid ${color.border}`, padding: '5px 10px', borderRadius: radius[6],
                fontSize: fontSize[10], cursor: page <= 2 ? 'not-allowed' : 'pointer', fontWeight: fontWeight.bold,
              }}
            >
              ← prev
            </button>
            <span style={{ color: color.accent, fontSize: fontSize[10], fontWeight: fontWeight.bold }}>
              page {data.page ?? page} / {data.pages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(data.pages || 10, p + 1))}
              disabled={page >= (data.pages || 10)}
              style={{
                background: color.surface, color: page >= (data.pages || 10) ? alpha(color.textMuted, 0.35) : color.text,
                border: `1px solid ${color.border}`, padding: '5px 10px', borderRadius: radius[6],
                fontSize: fontSize[10], cursor: page >= (data.pages || 10) ? 'not-allowed' : 'pointer', fontWeight: fontWeight.bold,
              }}
            >
              next →
            </button>
            <span style={{ color: color.textMuted, fontSize: fontSize[10] }}>page 1 = feed</span>
          </span>
        )}
        {data?.windowH !== undefined && (
          <span style={{ color: color.textMuted, fontSize: fontSize[10], alignSelf: 'center' }}>
            window {data.windowH}h · {stats.liqCoverage}% liq coverage
            {stats.holderCoverage < 100 && ` · ${stats.holderCoverage}% holders`}
            {MERGED.includes(chain) && data.counts.rh !== undefined && data.counts.sol !== undefined &&
              ` · ${data.counts.rh} rh / ${data.counts.sol} sol`}
          </span>
        )}
      </div>

      {error && (
        <p style={{ color: color.negative, fontSize: fontSize[12], background: alpha(color.negative, 0.08), border: `1px solid ${color.negative}`, borderRadius: radius[6], padding: space[8] }}>
          upstream failed: {error} — no data faked, retry or check data-public.vercel.app
        </p>
      )}

      {!error && data && (
        <div style={{ display: 'flex', gap: space[8], flexWrap: 'wrap', marginBottom: space[12], fontSize: fontSize[10] }}>
          {[
            ['rows', n2(stats.total)],
            ['avg score', stats.avgScore === null ? '—' : stats.avgScore.toFixed(1)],
            ['surfaced', n2(stats.surfaced)],
            ['vetoed', n2(stats.vetoed)],
            ['liq coverage', `${stats.liqCoverage}%`],
            ['generated', new Date(data.generatedAt * 1000).toISOString().replace('T', ' ').slice(0, 16)],
          ].map(([k, v]) => (
            <div key={k} style={{ background: color.surface, border: `1px solid ${color.border}`, borderRadius: radius[6], padding: `${space[6]}px ${space[10]}px` }}>
              <span style={{ color: color.textMuted }}>{k} </span>
              <span style={{ color: color.accent, fontWeight: fontWeight.bold }}>{v}</span>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <Loading label="loading signals…" />
      ) : error && !data ? (
        // A failed fetch with nothing cached must NOT render as a zero-row
        // table. An empty grid with "no rows match filter" reads as a
        // legitimate empty result, which is exactly the silent fake this
        // project must never produce.
        <p style={{ color: color.negative, fontSize: fontSize[12] }}>
          no data loaded — the table is withheld because the upstream fetch failed.
        </p>
      ) : error && data ? (
        // Stale-but-real data is still worth showing, provided it is labelled
        // with the timestamp it was actually generated at.
        <p style={{ color: color.attention, fontSize: fontSize[11], marginBottom: space[8] }}>
          ⚠ stale — showing the last successful load from{' '}
          {new Date(data.generatedAt * 1000).toISOString().replace('T', ' ').slice(0, 16)}
          , not live data. Refresh failed: {error}
        </p>
      ) : null}

      {!loading && data && (
        <div style={{ overflowX: 'auto' }}>
          <Table style={{ fontSize: fontSize[11] }}>
            <THead>
              <tr style={{ color: color.textMuted, textAlign: 'left', borderBottom: `1px solid ${color.border}` }}>
                {['age', ...(MERGED.includes(chain) ? ['chain'] : []), 'token', 'decision', 'score', 'mcap', 'liq', 'price', 'holders', 'top%', 'sight', 'src', 'kind'].map(h => (
                  <th key={h} style={{ padding: `${space[6]}px ${space[8]}px`, fontWeight: fontWeight.medium, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </THead>
            <TBody>
              {rows.slice(0, 300).map(r => (
                <tr
                  key={`${r.id}-${r.mint}`}
                  onClick={() => window.open(r.url, '_blank')}
                  style={{ borderBottom: `1px solid ${alpha(color.border, 0.4)}`, cursor: 'pointer' }}
                  onMouseOver={e => { e.currentTarget.style.background = alpha(color.accent, 0.05); }}
                  onMouseOut={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <td style={{ padding: `${space[6]}px ${space[8]}px`, color: color.textMuted, whiteSpace: 'nowrap' }}>{ago(r.ts)}</td>
                  {MERGED.includes(chain) && (
                    <td style={{ padding: `${space[6]}px ${space[8]}px`, color: r.chain === 'robinhood' ? chainColor('robinhood') : chainColor('solana'), whiteSpace: 'nowrap' }}>
                      {r.chain === 'robinhood' ? '🪶 rh' : r.chain === 'solana' ? '◎ sol' : r.chain || '—'}
                    </td>
                  )}
                  <td style={{ padding: `${space[6]}px ${space[8]}px`, whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: space[6] }}>
                      {r.image
                        ? <img src={r.image} alt="" style={{ width: space[16], height: space[16], borderRadius: radius.circle }} />
                        : <span style={{ width: space[16], height: space[16], borderRadius: radius.circle, background: color.border, display: 'inline-block' }} />}
                      <span style={{ color: color.text, fontWeight: fontWeight.bold }}>{r.symbol || '?'}</span>
                      <span style={{ color: color.textMuted }}>{shortAddr(r.mint)}</span>
                    </span>
                  </td>
                  <td style={{ padding: `${space[6]}px ${space[8]}px`, whiteSpace: 'nowrap' }}>
                    {r.decision
                      ? <span style={{ color: DECISION_COLOR[r.decision] || color.textMuted }}>{r.decision}</span>
                      : <span style={{ color: color.textMuted }}>—</span>}
                  </td>
                  <td style={{ padding: `${space[6]}px ${space[8]}px`, color: color.accent }}>{typeof r.score === 'number' ? r.score.toFixed(1) : '—'}</td>
                  <td style={{ padding: `${space[6]}px ${space[8]}px`, color: color.text }}>{usd(r.mcap)}</td>
                  <td style={{ padding: `${space[6]}px ${space[8]}px`, color: color.text }}>{typeof r.liq === 'number' ? usd(r.liq) : '—'}</td>
                  <td style={{ padding: `${space[6]}px ${space[8]}px`, color: color.text }}>{typeof r.price === 'number' ? `$${r.price.toPrecision(4)}` : '—'}</td>
                  <td style={{ padding: `${space[6]}px ${space[8]}px`, color: color.text }}>{typeof r.holdersCount === 'number' ? n2(r.holdersCount) : '—'}</td>
                  <td style={{ padding: `${space[6]}px ${space[8]}px`, color: color.text }}>{typeof r.topHolderPct === 'number' ? `${r.topHolderPct.toFixed(1)}%` : '—'}</td>
                  <td style={{ padding: `${space[6]}px ${space[8]}px`, color: color.textMuted }}>
                    {r.sightings ? `${r.sightings.n}×/${r.sightings.spanH}h` : typeof r.persistCount === 'number' ? `×${r.persistCount}` : '—'}
                  </td>
                  <td style={{ padding: `${space[6]}px ${space[8]}px`, color: color.textMuted }}>{r.source || '—'}</td>
                  <td style={{ padding: `${space[6]}px ${space[8]}px`, color: color.textMuted }}>{r.kind}</td>
                </tr>
              ))}
            </TBody>
          </Table>
          {rows.length === 0 && !loading && (
            <p style={{ color: color.textMuted, fontSize: fontSize[12], marginTop: space[10] }}>
              {error ? 'upstream failed — row list withheld, not empty' : 'no rows match filter'}
            </p>
          )}
          {rows.length > 300 && (
            <p style={{ color: color.textMuted, fontSize: fontSize[10], marginTop: space[8] }}>
              showing first 300 of {n2(rows.length)} — narrow the filter to see more
            </p>
          )}
        </div>
      )}
    </div>
  );
}

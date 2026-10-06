'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { alpha, themeColor, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { Loading } from '@/ui/feedback';
import { Toolbar } from '@/ui/toolbar';
import { fetchSignals } from './client';
import { CHAINS, MERGED, MODES, n2 } from './model';
import type { ChainKey, Mode, Payload } from './model';
import { SignalsTable } from './signals-table';

export type { ChainKey, Counts, Mode, Payload, SignalRow, Sighting, Social } from './model';
export { CHAINS, DECISION_COLOR, MERGED, MODES, ago, n2, shortAddr, usd } from './model';
export { SignalsTable };

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
      const json = await fetchSignals<Payload>(chain, mode, suffix);
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
      <Toolbar style={{ flexWrap: 'wrap', gap: space[8] }}>
        <div>
          <h2 style={{ color: themeColor.blue, margin: 0, fontSize: fontSize[17] }}>Signals Feed</h2>
          <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], margin: '2px 0 0' }}>
            read-only screening output · {data ? `${data.windowH}h window` : '—'}
            {data?.solDelayMin ? ` · solana delayed ${data.solDelayMin}m` : ''}
            {' · '}not trading signals, not financial advice
          </p>
        </div>
        <button onClick={load} style={{ background: themeColor.bgSecondary, color: themeColor.labelPrimary, border: `1px solid ${themeColor.separator}`, padding: `${space[8]}px ${space[12]}px`, borderRadius: radius[8], fontSize: fontSize[11], cursor: 'pointer' }}>
          ↻ Refresh
        </button>
      </Toolbar>

      <div style={{ display: 'flex', gap: space[8], alignItems: 'center', flexWrap: 'wrap', marginBottom: space[8] }}>
        {CHAINS.map(c => {
          const allowed = activeMode.chains.includes(c.key);
          return (
            <button
              key={c.key}
              onClick={() => allowed && setChain(c.key)}
              disabled={!allowed}
              title={allowed ? c.label : `${c.label} is not served by the ${activeMode.label} endpoint`}
              style={{
                background: chain === c.key ? c.color : themeColor.bgSecondary,
                color: chain === c.key ? themeColor.labelPrimary : allowed ? themeColor.labelSecondary : alpha(themeColor.labelTertiary, 0.35),
                border: `1px solid ${themeColor.separator}`,
                padding: `${space[8]}px ${space[12]}px`, borderRadius: radius[8], fontSize: fontSize[11],
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
            flex: '1 1 200px', minWidth: 160, background: themeColor.bgSecondary, color: themeColor.labelPrimary,
            border: `1px solid ${themeColor.separator}`, borderRadius: radius[8], padding: `${space[8]}px ${space[8]}px`, fontSize: fontSize[11], outline: 'none',
          }}
        />

        <select
          aria-label="Filter by decision"
          value={onlyDecision}
          onChange={e => setOnlyDecision(e.target.value)}
          style={{ background: themeColor.bgSecondary, color: themeColor.labelPrimary, border: `1px solid ${themeColor.separator}`, borderRadius: radius[8], padding: `${space[8]}px ${space[8]}px`, fontSize: fontSize[11] }}
        >
          <option value="">all decisions</option>
          {decisions.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', gap: space[8], marginBottom: space[12], flexWrap: 'wrap' }}>
        {MODES.map(m => (
          <button
            key={m.key}
            onClick={() => setMode(m.key)}
            title={m.hint}
            style={{
              background: mode === m.key ? themeColor.blue : themeColor.bgSecondary,
              color: mode === m.key ? themeColor.labelOnAccent : themeColor.labelSecondary,
              border: `1px solid ${themeColor.separator}`, padding: '5px 10px', borderRadius: radius[8],
              fontSize: fontSize[11], cursor: 'pointer', fontWeight: fontWeight.bold,
            }}
          >
            {m.label}
          </button>
        ))}
        {mode === 'page' && data?.pages && (
          <span style={{ display: 'inline-flex', gap: space[4], alignItems: 'center', marginLeft: space[8] }}>
            <button
              onClick={() => setPage(p => Math.max(2, p - 1))}
              disabled={page <= 2}
              style={{
                background: themeColor.bgSecondary, color: page <= 2 ? alpha(themeColor.labelTertiary, 0.35) : themeColor.labelPrimary,
                border: `1px solid ${themeColor.separator}`, padding: '5px 10px', borderRadius: radius[8],
                fontSize: fontSize[11], cursor: page <= 2 ? 'not-allowed' : 'pointer', fontWeight: fontWeight.bold,
              }}
            >
              ← prev
            </button>
            <span style={{ color: themeColor.blue, fontSize: fontSize[11], fontWeight: fontWeight.bold }}>
              page {data.page ?? page} / {data.pages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(data.pages || 10, p + 1))}
              disabled={page >= (data.pages || 10)}
              style={{
                background: themeColor.bgSecondary, color: page >= (data.pages || 10) ? alpha(themeColor.labelTertiary, 0.35) : themeColor.labelPrimary,
                border: `1px solid ${themeColor.separator}`, padding: '5px 10px', borderRadius: radius[8],
                fontSize: fontSize[11], cursor: page >= (data.pages || 10) ? 'not-allowed' : 'pointer', fontWeight: fontWeight.bold,
              }}
            >
              next →
            </button>
            <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>page 1 = feed</span>
          </span>
        )}
        {data?.windowH !== undefined && (
          <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], alignSelf: 'center' }}>
            window {data.windowH}h · {stats.liqCoverage}% liq coverage
            {stats.holderCoverage < 100 && ` · ${stats.holderCoverage}% holders`}
            {MERGED.includes(chain) && data.counts.rh !== undefined && data.counts.sol !== undefined &&
              ` · ${data.counts.rh} rh / ${data.counts.sol} sol`}
          </span>
        )}
      </div>

      {error && (
        <p style={{ color: themeColor.red, fontSize: fontSize[12], background: alpha(themeColor.red, 0.08), border: `1px solid ${themeColor.red}`, borderRadius: radius[8], padding: space[8] }}>
          upstream failed: {error} — no data faked, retry or check data-public.vercel.app
        </p>
      )}

      {!error && data && (
        <div style={{ display: 'flex', gap: space[8], flexWrap: 'wrap', marginBottom: space[12], fontSize: fontSize[11] }}>
          {[
            ['rows', n2(stats.total)],
            ['avg score', stats.avgScore === null ? '—' : stats.avgScore.toFixed(1)],
            ['surfaced', n2(stats.surfaced)],
            ['vetoed', n2(stats.vetoed)],
            ['liq coverage', `${stats.liqCoverage}%`],
            ['generated', new Date(data.generatedAt * 1000).toISOString().replace('T', ' ').slice(0, 16)],
          ].map(([k, v]) => (
            <div key={k} style={{ background: themeColor.bgSecondary, border: `1px solid ${themeColor.separator}`, borderRadius: radius[8], padding: `${space[8]}px ${space[8]}px` }}>
              <span style={{ color: themeColor.labelTertiary }}>{k} </span>
              <span style={{ color: themeColor.blue, fontWeight: fontWeight.bold }}>{v}</span>
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
        <p style={{ color: themeColor.red, fontSize: fontSize[12] }}>
          no data loaded — the table is withheld because the upstream fetch failed.
        </p>
      ) : error && data ? (
        // Stale-but-real data is still worth showing, provided it is labelled
        // with the timestamp it was actually generated at.
        <p style={{ color: themeColor.orange, fontSize: fontSize[11], marginBottom: space[8] }}>
          ⚠ stale — showing the last successful load from{' '}
          {new Date(data.generatedAt * 1000).toISOString().replace('T', ' ').slice(0, 16)}
          , not live data. Refresh failed: {error}
        </p>
      ) : null}

      {!loading && data && (
        <SignalsTable rows={rows} chain={chain} loading={loading} data={data} error={error} />
      )}
    </div>
  );
}

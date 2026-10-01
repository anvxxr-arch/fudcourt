'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { C } from '@/styles/shared';
import type { LlamaChain, LlamaProtocol, LlamaHistoricalPoint } from './client';

/** Big-number USD: $1.23T / $45.6B / $789M. null -> em-dash, never 0. */
function usdBig(n: number | null | undefined, digits = 2) {
  if (n == null || Number.isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(digits)}T`;
  if (a >= 1e9) return `$${(n / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(digits)}M`;
  return `$${n.toFixed(0)}`;
}

function pct(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return '—';
  const s = `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
  return s;
}

function pctColor(n: number | null | undefined) {
  if (n == null) return C.dim;
  return n >= 0 ? '#22c55e' : C.red;
}

/**
 * DeFiLlama board through the /api/llama read proxy: total TVL history,
 * chain TVLs, top protocols.
 *
 * Every derived view (sorted chains, trimmed protocol head) is labelled with
 * the upstream's own totals -- the tables never imply they show more than the
 * `of N` line says. Reads only.
 */
export default function LlamaPage() {
  const [chains, setChains] = useState<LlamaChain[] | null>(null);
  const [protos, setProtos] = useState<LlamaProtocol[] | null>(null);
  const [hist, setHist] = useState<LlamaHistoricalPoint[] | null>(null);
  const [meta, setMeta] = useState<Record<string, string>>({});
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const hasData = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [cRes, pRes, hRes] = await Promise.all([
        fetch('/api/llama?mode=chains', { cache: 'no-store' }),
        fetch('/api/llama?mode=protocols&top=50', { cache: 'no-store' }),
        fetch('/api/llama?mode=historical&days=180', { cache: 'no-store' }),
      ]);
      const [cJson, pJson, hJson] = await Promise.all(
        [cRes, pRes, hRes].map((r) => r.json().catch(() => ({})))
      );
      if (!cRes.ok) throw new Error(cJson.error || `chains HTTP ${cRes.status}`);
      if (!pRes.ok) throw new Error(pJson.error || `protocols HTTP ${pRes.status}`);
      if (!hRes.ok) throw new Error(hJson.error || `historical HTTP ${hRes.status}`);

      setChains(cJson.rows ?? []);
      setProtos(pJson.rows ?? []);
      setHist(hJson.rows ?? []);
      setMeta({
        chains: cJson.derived ?? '',
        protocols: pJson.derived ?? '',
        historical: hJson.derived ?? '',
      });
      setTotals({
        chains: cJson.upstreamTotal ?? 0,
        protocols: pJson.upstreamTotal ?? 0,
        hist: hJson.upstreamTotal ?? 0,
      });
      setFetchedAt(Math.floor(Date.now() / 1000));
      setStale(false);
      hasData.current = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setStale(hasData.current);
      if (!hasData.current) {
        setChains(null);
        setProtos(null);
        setHist(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Total TVL + 1d change straight from the relayed history (arithmetic on
  // upstream points -- upstream itself has no "total today" field here).
  const last = hist && hist.length ? hist[hist.length - 1] : null;
  const prev = hist && hist.length > 1 ? hist[hist.length - 2] : null;
  const totalTvl = last?.tvl ?? null;
  const change1d = last && prev && prev.tvl ? ((last.tvl - prev.tvl) / prev.tvl) * 100 : null;

  // Sparkline geometry over the last 180 relayed days.
  const spark = (() => {
    if (!hist || hist.length < 2) return null;
    const vals = hist.map((h) => h.tvl);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const W = 600, H = 60;
    return vals
      .map((v, i) => `${((i / (vals.length - 1)) * W).toFixed(1)},${(H - ((v - min) / span) * H).toFixed(1)}`)
      .join(' ');
  })();

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <h3 style={{ color: C.white, fontSize: 15, fontWeight: 800 }}>DeFiLlama — TVL board</h3>
        <button onClick={load}
          style={{ background: C.card, color: C.white, border: `1px solid ${C.border}`, padding: '5px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
          ↻ Refresh
        </button>
        {fetchedAt != null && !stale && (
          <span style={{ color: C.dim, fontSize: 10 }}>{new Date(fetchedAt * 1000).toLocaleTimeString()}</span>
        )}
      </div>
      <p style={{ color: C.dim, fontSize: 10, margin: '0 0 10px' }}>
        read-only relay of api.llama.fi (chains + protocols head + TVL history) · tables are derived views — the
        “of N” line is upstream’s own total · em-dash means the field is absent upstream, never zero · CEX
        deposits sit in the protocols table but not in global TVL — upstream’s accounting, relayed as-is
      </p>

      {error && (
        <p style={{ color: C.red, fontSize: 12, fontWeight: 700, background: 'rgba(255,80,80,0.08)', border: '1px solid rgba(255,80,80,0.35)', padding: '8px 10px', borderRadius: 6, marginBottom: 8 }}>
          ⚠ defillama error: {error} — no data faked{stale ? ' · showing last good snapshot below, stamped' : ''}
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 12 }}>
        {[
          { k: 'total TVL', v: usdBig(totalTvl) },
          { k: '24h change', v: pct(change1d), color: pctColor(change1d) },
          { k: 'chains', v: totals.chains || '—' },
          { k: 'protocols', v: totals.protocols || '—' },
          { k: 'top chain', v: chains && chains[0] ? chains[0].name : '—' },
          { k: 'top protocol', v: protos && protos[0] ? protos[0].name : '—' },
        ].map((s) => (
          <div key={s.k} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ color: C.dim, fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.4 }}>{s.k}</div>
            <div style={{ color: s.color ?? C.white, fontSize: 15, fontWeight: 800, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.v}</div>
          </div>
        ))}
      </div>

      {spark && (
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
          <div style={{ color: C.dim, fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
            total TVL · {meta.historical}
          </div>
          <svg viewBox="0 0 600 60" width="100%" height="60" preserveAspectRatio="none">
            <polyline points={spark} fill="none" stroke={C.accent} strokeWidth="1.5" />
          </svg>
        </div>
      )}

      {loading ? (
        <p style={{ color: C.dim, fontSize: 12 }}>loading defillama…</p>
      ) : error && !chains ? (
        <p style={{ color: C.dim, fontSize: 12 }}>tables withheld — the request above failed.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <h4 style={{ color: C.white, fontSize: 12, fontWeight: 800 }}>chains by TVL</h4>
              <span style={{ color: C.dim, fontSize: 9 }}>top 15 of {totals.chains} · {meta.chains}</span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: C.dim, textAlign: 'left' }}>
                  <th style={{ padding: '4px 6px', width: 30 }}>#</th>
                  <th style={{ padding: '4px 6px' }}>chain</th>
                  <th style={{ padding: '4px 6px', textAlign: 'right' }}>TVL</th>
                </tr>
              </thead>
              <tbody>
                {(chains ?? []).slice(0, 15).map((c, i) => (
                  <tr key={c.name} style={{ borderTop: `1px solid ${C.border}` }}>
                    <td style={{ padding: '6px', color: i < 3 ? C.accent : C.dim, fontWeight: 700 }}>{i + 1}</td>
                    <td style={{ padding: '6px', color: C.white, fontWeight: 600 }}>{c.name}</td>
                    <td style={{ padding: '6px', textAlign: 'right', color: C.white }}>{usdBig(c.tvl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <h4 style={{ color: C.white, fontSize: 12, fontWeight: 800 }}>protocols by TVL</h4>
              <span style={{ color: C.dim, fontSize: 9 }}>{meta.protocols}</span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: C.dim, textAlign: 'left' }}>
                  <th style={{ padding: '4px 6px', width: 30 }}>#</th>
                  <th style={{ padding: '4px 6px' }}>protocol</th>
                  <th style={{ padding: '4px 6px', textAlign: 'right' }}>TVL</th>
                  <th style={{ padding: '4px 6px', textAlign: 'right' }}>1d</th>
                  <th style={{ padding: '4px 6px' }}>category</th>
                </tr>
              </thead>
              <tbody>
                {(protos ?? []).map((p, i) => (
                  <tr key={p.slug || p.name} style={{ borderTop: `1px solid ${C.border}` }}>
                    <td style={{ padding: '6px', color: i < 3 ? C.accent : C.dim, fontWeight: 700 }}>{i + 1}</td>
                    <td style={{ padding: '6px' }}>
                      <a href={p.url ?? undefined} target="_blank" rel="noopener nofollow"
                        style={{ color: C.white, textDecoration: 'none', fontWeight: 600 }}>{p.name}</a>
                      <div style={{ color: C.dim, fontSize: 9 }}>
                        {(p.chains ?? []).length === 1 ? '1 chain' : `${(p.chains ?? []).length} chains`}
                      </div>
                    </td>
                    <td style={{ padding: '6px', textAlign: 'right', color: C.white }}>{usdBig(p.tvl)}</td>
                    <td style={{ padding: '6px', textAlign: 'right', color: pctColor(p.change_1d) }}>{pct(p.change_1d)}</td>
                    <td style={{ padding: '6px', color: C.dim, fontSize: 10 }}>{p.category ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { alpha, color, fontSize, fontWeight, letterSpacing, radius, space } from '@/styles/tokens';
import { Banner } from '@/ui/banner';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';
import { fetchLlamaBoards, type LlamaChain, type LlamaProtocol, type LlamaHistoricalPoint } from './client';

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
  if (n == null) return color.labelTertiary;
  return n >= 0 ? color.green : color.red;
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
      const [cJson, pJson, hJson] = await fetchLlamaBoards();

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
      <div style={{ display: 'flex', alignItems: 'center', gap: space[8], flexWrap: 'wrap', marginBottom: space[8] }}>
        <h3 style={{ color: color.labelPrimary, fontSize: fontSize[17], fontWeight: fontWeight.bold }}>DeFiLlama — TVL board</h3>
        <button onClick={load}
          style={{ background: color.bgSecondary, color: color.labelPrimary, border: `1px solid ${color.separator}`, padding: '5px 12px', borderRadius: radius[8], fontSize: fontSize[11], cursor: 'pointer' }}>
          ↻ Refresh
        </button>
        {fetchedAt != null && !stale && (
          <span style={{ color: color.labelTertiary, fontSize: fontSize[11] }}>{new Date(fetchedAt * 1000).toLocaleTimeString()}</span>
        )}
      </div>
      <p style={{ color: color.labelTertiary, fontSize: fontSize[11], margin: `0 0 ${space[8]}px` }}>
        read-only relay of api.llama.fi (chains + protocols head + TVL history) · tables are derived views — the
        “of N” line is upstream’s own total · em-dash means the field is absent upstream, never zero · CEX
        deposits sit in the protocols table but not in global TVL — upstream’s accounting, relayed as-is
      </p>

      {error && (
        <Banner variant="error" style={{ fontWeight: fontWeight.bold, marginBottom: space[8] }}>
          ⚠ defillama error: {error} — no data faked{stale ? ' · showing last good snapshot below, stamped' : ''}
        </Banner>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: space[8], marginBottom: space[12] }}>
        {[
          { k: 'total TVL', v: usdBig(totalTvl) },
          { k: '24h change', v: pct(change1d), color: pctColor(change1d) },
          { k: 'chains', v: totals.chains || '—' },
          { k: 'protocols', v: totals.protocols || '—' },
          { k: 'top chain', v: chains && chains[0] ? chains[0].name : '—' },
          { k: 'top protocol', v: protos && protos[0] ? protos[0].name : '—' },
        ].map((s) => (
          <div key={s.k} style={{ background: color.bgSecondary, border: `1px solid ${color.separator}`, borderRadius: radius[8], padding: `${space[8]}px ${space[8]}px` }}>
            <div style={{ color: color.labelTertiary, fontSize: fontSize[11], textTransform: 'uppercase', letterSpacing: letterSpacing.xs }}>{s.k}</div>
            <div style={{ color: s.color ?? color.labelPrimary, fontSize: fontSize[17], fontWeight: fontWeight.bold, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.v}</div>
          </div>
        ))}
      </div>

      {spark && (
        <div style={{ background: color.bgSecondary, border: `1px solid ${color.separator}`, borderRadius: radius[8], padding: `${space[8]}px ${space[12]}px`, marginBottom: space[12] }}>
          <div style={{ color: color.labelTertiary, fontSize: fontSize[11], textTransform: 'uppercase', letterSpacing: letterSpacing.xs, marginBottom: space[8] }}>
            total TVL · {meta.historical}
          </div>
          <svg viewBox="0 0 600 60" width="100%" height="60" preserveAspectRatio="none">
            <polyline points={spark} fill="none" stroke={color.blue} strokeWidth="1.5" />
          </svg>
        </div>
      )}

      {loading ? (
        <p style={{ color: color.labelTertiary, fontSize: fontSize[12] }}>loading defillama…</p>
      ) : error && !chains ? (
        <p style={{ color: color.labelTertiary, fontSize: fontSize[12] }}>tables withheld — the request above failed.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: space[12] }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[4] }}>
              <h4 style={{ color: color.labelPrimary, fontSize: fontSize[12], fontWeight: fontWeight.bold }}>chains by TVL</h4>
              <span style={{ color: color.labelTertiary, fontSize: fontSize[11] }}>top 15 of {totals.chains} · {meta.chains}</span>
            </div>
            <Table style={{ fontSize: fontSize[12] }}>
              <THead>
                <TR style={{ borderBottom: 0 }}>
                  <TH style={{ padding: `${space[4]}px ${space[8]}px`, width: space[32], fontWeight: fontWeight.bold }}>#</TH>
                  <TH style={{ padding: `${space[4]}px ${space[8]}px`, fontWeight: fontWeight.bold }}>chain</TH>
                  <TH align="right" style={{ padding: `${space[4]}px ${space[8]}px`, fontWeight: fontWeight.bold }}>TVL</TH>
                </TR>
              </THead>
              <TBody>
                {(chains ?? []).slice(0, 15).map((c, i) => (
                  <TR key={c.name} style={{ borderTop: `1px solid ${color.separator}`, borderBottom: 0 }}>
                    <TD style={{ padding: `${space[8]}px`, color: i < 3 ? color.blue : color.labelTertiary, fontWeight: fontWeight.bold }}>{i + 1}</TD>
                    <TD style={{ padding: `${space[8]}px`, color: color.labelPrimary, fontWeight: fontWeight.semibold }}>{c.name}</TD>
                    <TD align="right" style={{ padding: `${space[8]}px`, color: color.labelPrimary }}>{usdBig(c.tvl)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[4] }}>
              <h4 style={{ color: color.labelPrimary, fontSize: fontSize[12], fontWeight: fontWeight.bold }}>protocols by TVL</h4>
              <span style={{ color: color.labelTertiary, fontSize: fontSize[11] }}>{meta.protocols}</span>
            </div>
            <Table style={{ fontSize: fontSize[12] }}>
              <THead>
                <TR style={{ borderBottom: 0 }}>
                  <TH style={{ padding: `${space[4]}px ${space[8]}px`, width: space[32], fontWeight: fontWeight.bold }}>#</TH>
                  <TH style={{ padding: `${space[4]}px ${space[8]}px`, fontWeight: fontWeight.bold }}>protocol</TH>
                  <TH align="right" style={{ padding: `${space[4]}px ${space[8]}px`, fontWeight: fontWeight.bold }}>TVL</TH>
                  <TH align="right" style={{ padding: `${space[4]}px ${space[8]}px`, fontWeight: fontWeight.bold }}>1d</TH>
                  <TH style={{ padding: `${space[4]}px ${space[8]}px`, fontWeight: fontWeight.bold }}>category</TH>
                </TR>
              </THead>
              <TBody>
                {(protos ?? []).map((p, i) => (
                  <TR key={p.slug || p.name} style={{ borderTop: `1px solid ${color.separator}`, borderBottom: 0 }}>
                    <TD style={{ padding: `${space[8]}px`, color: i < 3 ? color.blue : color.labelTertiary, fontWeight: fontWeight.bold }}>{i + 1}</TD>
                    <TD style={{ padding: `${space[8]}px` }}>
                      <span
                        style={{ color: color.labelPrimary, textDecoration: 'none', fontWeight: fontWeight.semibold }}>{p.name}</span>
                      <div style={{ color: color.labelTertiary, fontSize: fontSize[11] }}>
                        {(p.chains ?? []).length === 1 ? '1 chain' : `${(p.chains ?? []).length} chains`}
                      </div>
                    </TD>
                    <TD align="right" style={{ padding: `${space[8]}px`, color: color.labelPrimary }}>{usdBig(p.tvl)}</TD>
                    <TD align="right" style={{ padding: `${space[8]}px`, color: pctColor(p.change_1d) }}>{pct(p.change_1d)}</TD>
                    <TD style={{ padding: `${space[8]}px`, color: color.labelTertiary, fontSize: fontSize[11] }}>{p.category ?? '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}

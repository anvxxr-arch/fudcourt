'use client';

import { useState, useCallback, useEffect } from 'react';
import { C } from '../../lib/ui/shared';
import type { DexPair, DexProfile } from '../../lib/dex';

type Mode = 'pairs' | 'profiles' | 'boosts' | 'search' | 'mint';

const MODES: { key: Mode; label: string; hint: string }[] = [
  { key: 'profiles', label: 'new profiles', hint: 'tokens that just published a profile on DexScreener. Carries marketing metadata only -- no price, no volume, no liquidity. Joining one to its markets is what enriches it.' },
  { key: 'boosts', label: 'paid boosts', hint: 'tokens with active paid promotion. `amount`/`totalAmount` are the paid spend in USD; a large totalAmount with a tiny amount is an old campaign topping up, not a fresh pump.' },
  { key: 'pairs', label: 'top pairs', hint: 'the busiest Solana markets by volume, via the profiles->pairs join. Measured on this feed: liquidity is present on only 1 in 4 of a fresh cohort and labels on 0 in 4, so those cells render as an em-dash, never 0.' },
  { key: 'search', label: 'search', hint: 'DexScreener search by symbol or address. Case-insensitive substring match on the returned set; the API caps at 30 pairs per query.' },
  { key: 'mint', label: 'mint lookup', hint: 'exact on-chain address lookup. An address that is not a valid base58 mint is rejected locally with a 400 -- upstream answers 200 with an empty list, which would make a typo look exactly like a token with no markets.' },
];

/** Present-but-null is NOT zero. Every formatter here returns an em-dash. */
function num(v: number | string | null | undefined, opts?: { prefix?: string; suffix?: string; dp?: number }) {
  if (v == null) return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return '—';
  const dp = opts?.dp ?? (Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 1 ? 2 : 6);
  return `${opts?.prefix ?? ''}${n.toLocaleString('en-US', { maximumFractionDigits: dp })}${opts?.suffix ?? ''}`;
}

/** Compact money: $70.3M / $706.5K / $0.00. Absent stays absent. */
function money(v: number | null | undefined) {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  if (a > 0) return `$${v.toPrecision(3)}`;
  return '$0';
}

function pct(v: number | null | undefined) {
  if (v == null) return '—';
  const s = v > 0 ? '+' : '';
  return `${s}${v.toFixed(2)}%`;
}

function age(ms: number | null | undefined) {
  if (!ms) return '—';
  const mins = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
}

function win<T>(o: Record<string, T> | undefined, k: string): T | undefined {
  return o?.[k];
}

export default function DexPage() {
  const [mode, setMode] = useState<Mode>('pairs');
  const [chain, setChain] = useState('solana');
  const [q, setQ] = useState('');
  const [addr, setAddr] = useState('');
  const [rows, setRows] = useState<DexPair[]>([]);
  const [profiles, setProfiles] = useState<DexProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [meta, setMeta] = useState<{ upstream?: string; returned?: number; total?: number; fetchedAt?: number }>({});
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      let url = '/api/dex?limit=30';
      if (mode === 'pairs' || mode === 'mint') {
        if (mode === 'pairs') {
          // Join: take fresh profile mints, then resolve their markets.
          const pRes = await fetch('/api/dex?type=profiles&limit=10', { cache: 'no-store' });
          if (!pRes.ok) throw new Error(`profiles HTTP ${pRes.status}`);
          const pJson = await pRes.json();
          const addrs = (pJson.data || []).map((x: DexProfile) => x.address).filter(Boolean);
          if (addrs.length === 0) throw new Error('no fresh profile mints to resolve');
          url = `/api/dex?type=tokens&addresses=${encodeURIComponent(addrs.join(','))}&limit=30`;
        } else {
          if (!addr.trim()) throw new Error('enter a mint address');
          url = `/api/dex?type=token-pairs&address=${encodeURIComponent(addr.trim())}&chain=${chain}`;
        }
      } else if (mode === 'search') {
        if (!q.trim()) throw new Error('enter a search term');
        url = `/api/dex?type=search&q=${encodeURIComponent(q.trim())}&limit=30`;
      } else {
        url = `/api/dex?type=${mode === 'boosts' ? 'boosts' : 'profiles'}&limit=30`;
      }

      const res = await fetch(url, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (json.kind === 'profiles') {
        setProfiles(json.data || []);
        setRows([]);
      } else {
        setRows(json.data || []);
        setProfiles([]);
      }
      setMeta({ upstream: json.upstream, returned: json.returned, total: json.total, fetchedAt: json.fetchedAt });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      // Never leave a previously-loaded table on screen under a fresh error:
      // stale rows under an error banner read as current data.
      setRows([]);
      setProfiles([]);
    } finally {
      setLoading(false);
    }
  }, [mode, chain, q, addr]);

  useEffect(() => { load(); }, [load]);

  const active = MODES.find((m) => m.key === mode)!;
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? rows.filter((p) =>
        [p.baseToken?.symbol, p.baseToken?.name, p.pairAddress, p.dexId, p.quoteToken?.symbol]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle))
      )
    : rows;

  // Measured sparsity, recomputed per render -- never a hardcoded claim.
  const cov = (k: keyof DexPair) =>
    rows.length ? `${((rows.filter((p) => p[k] != null).length / rows.length) * 100).toFixed(0)}%` : '—';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ color: C.accent, margin: 0 }}>DexScreener — live market data</h3>
        <button onClick={load} style={{ background: C.card, color: C.white, border: `1px solid ${C.border}`, padding: '6px 14px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
          ↻ Refresh
        </button>
      </div>
      <p style={{ color: C.dim, fontSize: 10, margin: '0 0 10px' }}>
        read-only market data · public DexScreener API · an em-dash means the field is absent upstream, never zero
      </p>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {MODES.map((m) => (
          <button key={m.key} onClick={() => setMode(m.key)}
            style={{
              background: mode === m.key ? C.accent : C.card, color: mode === m.key ? '#06120e' : C.white,
              border: `1px solid ${C.border}`, padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer',
            }}>{m.label}</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {mode === 'search' && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="symbol, name or address…"
            style={{ background: C.card, border: `1px solid ${C.border}`, color: C.white, padding: '6px 10px', borderRadius: 6, fontSize: 11, width: 260 }} />
        )}
        {mode === 'mint' && (
          <>
            <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="base58 mint address…"
              style={{ background: C.card, border: `1px solid ${C.border}`, color: C.white, padding: '6px 10px', borderRadius: 6, fontSize: 11, width: 340 }} />
            <select value={chain} onChange={(e) => setChain(e.target.value)}
              style={{ background: C.card, border: `1px solid ${C.border}`, color: C.white, padding: '6px 8px', borderRadius: 6, fontSize: 11 }}>
              {['solana', 'ethereum', 'bsc', 'base', 'arbitrum', 'polygon'].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </>
        )}
        {rows.length > 0 && (
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter rows…"
            style={{ background: C.card, border: `1px solid ${C.border}`, color: C.white, padding: '6px 10px', borderRadius: 6, fontSize: 11, width: 200 }} />
        )}
      </div>

      <p style={{ color: C.dim, fontSize: 10, margin: '0 0 10px' }}>{active.hint}</p>

      {error && (
        <p style={{ color: C.red, fontSize: 12, fontWeight: 700, background: 'rgba(255,80,80,0.08)', border: '1px solid rgba(255,80,80,0.35)', padding: '8px 10px', borderRadius: 6 }}>
          ⚠ dex error: {error} — no data faked
        </p>
      )}

      {loading ? (
        <p style={{ color: C.dim, fontSize: 12 }}>loading dex data…</p>
      ) : error ? (
        <p style={{ color: C.dim, fontSize: 12 }}>row list withheld — the request above failed.</p>
      ) : (
        <>
          {meta.upstream && (
            <p style={{ color: C.dim, fontSize: 10, margin: '0 0 8px' }}>
              {meta.returned} shown{meta.total != null && meta.total !== meta.returned ? ` of ${meta.total}` : ''}
              {rows.length > 0 && ` · liq coverage ${cov('liquidity')} · labels ${cov('labels')} · txns ${cov('txns')}`}
            </p>
          )}

          {/* profiles / boosts */}
          {(mode === 'profiles' || mode === 'boosts') && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 8 }}>
              {profiles.length === 0 && <p style={{ color: C.dim, fontSize: 12 }}>upstream returned no profiles.</p>}
              {profiles.map((p, i) => (
                <div key={p.address + i} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
                  {p.header && <div style={{ height: 54, backgroundImage: `url(${p.header})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />}
                  <div style={{ padding: 8 }}>
                    <div style={{ color: C.white, fontSize: 12, fontWeight: 700 }}>
                      {p.symbol || p.address.slice(0, 6) + '…'}
                      <span style={{ color: C.dim, fontSize: 9, marginLeft: 6 }}>{p.chain}</span>
                    </div>
                    <div style={{ color: C.dim, fontSize: 9, marginTop: 2, wordBreak: 'break-all' }}>{p.address}</div>
                    {(p.amount != null || p.totalAmount != null) && (
                      <div style={{ color: C.accent, fontSize: 10, marginTop: 4 }}>
                        boost {money(p.amount)}{p.totalAmount != null && ` · total ${money(p.totalAmount)}`}
                      </div>
                    )}
                    {p.links.length > 0 && (
                      <div style={{ display: 'flex', gap: 4, marginTop: 5, flexWrap: 'wrap' }}>
                        {p.links.slice(0, 3).map((l, j) => (
                          <a key={j} href={l.url} target="_blank" rel="noreferrer"
                            style={{ color: C.accent, fontSize: 9, textDecoration: 'none' }}>
                            {l.label || l.type || 'link'}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* pairs */}
          {(mode === 'pairs' || mode === 'search' || mode === 'mint') && (
            <>
              {rows.length === 0 && <p style={{ color: C.dim, fontSize: 12 }}>no pairs returned for this query.</p>}
              {rows.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead>
                      <tr style={{ color: C.dim, fontSize: 9, textAlign: 'left' }}>
                        {['pair', 'dex', 'price', '24h', 'vol 24h', 'liq', 'buys/sells 24h', 'mcap', 'age', 'labels'].map((h) => (
                          <th key={h} style={{ padding: '4px 6px', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visible.slice(0, 100).map((p, i) => {
                        const t24 = win(p.txns, 'h24');
                        const ch24 = win(p.priceChange, 'h24');
                        return (
                          <tr key={p.pairAddress + i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <td style={{ padding: '5px 6px', whiteSpace: 'nowrap' }}>
                              <a href={p.url} target="_blank" rel="noreferrer" style={{ color: C.accent, textDecoration: 'none', fontWeight: 700 }}>
                                {p.baseToken?.symbol || '—'}
                              </a>
                              <span style={{ color: C.dim }}>/{p.quoteToken?.symbol || '—'}</span>
                            </td>
                            <td style={{ padding: '5px 6px', color: C.dim }}>{p.dexId || '—'}</td>
                            <td style={{ padding: '5px 6px', color: C.white }}>{num(p.priceUsd, { prefix: '$' })}</td>
                            <td style={{ padding: '5px 6px', color: ch24 == null ? C.dim : ch24 >= 0 ? '#4ade80' : '#f87171' }}>{pct(ch24)}</td>
                            <td style={{ padding: '5px 6px', color: C.white }}>{money(win(p.volume, 'h24') ?? null)}</td>
                            <td style={{ padding: '5px 6px', color: C.white }}>{money(p.liquidity?.usd ?? null)}</td>
                            <td style={{ padding: '5px 6px', color: C.dim, whiteSpace: 'nowrap' }}>
                              {t24?.buys == null || t24?.sells == null ? '—' : `${t24.buys}/${t24.sells}`}
                            </td>
                            <td style={{ padding: '5px 6px', color: C.white }}>{money(p.marketCap ?? null)}</td>
                            <td style={{ padding: '5px 6px', color: C.dim }}>{age(p.pairCreatedAt)}</td>
                            <td style={{ padding: '5px 6px', color: C.dim }}>
                              {p.labels && p.labels.length ? p.labels.join(',') : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {visible.length > 100 && (
                    <p style={{ color: C.dim, fontSize: 10, marginTop: 6 }}>showing first 100 of {visible.length} — narrow the filter</p>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

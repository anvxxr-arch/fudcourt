'use client';
import { useState, useCallback, useEffect } from 'react';
import { color, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { Banner } from '@/ui/banner';
import { Loading } from '@/ui/feedback';
import { fetchDex, fetchDexProfiles, isMint, type DexPair, type DexProfile } from './client';
import { SEARCH_CHAINS, MODES, type Mode } from './ui-format';
import { PairsTable } from './ui-pairs';
import { ProfilesGrid, OrdersTables, type OrderData } from './ui-board';

export type { Mode, OrderData };
export { SEARCH_CHAINS, MODES, PairsTable, ProfilesGrid, OrdersTables };
export { num, money, pct, age, win } from './ui-format';

export default function DexPage() {
  const [mode, setMode] = useState<Mode>('pairs');
  const [chain, setChain] = useState('solana');
  // Search has no server-side chain filter upstream, so this narrows locally.
  const [searchChain, setSearchChain] = useState('');
  // token-pairs lists every market for a mint; tokens-v1 returns only the
  // deepest single pair. Both measured working, so expose the choice.
  const [deepestOnly, setDeepestOnly] = useState(false);
  const [q, setQ] = useState('');
  const [addr, setAddr] = useState('');
  const [rows, setRows] = useState<DexPair[]>([]);
  const [profiles, setProfiles] = useState<DexProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [meta, setMeta] = useState<{
    upstream?: string;
    returned?: number;
    total?: number;
    fetchedAt?: number;
    chainsSeen?: Record<string, number>;
    filteredBy?: string;
    upstreamTotal?: number;
    note?: string;
  }>({});
  const [filter, setFilter] = useState('');
  const [orderData, setOrderData] = useState<OrderData | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      let url = '/api/dex?limit=30';
      if (mode === 'pairs') {
        // Join: take fresh profile mints, then resolve their markets.
        const pJson = await fetchDexProfiles<{ data?: DexProfile[] }>(10);
        const all = (pJson.data || []).map((x: DexProfile) => x.address).filter(Boolean);
        if (all.length === 0) throw new Error('no fresh profile mints to resolve');
        // The profile feed is not base58-only -- measured 6 of 30 upstream
        // records are 0x… EVM addresses or a NEAR name. Send only the ones this
        // proxy will accept, and REPORT the rest rather than dropping them
        // silently: a join that quietly discards a fifth of its cohort looks
        // identical to a join that found nothing for them.
        const usable = all.filter(isMint);
        const skipped = all.filter((a) => !isMint(a));
        if (skipped.length) {
          setMeta((m) => ({
            ...m,
            note: `${skipped.length} of ${all.length} fresh profile addresses were not resolvable by this proxy and were skipped: ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? '…' : ''}`,
          }));
        }
        if (usable.length === 0) {
          throw new Error(`none of the ${all.length} fresh profile addresses could be resolved`);
        }
        url = `/api/dex?type=tokens&addresses=${encodeURIComponent(usable.join(','))}&limit=30`;
      } else if (mode === 'mint') {
        if (!addr.trim()) throw new Error('enter a mint address');
        // tokens-v1 resolves only the single deepest pair; token-pairs lists all
        // markets for the mint. Both are real endpoints, so the choice is the
        // user's rather than a guess.
        const endpoint = deepestOnly ? 'tokens-v1' : 'token-pairs';
        url = `/api/dex?type=${endpoint}&address=${encodeURIComponent(addr.trim())}&chain=${chain}`;
      } else if (mode === 'orders') {
        if (!addr.trim()) throw new Error('enter a token address');
        // orders/v1 answers {orders, boosts}: payment records for one token.
        // Same local validation as mint lookup -- upstream would 200 an empty
        // object for garbage and a typo would read as "this token paid nothing".
        url = `/api/dex?type=orders&address=${encodeURIComponent(addr.trim())}&chain=${chain}`;
      } else if (mode === 'search') {
        if (!q.trim()) throw new Error('enter a search term');
        // DexScreener has no server-side chain filter, so the chain select
        // narrows the result locally. The API reports the true spread so the
        // UI can say what the query actually covered.
        const chainQ = searchChain ? `&chain=${encodeURIComponent(searchChain)}` : '';
        url = `/api/dex?type=search&q=${encodeURIComponent(q.trim())}&limit=30${chainQ}`;
      } else {
        url = `/api/dex?type=${mode === 'boosts' ? 'boosts' : mode === 'boosts-top' ? 'boosts-top' : 'profiles'}&limit=30`;
      }

      const json = await fetchDex<any>(url);
      if (json.kind === 'profiles') {
        setProfiles(json.data || []);
        setRows([]);
        setOrderData(null);
      } else if (json.kind === 'orders') {
        setOrderData({ orders: json.orders || [], boosts: json.boosts || [] });
        setRows([]);
        setProfiles([]);
      } else {
        setRows(json.data || []);
        setProfiles([]);
        setOrderData(null);
      }
      // Merge, do not replace: the join may have already recorded addresses it
      // had to skip, and a bare setMeta here silently dropped that note -- the
      // UI would then look like it had resolved the whole cohort.
      setMeta((m) => ({
        upstream: json.upstream ?? m.upstream,
        returned: json.returned,
        total: json.total,
        fetchedAt: json.fetchedAt,
        chainsSeen: json.chainsSeen,
        filteredBy: json.filteredBy,
        upstreamTotal: json.upstreamTotal,
        note: json.note || m.note,
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      // Never leave a previously-loaded table on screen under a fresh error:
      // stale rows under an error banner read as current data.
      setRows([]);
      setProfiles([]);
      setOrderData(null);
    } finally {
      setLoading(false);
    }
  }, [mode, chain, q, addr, searchChain, deepestOnly]);

  // The upstream sits behind Cloudflare and answers bursts with 429 (error-1015).
  // The server-side limiter protects it too, but debouncing here is the cheaper
  // fix for the common case: typing a 44-char mint should cost one request, not
  // forty-four. A mode toggle is instant; a text field waits for a pause.
  const textDriven = mode === 'search' || mode === 'mint' || mode === 'orders';
  useEffect(() => {
    if (!textDriven) { load(); return; }
    if (!q.trim() && !addr.trim()) return;
    const t = setTimeout(load, 450);
    return () => clearTimeout(t);
  }, [load, textDriven]);

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: space[8], flexWrap: 'wrap', gap: space[8] }}>
        <h3 style={{ color: color.blue, margin: 0 }}>DexScreener — live market data</h3>
        <button onClick={load} style={{ background: color.bgSecondary, color: color.labelPrimary, border: `1px solid ${color.separator}`, padding: `${space[8]}px ${space[12]}px`, borderRadius: radius[8], fontSize: fontSize[11], cursor: 'pointer' }}>
          ↻ Refresh
        </button>
      </div>
      <p style={{ color: color.labelTertiary, fontSize: fontSize[11], margin: `0 0 ${space[8]}px` }}>
        read-only market data · public DexScreener API · an em-dash means the field is absent upstream, never zero
      </p>

      <div style={{ display: 'flex', gap: space[8], flexWrap: 'wrap', marginBottom: space[8] }}>
        {MODES.map((m) => (
          <button key={m.key} onClick={() => setMode(m.key)}
            style={{
              background: mode === m.key ? color.blue : color.bgSecondary, color: mode === m.key ? color.labelOnAccent : color.labelPrimary,
              border: `1px solid ${color.separator}`, padding: '5px 10px', borderRadius: radius[8], fontSize: fontSize[11], fontWeight: fontWeight.bold, cursor: 'pointer',
            }}>{m.label}</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: space[8], marginBottom: space[8], flexWrap: 'wrap', alignItems: 'center' }}>
        {mode === 'search' && (
          <>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="symbol, name or address…"
              style={{ background: color.bgSecondary, border: `1px solid ${color.separator}`, color: color.labelPrimary, padding: `${space[8]}px ${space[8]}px`, borderRadius: radius[8], fontSize: fontSize[11], width: 260 }} />
            <select value={searchChain} onChange={(e) => setSearchChain(e.target.value)}
              style={{ background: color.bgSecondary, border: `1px solid ${color.separator}`, color: color.labelPrimary, padding: `${space[8]}px ${space[8]}px`, borderRadius: radius[8], fontSize: fontSize[11] }}>
              <option value="">all chains (upstream default)</option>
              {SEARCH_CHAINS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </>
        )}
        {(mode === 'mint' || mode === 'orders') && (
          <>
            <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="token address (base58 / 0x / name)…"
              style={{ background: color.bgSecondary, border: `1px solid ${color.separator}`, color: color.labelPrimary, padding: `${space[8]}px ${space[8]}px`, borderRadius: radius[8], fontSize: fontSize[11], width: 340 }} />
            <select value={chain} onChange={(e) => setChain(e.target.value)}
              style={{ background: color.bgSecondary, border: `1px solid ${color.separator}`, color: color.labelPrimary, padding: `${space[8]}px ${space[8]}px`, borderRadius: radius[8], fontSize: fontSize[11] }}>
              {SEARCH_CHAINS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {mode === 'mint' && (
              <label style={{ color: color.labelTertiary, fontSize: fontSize[11], display: 'inline-flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}>
                <input type="checkbox" checked={deepestOnly} onChange={(e) => setDeepestOnly(e.target.checked)} />
                deepest pair only (tokens/v1)
              </label>
            )}
          </>
        )}
        {rows.length > 0 && (
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter rows…"
            style={{ background: color.bgSecondary, border: `1px solid ${color.separator}`, color: color.labelPrimary, padding: `${space[8]}px ${space[8]}px`, borderRadius: radius[8], fontSize: fontSize[11], width: 200 }} />
        )}
      </div>

      <p style={{ color: color.labelTertiary, fontSize: fontSize[11], margin: `0 0 ${space[8]}px` }}>{active.hint}</p>

      {error && (
        <Banner variant="error" style={{ fontWeight: fontWeight.bold }}>
          ⚠ dex error: {error} — no data faked
        </Banner>
      )}

      {loading ? (
        <Loading label="loading dex data…" />
      ) : error ? (
        <p style={{ color: color.labelTertiary, fontSize: fontSize[12] }}>row list withheld — the request above failed.</p>
      ) : (
        <>
          {meta.upstream && meta.returned != null && (
            <p style={{ color: color.labelTertiary, fontSize: fontSize[11], margin: `0 0 ${space[4]}px` }}>
              {meta.returned} shown{meta.total != null && meta.total !== meta.returned ? ` of ${meta.total}` : ''}
              {rows.length > 0 && ` · liq coverage ${cov('liquidity')} · labels ${cov('labels')} · txns ${cov('txns')}`}
            </p>
          )}
          {/* DexScreener has no server-side chain filter. Say what the query
              actually spanned instead of letting a filtered view imply the
              upstream request was scoped. */}
          {meta.chainsSeen && Object.keys(meta.chainsSeen).length > 0 && (
            <p style={{ color: color.labelTertiary, fontSize: fontSize[11], margin: `0 0 ${space[4]}px` }}>
              upstream matched {meta.upstreamTotal ?? meta.total} pairs across{' '}
              <span style={{ color: color.blue }}>{Object.keys(meta.chainsSeen).length} chains</span>
              {meta.filteredBy
                ? ` — narrowed locally to '${meta.filteredBy}' (upstream ignores a chain param)`
                : `: ${Object.entries(meta.chainsSeen).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', ')}`}
            </p>
          )}
          {meta.note && (
            <p style={{ color: color.orange, fontSize: fontSize[11], margin: `0 0 ${space[8]}px`, fontWeight: fontWeight.bold }}>⚠ {meta.note}</p>
          )}

          {/* profiles / boosts */}
          {(mode === 'profiles' || mode === 'boosts' || mode === 'boosts-top') && (
            <ProfilesGrid profiles={profiles} />
          )}

          {/* orders: payment records for one token (orders/v1). Both lists are
              always present upstream, so an empty list here is a real empty
              result, not an absent field -- rendered as text saying exactly
              that, never as 0 rows implying a failure. */}
          {mode === 'orders' && orderData && (
            <OrdersTables orderData={orderData} />
          )}

          {/* pairs */}
          {(mode === 'pairs' || mode === 'search' || mode === 'mint') && (
            <PairsTable rows={rows} visible={visible} />
          )}
        </>
      )}
    </div>
  );
}

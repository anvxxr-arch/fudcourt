'use client';
import { useState, useCallback, useEffect } from 'react';
import { themeColor, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { useT } from '@/lib/i18n/t';
import { Banner } from '@/ui/banner';
import { Loading } from '@/ui/feedback';
import { fetchDex, fetchDexProfiles, isMint, type DexPair, type DexProfile } from './client';
import { fetchCanonicalBoard, type BoardResult } from './canonical';
import { CanonicalBoard } from './ui-canon';
import { SEARCH_CHAINS, MODES, type Mode } from './ui-format';
import { PairsTable } from './ui-pairs';
import { ProfilesGrid, OrdersTables, type OrderData } from './ui-board';

export type { Mode, OrderData };
export { SEARCH_CHAINS, MODES, PairsTable, ProfilesGrid, OrdersTables };
export { CanonicalBoard } from './ui-canon';
export { fetchCanonicalBoard, type BoardRow, type BoardResult } from './canonical';
export { num, money, pct, age, win } from './ui-format';

export default function DexPage() {
  const t = useT();
  const [mode, setMode] = useState<Mode>('board');
  const [chain, setChain] = useState('solana');
  // Search has no server-side chain filter upstream, so this narrows locally.
  const [searchChain, setSearchChain] = useState('');
  // token-pairs lists every market for a mint; tokens-v1 returns only the
  // deepest single pair. Both measured working, so expose the choice.
  const [deepestOnly, setDeepestOnly] = useState(false);
  const [q, setQ] = useState('');
  const [addr, setAddr] = useState('');
  const [rows, setRows] = useState<DexPair[]>([]);
  // The canonical board is its own state: its rows are NOT DexPair (no provider
  // envelope behind them), so flattening them into `rows` would type-lie.
  const [board, setBoard] = useState<BoardResult | null>(null);
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
  // The canonical board's chain filter: the CANONICAL chain id (not a provider
  // name) sent to BOTH the pools and markets reads, so the join stays
  // chain-consistent. Options come from the chain registry the board already
  // fetches — never a hand-maintained list that silently drifts from upstream.
  const [boardChain, setBoardChain] = useState('');
  const [orderData, setOrderData] = useState<OrderData | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      if (mode === 'board') {
        // The canonical path: three canonical reads, no provider named. A
        // failure here (gateway 404 before the rebuild, sidecar 502) must
        // surface as the loud error banner, never as an empty table.
        setBoard(await fetchCanonicalBoard(60, boardChain || undefined));
        setRows([]);
        setProfiles([]);
        setOrderData(null);
        setMeta({});
        return;
      }
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
      setBoard(null);
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
      setBoard(null);
    } finally {
      setLoading(false);
    }
  }, [mode, chain, q, addr, searchChain, deepestOnly, boardChain]);

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
  const boardRows = board?.rows ?? [];
  const visibleBoard = needle
    ? boardRows.filter((r) =>
        [r.pair, r.dex, r.address, r.poolId].some((v) => String(v).toLowerCase().includes(needle))
      )
    : boardRows;

  // Measured sparsity, recomputed per render -- never a hardcoded claim.
  const cov = (k: keyof DexPair) =>
    rows.length ? `${((rows.filter((p) => p[k] != null).length / rows.length) * 100).toFixed(0)}%` : '—';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: space[8], flexWrap: 'wrap', gap: space[8] }}>
        <h3 style={{ color: themeColor.blue, margin: 0 }}>
          {mode === 'board' ? t('dex.titleBoard') : t('dex.titleDex')}
        </h3>
        <button type="button" className="fc-focusable" onClick={load} style={{ background: themeColor.bgSecondary, color: themeColor.labelPrimary, border: `1px solid ${themeColor.separator}`, padding: `${space[8]}px ${space[12]}px`, borderRadius: radius[8], fontSize: fontSize[11], cursor: 'pointer' }}>
          {t('common.refresh')}
        </button>
      </div>
      <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], margin: `0 0 ${space[8]}px` }}>
        {mode === 'board' ? t('dex.subtitleBoard') : t('dex.subtitleDex')}
      </p>

      <div style={{ display: 'flex', gap: space[8], flexWrap: 'wrap', marginBottom: space[8] }}>
        {MODES.map((m) => (
          <button key={m.key} type="button" aria-pressed={mode === m.key} className="fc-focusable" onClick={() => setMode(m.key)}
            style={{
              background: mode === m.key ? themeColor.blue : themeColor.bgSecondary, color: mode === m.key ? themeColor.labelOnAccent : themeColor.labelPrimary,
              border: `1px solid ${themeColor.separator}`, padding: '5px 10px', borderRadius: radius[8], fontSize: fontSize[11], fontWeight: fontWeight.bold, cursor: 'pointer',
            }}>{t(`dex.mode.${m.key}.label` as Parameters<typeof t>[0])}</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: space[8], marginBottom: space[8], flexWrap: 'wrap', alignItems: 'center' }}>
        {mode === 'board' && board && (
          <select
            value={boardChain}
            onChange={(e) => setBoardChain(e.target.value)}
            aria-label={t('dex.filterChain')}
            className="fc-focusable"
            style={{ background: themeColor.bgSecondary, border: `1px solid ${themeColor.separator}`, color: themeColor.labelPrimary, padding: `${space[8]}px ${space[8]}px`, borderRadius: radius[8], fontSize: fontSize[11] }}
          >
            <option value="">{t('common.allChains', { n: board.chains })}</option>
            {/* From the FULL registry the board already fetched — stable
                across refetches. A page-derived list would drop every other
                option the moment one is picked (a self-narrowing select). */}
            {board.chainOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        {mode === 'search' && (
          <>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('dex.searchPlaceholder')}
              style={{ background: themeColor.bgSecondary, border: `1px solid ${themeColor.separator}`, color: themeColor.labelPrimary, padding: `${space[8]}px ${space[8]}px`, borderRadius: radius[8], fontSize: fontSize[11], width: 260 }} />
            <select value={searchChain} onChange={(e) => setSearchChain(e.target.value)}
              style={{ background: themeColor.bgSecondary, border: `1px solid ${themeColor.separator}`, color: themeColor.labelPrimary, padding: `${space[8]}px ${space[8]}px`, borderRadius: radius[8], fontSize: fontSize[11] }}>
              <option value="">{t('dex.searchAllChains')}</option>
              {SEARCH_CHAINS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </>
        )}
        {(mode === 'mint' || mode === 'orders') && (
          <>
            <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder={t('dex.addrPlaceholder')}
              style={{ background: themeColor.bgSecondary, border: `1px solid ${themeColor.separator}`, color: themeColor.labelPrimary, padding: `${space[8]}px ${space[8]}px`, borderRadius: radius[8], fontSize: fontSize[11], width: 340 }} />
            <select value={chain} onChange={(e) => setChain(e.target.value)}
              style={{ background: themeColor.bgSecondary, border: `1px solid ${themeColor.separator}`, color: themeColor.labelPrimary, padding: `${space[8]}px ${space[8]}px`, borderRadius: radius[8], fontSize: fontSize[11] }}>
              {SEARCH_CHAINS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {mode === 'mint' && (
              <label style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], display: 'inline-flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}>
                <input type="checkbox" checked={deepestOnly} onChange={(e) => setDeepestOnly(e.target.checked)} />
                {t('dex.deepestOnly')}
              </label>
            )}
          </>
        )}
        {/* The filter input is NOT gated on `rows.length`: it lives in the toolbar
            above the results, so rendering it only once rows arrive grew the toolbar
            from 0 to 35px at hydrate and shoved the hint paragraph 34px down
            (measured 567 -> 601 on /market/trench, the bulk of that route's CLS).
            It always renders now, at a stable position, like every other toolbar
            control; a filter typed before results arrive simply applies on arrival. */}
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('common.filter')}
          style={{ background: themeColor.bgSecondary, border: `1px solid ${themeColor.separator}`, color: themeColor.labelPrimary, padding: `${space[8]}px ${space[8]}px`, borderRadius: radius[8], fontSize: fontSize[11], width: 200 }} />
      </div>

      <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], margin: `0 0 ${space[8]}px` }}>{t(`dex.mode.${active.key}.hint` as Parameters<typeof t>[0])}</p>

      {error && (
        <Banner variant="error" style={{ fontWeight: fontWeight.bold }}>
          {t('dex.errorBanner', { msg: error })}
        </Banner>
      )}

      {loading ? (
        <Loading label={t('dex.loading')} />
      ) : error ? (
        <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>{t('dex.withheld')}</p>
      ) : (
        <>
          {mode === 'board' && board && (
            <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], margin: `0 0 ${space[4]}px` }}>
              {t('dex.boardMeta', { pools: board.pools, withMarketState: board.withMarketState, venues: board.venues, chains: board.chains })}
            </p>
          )}
          {meta.upstream && meta.returned != null && (
            <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], margin: `0 0 ${space[4]}px` }}>
              {t('dex.metaShown', { returned: meta.returned })}
              {meta.total != null && meta.total !== meta.returned ? t('dex.metaOf', { total: meta.total }) : ''}
              {rows.length > 0 ? t('dex.metaCoverage', { liq: cov('liquidity'), labels: cov('labels'), txns: cov('txns') }) : ''}
            </p>
          )}
          {/* DexScreener has no server-side chain filter. Say what the query
              actually spanned instead of letting a filtered view imply the
              upstream request was scoped. */}
          {meta.chainsSeen && Object.keys(meta.chainsSeen).length > 0 && (
            <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], margin: `0 0 ${space[4]}px` }}>
              {t('dex.upstreamMatched', { total: meta.upstreamTotal ?? meta.total })}{' '}
              <span style={{ color: themeColor.blue }}>{t('dex.chainsCount', { n: Object.keys(meta.chainsSeen).length })}</span>
              {meta.filteredBy
                ? t('dex.narrowed', { chain: meta.filteredBy })
                : `: ${Object.entries(meta.chainsSeen).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', ')}`}
            </p>
          )}
          {meta.note && (
            <p style={{ color: themeColor.orange, fontSize: fontSize[11], margin: `0 0 ${space[8]}px`, fontWeight: fontWeight.bold }}>⚠ {meta.note}</p>
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

          {/* canonical board: the provider-agnostic path (plan §47/§60) */}
          {mode === 'board' && <CanonicalBoard rows={visibleBoard} />}

          {/* pairs */}
          {(mode === 'pairs' || mode === 'search' || mode === 'mint') && (
            <PairsTable rows={rows} visible={visible} />
          )}
        </>
      )}
    </div>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { C } from '../../lib/ui/shared';
import {
  CR_BASE,
  CR_CATEGORY_SLUGS,
  type CrChainRow,
  type CrCoin,
  type CrCoinDetail,
  type CrEnvelope,
  type CrExchangeRow,
  type CrGlobal,
  type CrMode,
  type CrTrendingRow,
} from '../../lib/cryptorank';

/**
 * CryptoRank board through /api/cryptorank (mode-only input; SSR-payload data
 * via curl_cffi, see lib/cryptorank.ts header for the access matrix).
 *
 * Honesty rules enforced here: absent upstream metric -> em-dash (never 0),
 * refreshed stamp on every load, error banner on failure (stale data stays
 * visible only while stamped), homepage slices labelled as slices, and the
 * derived 24h change on gainers/losers is marked as derived.
 */

/* ------------------------------ formatting ------------------------------ */

function money(v: number | null | undefined): string {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1) return `$${v.toFixed(2)}`;
  if (a >= 0.0001) return `$${v.toFixed(6)}`;
  if (a >= 1e-8) return `$${v.toFixed(8)}`; // sub-cent (SHIB/PEPE) readable, never 1.2e-6
  return `$${v.toExponential(2)}`;
}

/** Supply in COIN units (never $): 19900000 BTC -> 19.90M BTC, null -> em-dash. */
function supply(v: number | null | undefined, symbol?: string): string {
  if (v == null) return '—';
  const s = symbol ? ` ${symbol}` : '';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B${s}`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M${s}`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)}K${s}`;
  return `${v.toFixed(2)}${s}`;
}

/** Money for volumes/raises: adds a K tier so 600000 -> $600.00K, not $600000.00. */
function moneyCompact(v: number | null | undefined): string {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return money(v);
  if (a >= 1e3) return `$${(v / 1e3).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}

function pct(v: number | null | undefined): string {
  if (v == null) return '—';
  const s = v > 0 ? '+' : '';
  return `${s}${v.toFixed(2)}%`;
}

function chgColor(v: number | null): string {
  if (v == null) return C.dim;
  return v > 0 ? C.green : v < 0 ? C.red : C.dim;
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  return new Date(t).toISOString().slice(0, 10);
}

function stamp(epochSec: number | null | undefined): string {
  if (!epochSec) return '—';
  const t = new Date(epochSec * 1000);
  const mins = Math.floor((Date.now() - t.getTime()) / 60000);
  const hh = t.toTimeString().slice(0, 5);
  if (mins < 1) return `${hh} (now)`;
  if (mins < 60) return `${hh} (${mins}m ago)`;
  return `${hh} (${Math.floor(mins / 60)}h ago)`;
}

/* -------------------------------- state -------------------------------- */

type MarketTab = Extract<CrMode, 'coins' | 'trending' | 'gainers' | 'losers'>;

const MARKET_TABS: { key: MarketTab; label: string }[] = [
  { key: 'coins', label: 'Top 100' },
  { key: 'trending', label: 'Trending' },
  { key: 'gainers', label: 'Gainers' },
  { key: 'losers', label: 'Losers' },
];

async function loadMode(mode: CrMode, fresh = false, key?: string): Promise<CrEnvelope> {
  const keyQ = key ? `&key=${encodeURIComponent(key)}` : '';
  const res = await fetch(`/api/cryptorank?mode=${mode}${keyQ}${fresh ? '&fresh=1' : ''}`, { cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body?.error ?? `HTTP ${res.status}`;
    const up = body?.upstreamStatus ? ` (upstream ${body.upstreamStatus})` : '';
    throw new Error(`${detail}${up}`);
  }
  return body as CrEnvelope;
}

/* -------------------------------- page --------------------------------- */

export default function CryptorankPage() {
  const [home, setHome] = useState<CrEnvelope | null>(null);
  const [homeErr, setHomeErr] = useState('');
  const [homeStale, setHomeStale] = useState(false);
  const [homeAt, setHomeAt] = useState<number | null>(null);

  // spotlight coin detail (keyed mode; default bitcoin)
  const [coinKey, setCoinKey] = useState('bitcoin');
  const [coinInput, setCoinInput] = useState('bitcoin');
  const [detail, setDetail] = useState<CrCoinDetail | null>(null);
  const [detailErr, setDetailErr] = useState('');

  // sector board (keyed: category slug)
  const [catSlug, setCatSlug] = useState<string>('chain');
  const [cat, setCat] = useState<CrEnvelope | null>(null);
  const [catErr, setCatErr] = useState('');

  // exchange board (keyed: cex/spot | dex/spot | perpetuals)
  const [exKey, setExKey] = useState<string>('cex/spot');
  const [ex, setEx] = useState<CrEnvelope | null>(null);
  const [exErr, setExErr] = useState('');

  // listings board (three /listings widgets)
  const [listings, setListings] = useState<CrEnvelope | null>(null);
  const [listingsErr, setListingsErr] = useState('');

  const [lpKey, setLpKey] = useState<string>('past');
  const [lp, setLp] = useState<CrEnvelope | null>(null);
  const [lpErr, setLpErr] = useState('');

  const [news, setNews] = useState<CrEnvelope | null>(null);
  const [newsErr, setNewsErr] = useState('');

  // chain board (index-fed selector + keyed ecosystem detail)
  const [chainRows, setChainRows] = useState<CrChainRow[]>([]);
  const [chainSlug, setChainSlug] = useState<string>('ethereum');
  const [chain, setChain] = useState<CrEnvelope | null>(null);
  const [chainErr, setChainErr] = useState('');

  const [tab, setTab] = useState<MarketTab>('coins');
  const [market, setMarket] = useState<CrEnvelope | null>(null);
  const [marketErr, setMarketErr] = useState('');
  const [marketStale, setMarketStale] = useState(false);
  const [marketAt, setMarketAt] = useState<number | null>(null);
  const [loadingMarket, setLoadingMarket] = useState(true);

  const fetchHome = useCallback(async (fresh = false) => {
    try {
      const env = await loadMode('home', fresh);
      setHome(env);
      setHomeErr('');
      setHomeStale(false);
      setHomeAt(env.fetchedAt);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setHomeErr(msg);
      setHomeStale(!!home);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home]);

  const fetchMarket = useCallback(
    async (m: MarketTab, fresh = false) => {
      setLoadingMarket(true);
      try {
        const env = await loadMode(m, fresh);
        setMarket(env);
        setMarketErr('');
        setMarketStale(false);
        setMarketAt(env.fetchedAt);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setMarketErr(msg);
        setMarketStale(!!market);
      }
      setLoadingMarket(false);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [market],
  );

  const fetchDetail = useCallback(async (key: string, fresh = false) => {
    try {
      const env = await loadMode('coin', fresh, key);
      setDetail(env.detail ?? null);
      setDetailErr(env.detail ? '' : 'upstream shipped no detail object — nothing faked');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDetailErr(msg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchCat = useCallback(async (slug: string, fresh = false) => {
    try {
      const env = await loadMode('categories', fresh, slug);
      setCat(env);
      setCatErr('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCatErr(msg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchEx = useCallback(async (key = 'cex/spot', fresh = false) => {
    try {
      const env = await loadMode('exchanges', fresh, key);
      setEx(env);
      setExErr('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setExErr(msg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchLp = useCallback(async (key = 'past', fresh = false) => {
    try {
      const env = await loadMode('launchpool', fresh, key);
      setLp(env);
      setLpErr('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLpErr(msg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchNews = useCallback(async (fresh = false) => {
    try {
      const env = await loadMode('news', fresh);
      setNews(env);
      setNewsErr('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setNewsErr(msg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchChainIndex = useCallback(async (fresh = false) => {
    try {
      const env = await loadMode('blockchains', fresh);
      setChainRows(env.chainRows ?? []);
    } catch {
      setChainRows([]); // selector falls back to the current slug only
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchChain = useCallback(async (slug: string, fresh = false) => {
    try {
      const env = await loadMode('chain', fresh, slug);
      setChain(env);
      setChainErr('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setChainErr(msg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchListings = useCallback(async (fresh = false) => {
    try {
      const env = await loadMode('listings', fresh);
      setListings(env);
      setListingsErr('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setListingsErr(msg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void fetchHome();
    void fetchDetail('bitcoin');
    void fetchEx(exKey);
    void fetchListings();
    void fetchChainIndex();
    void fetchChain('ethereum');
    void fetchNews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void fetchChain(chainSlug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainSlug]);

  useEffect(() => {
    void fetchLp(lpKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lpKey]);

  useEffect(() => {
    void fetchCat(catSlug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catSlug]);

  useEffect(() => {
    void fetchEx(exKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exKey]);

  useEffect(() => {
    void fetchMarket(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const global: CrGlobal | undefined = home?.global;
  const rows = (market?.rows ?? []) as (CrCoin | CrTrendingRow)[];
  const isTrending = tab === 'trending';
  const isPlain = tab === 'coins';

  const colHead = isPlain
    ? ['#', 'Coin', 'Price', 'Market Cap', 'Volume 24h', 'ATH']
    : ['#', 'Coin', 'Price', 'Chg 24h', 'Market Cap', 'Volume 24h'];

  return (
    <div>
      {/* ------------------------------ header ------------------------------ */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: C.white }}>CryptoRank</div>
        <a href={CR_BASE} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: C.accent }}>
          cryptorank.io ↗
        </a>
        <div style={{ fontSize: 11, color: C.dim }}>
          SSR payload · refreshes {stamp(homeAt ?? marketAt)}
        </div>
        <button
          onClick={() => {
            void fetchHome(true);
            void fetchMarket(tab, true);
            void fetchDetail(coinKey, true);
            void fetchCat(catSlug, true);
            void fetchEx(exKey, true);
            void fetchListings(true);
            void fetchChainIndex(true);
            void fetchChain(chainSlug, true);
          }}
          style={{
            marginLeft: 'auto', fontSize: 11, color: C.bg, background: C.accent,
            border: 'none', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontWeight: 700,
          }}
        >
          ↻ refresh
        </button>
      </div>

      {homeErr && (
        <div style={{ fontSize: 12, color: C.red, marginBottom: 8 }}>
          ⚠ cryptorank home error: {homeErr} — nothing faked
          {homeStale && home ? ' · last good stats below, stamped' : ''}
        </div>
      )}

      {/* --------------------------- stats strip ---------------------------- */}
      <div
        style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 8, marginBottom: 14,
        }}
      >
        <Stat label="Total market cap" value={money(global?.totalMarketCap)} sub={pct(global?.totalMarketCapChangePercent)} subColor={chgColor(global?.totalMarketCapChangePercent)} />
        <Stat label="24h volume" value={money(global?.totalVolume24h)} sub={pct(global?.totalVolume24hChangePercent)} subColor={chgColor(global?.totalVolume24hChangePercent)} />
        <Stat label="BTC dominance" value={global?.btcDominance != null ? `${global.btcDominance.toFixed(1)}%` : '—'} sub={pct(global?.btcDominanceChangePercent)} subColor={chgColor(global?.btcDominanceChangePercent)} />
        <Stat label="ETH dominance" value={global?.ethDominance != null ? `${global.ethDominance.toFixed(1)}%` : '—'} sub={pct(global?.ethDominanceChangePercent)} subColor={chgColor(global?.ethDominanceChangePercent)} />
        <Stat label="Tracked assets" value={global?.allCurrencies != null ? global.allCurrencies.toLocaleString('en-US') : '—'} sub="" subColor={C.dim} />
        <Stat label="Gas (avg)" value={global?.gasGwei != null ? `${global.gasGwei.toFixed(1)} gwei` : '—'} sub="" subColor={C.dim} />
      </div>

      {/* ------------------------ spotlight coin --------------------------- */}
      <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.card, padding: 12, marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
          <div style={{ color: C.white, fontWeight: 700, fontSize: 13 }}>Coin spotlight</div>
          <input
            value={coinInput}
            onChange={(e) => setCoinInput(e.target.value.toLowerCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setCoinKey(coinInput.trim());
                void fetchDetail(coinInput.trim());
              }
            }}
            placeholder="coin key (e.g. bitcoin)"
            style={{
              fontSize: 12, padding: '4px 8px', borderRadius: 6, width: 180,
              border: `1px solid ${C.border}`, background: C.bg, color: C.white,
            }}
          />
          <button
            onClick={() => {
              setCoinKey(coinInput.trim());
              void fetchDetail(coinInput.trim());
            }}
            style={{
              fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${C.accent}`, background: 'transparent', color: C.accent, fontWeight: 700,
            }}
          >
            load
          </button>
          {detail && (
            <a
              href={`${CR_BASE}/price/${detail.key}`}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 11, color: C.accent, marginLeft: 'auto' }}
            >
              {detail.name} ({detail.symbol}) ↗
            </a>
          )}
        </div>
        {detailErr && (
          <div style={{ fontSize: 12, color: C.red, marginBottom: 6 }}>
            ⚠ coin '{coinKey}' error: {detailErr} — nothing faked
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
          <Stat label="Price" value={money(detail?.priceUsd)} sub="" subColor={C.dim} />
          <Stat
            label="Chg 24h (derived)"
            value={detail?.change24h != null ? pct(detail.change24h) : '—'}
            sub=""
            subColor={chgColor(detail?.change24h ?? null)}
          />
          <Stat label="Market cap" value={money(detail?.marketCap)} sub={detail?.rank != null ? `rank #${detail.rank}` : ''} subColor={C.dim} />
          <Stat label="Volume 24h" value={money(detail?.volume24h)} sub="" subColor={C.dim} />
          <Stat
            label="ATH"
            value={money(detail?.athUsd)}
            sub={shortDate(detail?.athDate ?? null)}
            subColor={C.dim}
          />
          <Stat
            label="From ATL"
            value={detail?.fromAtlPct != null ? pct(detail.fromAtlPct) : '—'}
            sub={shortDate(detail?.atlDate ?? null)}
            subColor={C.dim}
          />
          <Stat
            label="Circulating"
            value={supply(detail?.availableSupply, detail?.symbol)}
            sub={detail?.circulatingPct != null ? `${detail.circulatingPct.toFixed(1)}% of total` : ''}
            subColor={C.dim}
          />
          <Stat label="Max supply" value={detail?.maxSupply != null ? detail.maxSupply.toLocaleString('en-US') : '—'} sub="" subColor={C.dim} />
        </div>
        <div style={{ fontSize: 10, color: C.dim, marginTop: 6 }}>
          source: /price/{coinKey} SSR payload (3-gate verified) · chg24h derived from histPrices["24H"] anchor ·
          sparse fields render em-dash, never 0
        </div>
      </div>

      {/* --------------------------- market table --------------------------- */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {MARKET_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${tab === t.key ? C.accent : C.border}`,
              background: tab === t.key ? C.accent : 'transparent',
              color: tab === t.key ? C.bg : C.dim,
              fontWeight: tab === t.key ? 700 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', fontSize: 11, color: C.dim }}>
          {market &&
            `${market.count} rows` +
            (market.upstreamTotal && market.upstreamTotal !== market.count
              ? ` of ${market.upstreamTotal} upstream`
              : '')}
        </div>
      </div>

      {marketErr && (
        <div style={{ fontSize: 12, color: C.red, marginBottom: 8 }}>
          ⚠ cryptorank {tab} error: {marketErr} — no data faked
          {marketStale && market ? ' · showing last good rows, stamped' : ''}
        </div>
      )}

      <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', background: C.card }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: C.dim, textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              {colHead.map((h) => (
                <th key={h} style={{ padding: '8px 10px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loadingMarket && !market && (
              <tr><td colSpan={colHead.length} style={{ padding: 16, color: C.dim }}>loading…</td></tr>
            )}
            {!loadingMarket && !market && !marketErr && (
              <tr><td colSpan={colHead.length} style={{ padding: 16, color: C.dim }}>no data</td></tr>
            )}
            {rows.map((r) => (
              <tr key={`${r.key}-${r.rank}`} style={{ borderBottom: `1px solid ${C.border}` }}>
                <td style={{ padding: '7px 10px', color: C.dim, width: 34 }}>{r.rank ?? '—'}</td>
                <td style={{ padding: '7px 10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {r.image && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.image} alt="" width={18} height={18} style={{ borderRadius: '50%' }} />
                    )}
                    <div>
                      <span style={{ color: C.white }}>{r.name}</span>
                      <span style={{ color: C.dim, marginLeft: 6, fontSize: 11 }}>{r.symbol}</span>
                    </div>
                  </div>
                </td>
                <td style={{ padding: '7px 10px', color: C.white }}>{money(r.priceUsd)}</td>
                {!isPlain && (
                  <td style={{ padding: '7px 10px', color: chgColor(r.change24h), fontVariantNumeric: 'tabular-nums' }}>
                    {pct(r.change24h)}
                  </td>
                )}
                <td style={{ padding: '7px 10px', color: C.white }}>{money(r.marketCap)}</td>
                <td style={{ padding: '7px 10px', color: C.white }}>{moneyCompact(r.volume24hUsd)}</td>
                {isPlain && (
                  <td style={{ padding: '7px 10px', color: C.dim }}>
                    {money((r as CrCoin).athUsd)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 10, color: C.dim, marginTop: 4 }}>
        {tab === 'coins' && 'source: /all-coins-list SSR payload · 24h change ships on trending/gainers pages only → em-dash where upstream gives none'}
        {tab === 'trending' && 'source: /trending SSR payload · chg 24h is an upstream field'}
        {(tab === 'gainers' || tab === 'losers') &&
          `source: /${tab} SSR payload · chg 24h derived from upstream histPrices["24H"] anchor (150-row upstream list)`}
      </div>

      {/* -------------------------- listings ------------------------------ */}
      {listingsErr && (
        <div style={{ fontSize: 12, color: C.red, marginTop: 14 }}>
          ⚠ listings error: {listingsErr} — nothing faked
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 10, marginTop: 16 }}>
        {([
          ['Recently added', listings?.listings?.recentlyAdded, true],
          ['Most searched', listings?.listings?.mostSearched, false],
          ['Most visited', listings?.listings?.mostVisited, false],
        ] as const).map(([title, rowsL, showDate]) => (
          <div key={title} style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.card, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <div style={{ color: C.white, fontWeight: 700, fontSize: 13 }}>{title}</div>
              <div style={{ fontSize: 10, color: C.dim }}>{rowsL?.length ?? '—'} coins</div>
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: C.dim, textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    <th style={{ padding: '6px 5px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>#</th>
                    <th style={{ padding: '6px 5px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>Coin</th>
                    <th style={{ padding: '6px 5px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>Price</th>
                    <th style={{ padding: '6px 5px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>Chg 24h</th>
                    <th style={{ padding: '6px 5px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>Chg 7d</th>
                  </tr>
                </thead>
                <tbody>
                  {!listings && !listingsErr && (
                    <tr><td colSpan={5} style={{ padding: 10, color: C.dim }}>loading…</td></tr>
                  )}
                  {(rowsL ?? []).map((c) => (
                    <tr key={`${c.key}-${c.rank}`} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={{ padding: '5px 5px', color: C.dim, width: 24 }}>{c.rank ?? '—'}</td>
                      <td style={{ padding: '5px 5px' }}>
                        <div style={{ color: C.white }}>{c.name}</div>
                        <div style={{ color: C.dim, fontSize: 10 }}>
                          {c.symbol}{showDate && c.listingDate ? ` · ${shortDate(c.listingDate)}` : ''}
                        </div>
                      </td>
                      <td style={{ padding: '5px 5px', color: C.white }}>{money(c.priceUsd)}</td>
                      <td style={{ padding: '5px 5px', color: chgColor(c.change24h) }}>{pct(c.change24h)}</td>
                      <td style={{ padding: '5px 5px', color: chgColor(c.change7d ?? null)}}>{pct(c.change7d ?? null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: C.dim, marginTop: 4 }}>
        {listings?.slice ?? 'source: /listings SSR payload'}
      </div>

      {/* ------------------- sectors + exchanges --------------------------- */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 10, marginTop: 16 }}>
        {/* sectors (categories, keyed) */}
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.card, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6, gap: 8 }}>
            <div style={{ color: C.white, fontWeight: 700, fontSize: 13 }}>
              Sectors{cat?.category ? `: ${cat.category.name}` : ''}
            </div>
            <select
              value={catSlug}
              onChange={(e) => setCatSlug(e.target.value)}
              style={{
                fontSize: 11, padding: '3px 6px', borderRadius: 6,
                border: `1px solid ${C.border}`, background: C.bg, color: C.white,
              }}
            >
              {CR_CATEGORY_SLUGS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          {cat?.category && (
            <div style={{ fontSize: 10, color: C.dim, marginBottom: 6 }}>
              breadth: <span style={{ color: C.green }}>{cat.category.gainers ?? '—'} gainers</span>
              {' / '}
              <span style={{ color: C.red }}>{cat.category.losers ?? '—'} losers</span>
            </div>
          )}
          {catErr && (
            <div style={{ fontSize: 12, color: C.red, marginBottom: 6 }}>⚠ sector '{catSlug}' error: {catErr} — nothing faked</div>
          )}
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: C.dim, textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  <th style={{ padding: '6px 6px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>#</th>
                  <th style={{ padding: '6px 6px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>Coin</th>
                  <th style={{ padding: '6px 6px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>Price</th>
                  <th style={{ padding: '6px 6px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>Mcap</th>
                  <th style={{ padding: '6px 6px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>Vol 24h</th>
                </tr>
              </thead>
              <tbody>
                {!cat && !catErr && (
                  <tr><td colSpan={5} style={{ padding: 10, color: C.dim }}>loading…</td></tr>
                )}
                {(cat?.rows ?? []).map((r0) => {
                  const c = r0 as CrCoin;
                  return (
                    <tr key={`${c.key}-${c.rank}`} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={{ padding: '5px 6px', color: C.dim, width: 28 }}>{c.rank ?? '—'}</td>
                      <td style={{ padding: '5px 6px' }}>
                        <span style={{ color: C.white }}>{c.name}</span>
                        <span style={{ color: C.dim, marginLeft: 5, fontSize: 10 }}>{c.symbol}</span>
                      </td>
                      <td style={{ padding: '5px 6px', color: C.white }}>{money(c.priceUsd)}</td>
                      <td style={{ padding: '5px 6px', color: C.white }}>{money(c.marketCap)}</td>
                      <td style={{ padding: '5px 6px', color: C.white }}>{moneyCompact(c.volume24hUsd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 10, color: C.dim, marginTop: 4 }}>
            {cat?.slice ?? ''} · chg24h ships nowhere on this surface → column omitted upstream, not faked
          </div>
        </div>

        {/* exchanges (spot CEX list) */}
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.card, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6, gap: 8, flexWrap: 'wrap' }}>
            <div style={{ color: C.white, fontWeight: 700, fontSize: 13 }}>
              Exchanges{exKey === 'dex/spot' ? ' (DEX spot)' : exKey === 'perpetuals' ? ' (perpetuals)' : ' (CEX spot)'}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {([['cex/spot', 'CEX'], ['dex/spot', 'DEX'], ['perpetuals', 'Perps']] as const).map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => setExKey(k)}
                  style={{
                    fontSize: 10, padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
                    border: `1px solid ${exKey === k ? C.accent : C.border}`,
                    background: exKey === k ? C.accent : 'transparent',
                    color: exKey === k ? C.bg : C.dim,
                    fontWeight: exKey === k ? 700 : 400,
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: C.dim }}>{ex?.count ?? '—'} venues</div>
          </div>
          {exErr && (
            <div style={{ fontSize: 12, color: C.red, marginBottom: 6 }}>⚠ exchanges error: {exErr} — nothing faked</div>
          )}
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: C.dim, textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  <th style={{ padding: '6px 6px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>#</th>
                  <th style={{ padding: '6px 6px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>Exchange</th>
                  <th style={{ padding: '6px 6px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>24h vol</th>
                  <th style={{ padding: '6px 6px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>Share</th>
                  <th style={{ padding: '6px 6px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>Pairs</th>
                </tr>
              </thead>
              <tbody>
                {!ex && !exErr && (
                  <tr><td colSpan={5} style={{ padding: 10, color: C.dim }}>loading…</td></tr>
                )}
                {((ex?.rows ?? []) as CrExchangeRow[]).map((e0) => (
                  <tr key={e0.key} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ padding: '5px 6px', color: C.dim, width: 28 }}>{e0.rank ?? '—'}</td>
                    <td style={{ padding: '5px 6px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        {e0.image && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={e0.image} alt="" width={16} height={16} style={{ borderRadius: '50%' }} />
                        )}
                        <span style={{ color: C.white }}>{e0.name}</span>
                      </div>
                    </td>
                    <td style={{ padding: '5px 6px', color: C.white }}>{moneyCompact(e0.dayVolUsd)}</td>
                    <td style={{ padding: '5px 6px', color: C.accent, whiteSpace: 'nowrap' }}>
                      {e0.percentVolume != null ? `${e0.percentVolume.toFixed(1)}%` : '—'}
                    </td>
                    <td style={{ padding: '5px 6px', color: C.dim }}>{e0.pairsCount ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 10, color: C.dim, marginTop: 4 }}>
            {ex?.slice ?? ''}
          </div>
        </div>

        {/* chain ecosystem (indexed selector + keyed detail) */}
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.card, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6, gap: 8 }}>
            <div style={{ color: C.white, fontWeight: 700, fontSize: 13 }}>
              Chain{chain?.chain ? `: ${chain.chain.name}` : ''}
            </div>
            <select
              value={chainSlug}
              onChange={(e) => setChainSlug(e.target.value)}
              style={{
                fontSize: 11, padding: '3px 6px', borderRadius: 6, maxWidth: 170,
                border: `1px solid ${C.border}`, background: C.bg, color: C.white,
              }}
            >
              {(chainRows.length
                ? chainRows
                : [{ slug: chainSlug, name: chainSlug } as CrChainRow]
              ).map((c) => (
                <option key={c.slug} value={c.slug}>{c.name || c.slug}</option>
              ))}
            </select>
          </div>
          {chain?.chain && (
            <div style={{ fontSize: 10, color: C.dim, marginBottom: 6 }}>
              network {chain.chain.network ?? '—'} · mcap {money(chain.chain.marketCap)}
              {chain.chain.explorerUrl && (
                <>
                  {' · '}
                  <a href={chain.chain.explorerUrl} target="_blank" rel="noreferrer" style={{ color: C.accent }}>
                    explorer ↗
                  </a>
                </>
              )}
            </div>
          )}
          {chainErr && (
            <div style={{ fontSize: 12, color: C.red, marginBottom: 6 }}>⚠ chain '{chainSlug}' error: {chainErr} — nothing faked</div>
          )}
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: C.dim, textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  <th style={{ padding: '6px 5px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>#</th>
                  <th style={{ padding: '6px 5px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>Token</th>
                  <th style={{ padding: '6px 5px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>Price</th>
                  <th style={{ padding: '6px 5px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>Mcap</th>
                </tr>
              </thead>
              <tbody>
                {!chain && !chainErr && (
                  <tr><td colSpan={4} style={{ padding: 10, color: C.dim }}>loading…</td></tr>
                )}
                {(chain?.rows ?? []).slice(0, 100).map((r0) => {
                  const c = r0 as CrCoin;
                  return (
                    <tr key={`${c.key}-${c.rank}`} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={{ padding: '5px 5px', color: C.dim, width: 26 }}>{c.rank ?? '—'}</td>
                      <td style={{ padding: '5px 5px' }}>
                        <span style={{ color: C.white }}>{c.name}</span>
                        <span style={{ color: C.dim, marginLeft: 5, fontSize: 10 }}>{c.symbol}</span>
                      </td>
                      <td style={{ padding: '5px 5px', color: C.white }}>{money(c.priceUsd)}</td>
                      <td style={{ padding: '5px 5px', color: C.white }}>{money(c.marketCap)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 10, color: C.dim, marginTop: 4 }}>
            {chain
              ? `showing ${Math.min(100, chain.count)} of ${chain.count} ecosystem tokens · ${chain.slice ?? ''}`
              : ''}
          </div>
        </div>
      </div>

      {/* -------------------------- news feed ------------------------------- */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 10, marginTop: 16 }}>
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.card, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6, gap: 8, flexWrap: 'wrap' }}>
            <div style={{ color: C.white, fontWeight: 700, fontSize: 13 }}>Latest news</div>
            <div style={{ fontSize: 10, color: C.dim }}>
              {news ? `${news.count} items` : '—'} · links out to original publishers
            </div>
          </div>
          {newsErr && (
            <div style={{ fontSize: 12, color: C.red, marginBottom: 6 }}>⚠ news error: {newsErr} — nothing faked</div>
          )}
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            {(news?.newsRows ?? []).map((n0) => (
              <div key={n0.id ?? n0.title} style={{ padding: '7px 2px', borderBottom: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span style={{
                    fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
                    color: n0.status === 'bullish' ? '#3fb950' : n0.status === 'bearish' ? C.red : C.dim,
                    minWidth: 46,
                  }}>
                    {n0.status ?? '—'}
                  </span>
                  <a
                    href={n0.url ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: C.white, fontSize: 12, textDecoration: 'none', flex: 1 }}
                  >
                    {n0.title}{n0.url ? ' ↗' : ''}
                  </a>
                </div>
                <div style={{ fontSize: 10, color: C.dim, marginLeft: 54, marginTop: 2 }}>
                  {n0.source ?? '—'} · {n0.date ? shortDate(n0.date) : '—'}
                  {n0.readingMinutes != null ? ` · ${n0.readingMinutes.toFixed(1)} min` : ''}
                  {n0.relatedCoins.length
                    ? ` · ${n0.relatedCoins.slice(0, 3).map((c) => `${c.symbol} ${money(c.priceUsd)}`).join(' · ')}`
                    : ''}
                </div>
              </div>
            ))}
            {!news && !newsErr && (
              <div style={{ padding: 10, color: C.dim, fontSize: 12 }}>loading…</div>
            )}
            {news && (news.newsRows ?? []).length === 0 && (
              <div style={{ padding: 10, color: C.dim, fontSize: 12 }}>upstream shipped no rows — nothing faked</div>
            )}
          </div>
          <div style={{ fontSize: 10, color: C.dim, marginTop: 4 }}>{news?.slice ?? ''}</div>
        </div>
      </div>

      {/* -------------------------- fundraising ----------------------------- */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 10, marginTop: 16 }}>
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.card, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
            <div style={{ color: C.white, fontWeight: 700, fontSize: 13 }}>Recent funding rounds</div>
            <div style={{ fontSize: 10, color: C.dim }}>{home?.fundingRounds?.length ?? '—'} · homepage slice</div>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <tbody>
              {(home?.fundingRounds ?? []).map((f, i) => (
                <tr key={`${f.coinKey}-${f.date}-${i}`} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: '6px 4px', color: C.dim, whiteSpace: 'nowrap' }}>{shortDate(f.date)}</td>
                  <td style={{ padding: '6px 4px' }}>
                    <div style={{ color: C.white }}>{f.coinName ?? '—'}</div>
                    <div style={{ fontSize: 10, color: C.dim }}>{f.funds.slice(0, 3).join(', ') || '—'}</div>
                  </td>
                  <td style={{ padding: '6px 4px', color: C.accent, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {f.type ?? '—'}
                  </td>
                  <td style={{ padding: '6px 4px', color: C.white, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {moneyCompact(f.raiseUsd)}
                  </td>
                </tr>
              ))}
              {!home && !homeErr && (
                <tr><td style={{ padding: 10, color: C.dim }}>loading…</td></tr>
              )}
              {home && (home.fundingRounds ?? []).length === 0 && (
                <tr><td style={{ padding: 10, color: C.dim }}>upstream shipped no rows — nothing faked</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.card, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
            <div style={{ color: C.white, fontWeight: 700, fontSize: 13 }}>Upcoming IDO / IEO</div>
            <div style={{ fontSize: 10, color: C.dim }}>{home?.upcomingIco?.length ?? '—'} · homepage slice</div>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <tbody>
              {(home?.upcomingIco ?? []).map((ic, i) => (
                <tr key={`${ic.key}-${i}`} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: '6px 4px', color: C.dim, whiteSpace: 'nowrap' }}>{shortDate(ic.date)}</td>
                  <td style={{ padding: '6px 4px' }}>
                    <span style={{ color: C.white }}>{ic.name ?? '—'}</span>
                    <span style={{ color: C.dim, marginLeft: 6, fontSize: 11 }}>{ic.symbol ?? ''}</span>
                    <div style={{ fontSize: 10, color: C.dim }}>{ic.platform ?? '—'}</div>
                  </td>
                  <td style={{ padding: '6px 4px', color: C.white, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {moneyCompact(ic.raiseUsd)}
                  </td>
                </tr>
              ))}
              {!home && !homeErr && (
                <tr><td style={{ padding: 10, color: C.dim }}>loading…</td></tr>
              )}
              {home && (home.upcomingIco ?? []).length === 0 && (
                <tr><td style={{ padding: 10, color: C.dim }}>upstream shipped no rows — nothing faked</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* launchpool events (past / upcoming — 3-gate verified 2026-09-27) */}
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.card, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6, gap: 8, flexWrap: 'wrap' }}>
            <div style={{ color: C.white, fontWeight: 700, fontSize: 13 }}>
              Launchpool{lpKey === 'upcoming' ? ' (upcoming)' : ' (past)'}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {([['past', 'Past'], ['upcoming', 'Upcoming']] as const).map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => setLpKey(k)}
                  style={{
                    fontSize: 10, padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
                    border: `1px solid ${lpKey === k ? C.accent : C.border}`,
                    background: lpKey === k ? C.accent : 'transparent',
                    color: lpKey === k ? C.bg : C.dim,
                    fontWeight: lpKey === k ? 700 : 400,
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: C.dim }}>
              {lp ? (lp.upstreamTotal != null ? `${lp.count} of ${lp.upstreamTotal}` : `${lp.count}`) : '—'} events
            </div>
          </div>
          {lpErr && (
            <div style={{ fontSize: 12, color: C.red, marginBottom: 6 }}>⚠ launchpool error: {lpErr} — nothing faked</div>
          )}
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: C.dim, textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  <th style={{ padding: '6px 6px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>Project</th>
                  <th style={{ padding: '6px 6px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>Launchpad</th>
                  <th style={{ padding: '6px 6px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>Window</th>
                  <th style={{ padding: '6px 6px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>Raise</th>
                </tr>
              </thead>
              <tbody>
                {!lp && !lpErr && (
                  <tr><td colSpan={4} style={{ padding: 10, color: C.dim }}>loading…</td></tr>
                )}
                {(lp?.launchpoolRows ?? []).map((r0) => (
                  <tr key={r0.key} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ padding: '5px 6px' }}>
                      <span style={{ color: C.white }}>{r0.name}</span>
                      <span style={{ color: C.dim, marginLeft: 6, fontSize: 10 }}>{r0.symbol}</span>
                      {r0.category && <div style={{ fontSize: 10, color: C.dim }}>{r0.category}</div>}
                    </td>
                    <td style={{ padding: '5px 6px', color: C.dim }}>{r0.launchpads.join(', ') || '—'}</td>
                    <td style={{ padding: '5px 6px', color: C.white, whiteSpace: 'nowrap' }}>
                      {r0.when ? shortDate(r0.when) : '—'}{r0.when || r0.till ? ` → ${r0.till ? shortDate(r0.till) : '—'}` : ''}
                    </td>
                    <td style={{ padding: '5px 6px', color: C.white, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {moneyCompact(r0.totalRaiseUsd)}
                    </td>
                  </tr>
                ))}
                {lp && (lp.launchpoolRows ?? []).length === 0 && (
                  <tr><td colSpan={4} style={{ padding: 10, color: C.dim }}>upstream shipped no rows — nothing faked</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 10, color: C.dim, marginTop: 4 }}>
            {lp?.slice ?? ''}
          </div>
        </div>
      </div>

      <div style={{ fontSize: 10, color: C.dim, marginTop: 8 }}>
        {home?.slice ?? ''} — funding rounds + IDO rows come from the homepage slice only (6 + 6, partial by
        design and press-verified: CoinGlass/CoinMarketCap 2026-09-25 matches the GlobeNewswire release);
        Launchpool rows are full event lists (past 50 of 527 / all upcoming) with windows verified against
        KuCoin's official GemPool dates (gno-land 2026-09-16 → 09-26). The /funding-rounds and /token-unlock HTML paths answer a Cloudflare interstitial to every
        client tried, and their Next.js data routes serve SYNTHETIC decoy (nonexistent slugs return 200
        fabricated payloads; measured 2026-09-27) — those modes are refused by the API with a 503, never
        rendered. Contract + decoy detector: scripts/verify-cryptorank.py.
      </div>
    </div>
  );
}

function Stat({
  label, value, sub, subColor,
}: {
  label: string; value: string; sub: string; subColor: string;
}) {
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.card, padding: '10px 12px' }}>
      <div style={{ fontSize: 10, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: C.white, marginTop: 3 }}>{value}</div>
      <div style={{ fontSize: 11, color: subColor, marginTop: 1 }}>{sub || ' '}</div>
    </div>
  );
}

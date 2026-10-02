'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  alpha,
  color,
  fontSize,
  fontWeight,
  letterSpacing,
  lineHeight,
  radius,
  space,
} from '@/styles/tokens';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
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
  type CrTagRow,
  type CrTrendingRow,
} from './client';

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
  if (v == null) return color.textMuted;
  return v > 0 ? color.positive : v < 0 ? color.negative : color.textMuted;
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

  const [ndKey, setNdKey] = useState<string>('past');
  const [nd, setNd] = useState<CrEnvelope | null>(null);
  const [ndErr, setNdErr] = useState('');

  const [ecoSlug, setEcoSlug] = useState<string>('ethereum');
  const [ecoIdx, setEcoIdx] = useState<CrEnvelope | null>(null);
  const [eco, setEco] = useState<CrEnvelope | null>(null);
  const [ecoErr, setEcoErr] = useState('');

  const [rwaKey, setRwaKey] = useState<string>('stocks/wendy-s');
  const [rwa, setRwa] = useState<CrEnvelope | null>(null);
  const [rwaDet, setRwaDet] = useState<CrEnvelope | null>(null);
  const [rwaErr, setRwaErr] = useState('');

  const [qtrSide, setQtrSide] = useState<'btc' | 'eth'>('btc');
  const [qtr, setQtr] = useState<CrEnvelope | null>(null);
  const [qtrErr, setQtrErr] = useState('');

  const [pred, setPred] = useState<CrEnvelope | null>(null);
  const [predErr, setPredErr] = useState('');

  const [news, setNews] = useState<CrEnvelope | null>(null);
  const [newsErr, setNewsErr] = useState('');

  const [conv, setConv] = useState<CrEnvelope | null>(null);
  const [convErr, setConvErr] = useState('');

  const [media, setMedia] = useState<CrEnvelope | null>(null);
  const [mediaErr, setMediaErr] = useState('');

  const [ntagSlug, setNtagSlug] = useState<string>('defi');
  const [ntag, setNtag] = useState<CrEnvelope | null>(null);
  const [ntagErr, setNtagErr] = useState('');

  const [aiOv, setAiOv] = useState<CrEnvelope | null>(null);
  const [aiOvErr, setAiOvErr] = useState('');

  const [tagRows, setTagRows] = useState<CrTagRow[]>([]);
  const [tagSlug, setTagSlug] = useState<string>('layer-1');
  const [tag, setTag] = useState<CrEnvelope | null>(null);
  const [tagErr, setTagErr] = useState('');

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

  const fetchNd = useCallback(async (key = 'past', fresh = false) => {
    try {
      const env = await loadMode('nodesale', fresh, key);
      setNd(env);
      setNdErr('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setNdErr(msg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchEcoIdx = useCallback(async (fresh = false) => {
    try {
      const env = await loadMode('ecosystems', fresh);
      setEcoIdx(env);
      setEcoErr('');
    } catch (e) {
      setEcoErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchEco = useCallback(async (key: string, fresh = false) => {
    try {
      const env = await loadMode('ecosystem', fresh, key);
      setEco(env);
      setEcoErr('');
    } catch (e) {
      setEcoErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchRwaIdx = useCallback(async (fresh = false) => {
    try {
      const env = await loadMode('rwa', fresh);
      setRwa(env);
      setRwaErr('');
    } catch (e) {
      setRwaErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchRwaDet = useCallback(async (key: string, fresh = false) => {
    try {
      const env = await loadMode('rwaasset', fresh, key);
      setRwaDet(env);
      setRwaErr('');
    } catch (e) {
      setRwaErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchQtr = useCallback(async (fresh = false) => {
    try {
      const env = await loadMode('quarterly', fresh);
      setQtr(env);
      setQtrErr('');
    } catch (e) {
      setQtrErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchPred = useCallback(async (fresh = false) => {
    try {
      const env = await loadMode('prediction', fresh);
      setPred(env);
      setPredErr('');
    } catch (e) {
      setPredErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchConv = useCallback(async (fresh = false) => {
    try {
      const env = await loadMode('converter', fresh);
      setConv(env);
      setConvErr('');
    } catch (e) {
      setConvErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchMedia = useCallback(async (fresh = false) => {
    try {
      const env = await loadMode('media', fresh);
      setMedia(env);
      setMediaErr('');
    } catch (e) {
      setMediaErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchNewsTag = useCallback(async (slug: string, fresh = false) => {
    try {
      const env = await loadMode('newstag', fresh, slug);
      setNtag(env);
      setNtagErr('');
    } catch (e) {
      setNtagErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchAiOv = useCallback(async (fresh = false) => {
    try {
      const env = await loadMode('aioverview', fresh);
      setAiOv(env);
      setAiOvErr('');
    } catch (e) {
      setAiOvErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchTagIndex = useCallback(async (fresh = false) => {
    try {
      const env = await loadMode('tags', fresh);
      setTagRows(env.tagRows ?? []);
    } catch {
      setTagRows([]); // selector falls back to the current slug only
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchTag = useCallback(async (slug: string, fresh = false) => {
    try {
      const env = await loadMode('tag', fresh, slug);
      setTag(env);
      setTagErr('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTagErr(msg);
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
    void fetchTagIndex();
    void fetchTag('layer-1');
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
    void fetchNd(ndKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ndKey]);

  useEffect(() => {
    void fetchEcoIdx();
    void fetchRwaIdx();
    void fetchQtr();
    void fetchPred();
    void fetchConv();
    void fetchMedia();
    void fetchAiOv();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void fetchNewsTag(ntagSlug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ntagSlug]);

  useEffect(() => {
    void fetchEco(ecoSlug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ecoSlug]);

  useEffect(() => {
    void fetchRwaDet(rwaKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rwaKey]);

  useEffect(() => {
    void fetchTag(tagSlug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagSlug]);

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
      <div style={{ display: 'flex', alignItems: 'baseline', gap: space[12], flexWrap: 'wrap', marginBottom: space[4] }}>
        <div style={{ fontSize: fontSize[20], fontWeight: fontWeight.bold, color: color.text }}>CryptoRank</div>
        <a href={CR_BASE} target="_blank" rel="noreferrer" style={{ fontSize: fontSize[11], color: color.accent }}>
          cryptorank.io ↗
        </a>
        <div style={{ fontSize: fontSize[11], color: color.textMuted }}>
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
            marginLeft: 'auto', fontSize: fontSize[11], color: color.bg, background: color.accent,
            border: 'none', borderRadius: radius[6], padding: `${space[4]}px ${space[12]}px`, cursor: 'pointer', fontWeight: fontWeight.bold,
          }}
        >
          ↻ refresh
        </button>
      </div>

      {homeErr && (
        <div style={{ fontSize: fontSize[12], color: color.negative, marginBottom: space[8] }}>
          ⚠ cryptorank home error: {homeErr} — nothing faked
          {homeStale && home ? ' · last good stats below, stamped' : ''}
        </div>
      )}

      {/* --------------------------- stats strip ---------------------------- */}
      <div
        style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: space[8], marginBottom: space[14],
        }}
      >
        <Stat label="Total market cap" value={money(global?.totalMarketCap)} sub={pct(global?.totalMarketCapChangePercent)} subColor={chgColor(global?.totalMarketCapChangePercent)} />
        <Stat label="24h volume" value={money(global?.totalVolume24h)} sub={pct(global?.totalVolume24hChangePercent)} subColor={chgColor(global?.totalVolume24hChangePercent)} />
        <Stat label="BTC dominance" value={global?.btcDominance != null ? `${global.btcDominance.toFixed(1)}%` : '—'} sub={pct(global?.btcDominanceChangePercent)} subColor={chgColor(global?.btcDominanceChangePercent)} />
        <Stat label="ETH dominance" value={global?.ethDominance != null ? `${global.ethDominance.toFixed(1)}%` : '—'} sub={pct(global?.ethDominanceChangePercent)} subColor={chgColor(global?.ethDominanceChangePercent)} />
        <Stat label="Tracked assets" value={global?.allCurrencies != null ? global.allCurrencies.toLocaleString('en-US') : '—'} sub="" subColor={color.textMuted} />
        <Stat label="Gas (avg)" value={global?.gasGwei != null ? `${global.gasGwei.toFixed(1)} gwei` : '—'} sub="" subColor={color.textMuted} />
      </div>

      {/* ------------------------ spotlight coin --------------------------- */}
      <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: space[12], marginBottom: space[14] }}>
        <div style={{ display: 'flex', gap: space[8], alignItems: 'center', marginBottom: space[8], flexWrap: 'wrap' }}>
          <div style={{ color: color.text, fontWeight: fontWeight.bold, fontSize: fontSize[13] }}>Coin spotlight</div>
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
              fontSize: fontSize[12], padding: `${space[4]}px ${space[8]}px`, borderRadius: radius[6], width: 180,
              border: `1px solid ${color.border}`, background: color.bg, color: color.text,
            }}
          />
          <button
            onClick={() => {
              setCoinKey(coinInput.trim());
              void fetchDetail(coinInput.trim());
            }}
            style={{
              fontSize: fontSize[11], padding: `${space[4]}px ${space[10]}px`, borderRadius: radius[6], cursor: 'pointer',
              border: `1px solid ${color.accent}`, background: 'transparent', color: color.accent, fontWeight: fontWeight.bold,
            }}
          >
            load
          </button>
          {detail && (
            <a
              href={`${CR_BASE}/price/${detail.key}`}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: fontSize[11], color: color.accent, marginLeft: 'auto' }}
            >
              {detail.name} ({detail.symbol}) ↗
            </a>
          )}
        </div>
        {detailErr && (
          <div style={{ fontSize: fontSize[12], color: color.negative, marginBottom: space[6] }}>
            ⚠ coin '{coinKey}' error: {detailErr} — nothing faked
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: space[8] }}>
          <Stat label="Price" value={money(detail?.priceUsd)} sub="" subColor={color.textMuted} />
          <Stat
            label="Chg 24h (derived)"
            value={detail?.change24h != null ? pct(detail.change24h) : '—'}
            sub=""
            subColor={chgColor(detail?.change24h ?? null)}
          />
          <Stat label="Market cap" value={money(detail?.marketCap)} sub={detail?.rank != null ? `rank #${detail.rank}` : ''} subColor={color.textMuted} />
          <Stat label="Volume 24h" value={money(detail?.volume24h)} sub="" subColor={color.textMuted} />
          <Stat
            label="ATH"
            value={money(detail?.athUsd)}
            sub={shortDate(detail?.athDate ?? null)}
            subColor={color.textMuted}
          />
          <Stat
            label="From ATL"
            value={detail?.fromAtlPct != null ? pct(detail.fromAtlPct) : '—'}
            sub={shortDate(detail?.atlDate ?? null)}
            subColor={color.textMuted}
          />
          <Stat
            label="Circulating"
            value={supply(detail?.availableSupply, detail?.symbol)}
            sub={detail?.circulatingPct != null ? `${detail.circulatingPct.toFixed(1)}% of total` : ''}
            subColor={color.textMuted}
          />
          <Stat label="Max supply" value={detail?.maxSupply != null ? detail.maxSupply.toLocaleString('en-US') : '—'} sub="" subColor={color.textMuted} />
        </div>
        <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: space[6] }}>
          source: /price/{coinKey} SSR payload (3-gate verified) · chg24h derived from histPrices["24H"] anchor ·
          sparse fields render em-dash, never 0
        </div>
      </div>

      {/* --------------------------- market table --------------------------- */}
      <div style={{ display: 'flex', gap: space[6], marginBottom: space[8], alignItems: 'center', flexWrap: 'wrap' }}>
        {MARKET_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              fontSize: fontSize[11], padding: `${space[4]}px ${space[10]}px`, borderRadius: radius[6], cursor: 'pointer',
              border: `1px solid ${tab === t.key ? color.accent : color.border}`,
              background: tab === t.key ? color.accent : 'transparent',
              color: tab === t.key ? color.bg : color.textMuted,
              fontWeight: tab === t.key ? fontWeight.bold : fontWeight.regular,
            }}
          >
            {t.label}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', fontSize: fontSize[11], color: color.textMuted }}>
          {market &&
            `${market.count} rows` +
            (market.upstreamTotal && market.upstreamTotal !== market.count
              ? ` of ${market.upstreamTotal} upstream`
              : '')}
        </div>
      </div>

      {marketErr && (
        <div style={{ fontSize: fontSize[12], color: color.negative, marginBottom: space[8] }}>
          ⚠ cryptorank {tab} error: {marketErr} — no data faked
          {marketStale && market ? ' · showing last good rows, stamped' : ''}
        </div>
      )}

      <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], overflow: 'hidden', background: color.surface }}>
        <Table>
          <THead>
            <tr style={{ color: color.textMuted, textAlign: 'left', fontSize: fontSize[11], textTransform: 'uppercase', letterSpacing: letterSpacing.xs }}>
              {colHead.map((h) => (
                <TH key={h} style={{ padding: `${space[8]}px ${space[10]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>{h}</TH>
              ))}
            </tr>
          </THead>
          <TBody>
            {loadingMarket && !market && (
              <tr><TD colSpan={colHead.length} style={{ padding: space[16], color: color.textMuted }}>loading…</TD></tr>
            )}
            {!loadingMarket && !market && !marketErr && (
              <tr><TD colSpan={colHead.length} style={{ padding: space[16], color: color.textMuted }}>no data</TD></tr>
            )}
            {rows.map((r) => (
              <TR key={`${r.key}-${r.rank}`}>
                <td style={{ padding: '7px 10px', color: color.textMuted, width: 34 }}>{r.rank ?? '—'}</td>
                <td style={{ padding: '7px 10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: space[8] }}>
                    {r.image && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.image} alt="" width={18} height={18} style={{ borderRadius: radius.circle }} />
                    )}
                    <div>
                      <span style={{ color: color.text }}>{r.name}</span>
                      <span style={{ color: color.textMuted, marginLeft: space[6], fontSize: fontSize[11] }}>{r.symbol}</span>
                    </div>
                  </div>
                </td>
                <td style={{ padding: '7px 10px', color: color.text }}>{money(r.priceUsd)}</td>
                {!isPlain && (
                  <td style={{ padding: '7px 10px', color: chgColor(r.change24h), fontVariantNumeric: 'tabular-nums' }}>
                    {pct(r.change24h)}
                  </td>
                )}
                <td style={{ padding: '7px 10px', color: color.text }}>{money(r.marketCap)}</td>
                <td style={{ padding: '7px 10px', color: color.text }}>{moneyCompact(r.volume24hUsd)}</td>
                {isPlain && (
                  <td style={{ padding: '7px 10px', color: color.textMuted }}>
                    {money((r as CrCoin).athUsd)}
                  </td>
                )}
              </TR>
            ))}
          </TBody>
        </Table>
      </div>

      <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: space[4] }}>
        {tab === 'coins' && 'source: /all-coins-list SSR payload · 24h change ships on trending/gainers pages only → em-dash where upstream gives none'}
        {tab === 'trending' && 'source: /trending SSR payload · chg 24h is an upstream field'}
        {(tab === 'gainers' || tab === 'losers') &&
          `source: /${tab} SSR payload · chg 24h derived from upstream histPrices["24H"] anchor (150-row upstream list)`}
      </div>

      {/* -------------------------- listings ------------------------------ */}
      {listingsErr && (
        <div style={{ fontSize: fontSize[12], color: color.negative, marginTop: space[14] }}>
          ⚠ listings error: {listingsErr} — nothing faked
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: space[10], marginTop: space[16] }}>
        {([
          ['Recently added', listings?.listings?.recentlyAdded, true],
          ['Most searched', listings?.listings?.mostSearched, false],
          ['Most visited', listings?.listings?.mostVisited, false],
        ] as const).map(([title, rowsL, showDate]) => (
          <div key={title} style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: space[12] }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[6] }}>
              <div style={{ color: color.text, fontWeight: fontWeight.bold, fontSize: fontSize[13] }}>{title}</div>
              <div style={{ fontSize: fontSize[10], color: color.textMuted }}>{rowsL?.length ?? '—'} coins</div>
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              <Table>
                <THead>
                  <tr style={{ color: color.textMuted, textAlign: 'left', fontSize: fontSize[11], textTransform: 'uppercase', letterSpacing: letterSpacing.xs }}>
                    <TH style={{ padding: '6px 5px', borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>#</TH>
                    <TH style={{ padding: '6px 5px', borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Coin</TH>
                    <TH style={{ padding: '6px 5px', borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Price</TH>
                    <TH style={{ padding: '6px 5px', borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Chg 24h</TH>
                    <TH style={{ padding: '6px 5px', borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Chg 7d</TH>
                  </tr>
                </THead>
                <TBody>
                  {!listings && !listingsErr && (
                    <tr><TD colSpan={5} style={{ padding: space[10], color: color.textMuted }}>loading…</TD></tr>
                  )}
                  {(rowsL ?? []).map((c) => (
                    <TR key={`${c.key}-${c.rank}`}>
                      <td style={{ padding: '5px 5px', color: color.textMuted, width: space[24] }}>{c.rank ?? '—'}</td>
                      <td style={{ padding: '5px 5px' }}>
                        <div style={{ color: color.text }}>{c.name}</div>
                        <div style={{ color: color.textMuted, fontSize: fontSize[10] }}>
                          {c.symbol}{showDate && c.listingDate ? ` · ${shortDate(c.listingDate)}` : ''}
                        </div>
                      </td>
                      <td style={{ padding: '5px 5px', color: color.text }}>{money(c.priceUsd)}</td>
                      <td style={{ padding: '5px 5px', color: chgColor(c.change24h) }}>{pct(c.change24h)}</td>
                      <td style={{ padding: '5px 5px', color: chgColor(c.change7d ?? null)}}>{pct(c.change7d ?? null)}</td>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: space[4] }}>
        {listings?.slice ?? 'source: /listings SSR payload'}
      </div>

      {/* ------------------- sectors + exchanges --------------------------- */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: space[10], marginTop: space[16] }}>
        {/* sectors (categories, keyed) */}
        <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: space[12] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[6], gap: space[8] }}>
            <div style={{ color: color.text, fontWeight: fontWeight.bold, fontSize: fontSize[13] }}>
              Sectors{cat?.category ? `: ${cat.category.name}` : ''}
            </div>
            <select
              value={catSlug}
              onChange={(e) => setCatSlug(e.target.value)}
              style={{
                fontSize: fontSize[11], padding: '3px 6px', borderRadius: radius[6],
                border: `1px solid ${color.border}`, background: color.bg, color: color.text,
              }}
            >
              {CR_CATEGORY_SLUGS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          {cat?.category && (
            <div style={{ fontSize: fontSize[10], color: color.textMuted, marginBottom: space[6] }}>
              breadth: <span style={{ color: color.positive }}>{cat.category.gainers ?? '—'} gainers</span>
              {' / '}
              <span style={{ color: color.negative }}>{cat.category.losers ?? '—'} losers</span>
            </div>
          )}
          {catErr && (
            <div style={{ fontSize: fontSize[12], color: color.negative, marginBottom: space[6] }}>⚠ sector '{catSlug}' error: {catErr} — nothing faked</div>
          )}
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            <Table>
              <THead>
                <tr style={{ color: color.textMuted, textAlign: 'left', fontSize: fontSize[11], textTransform: 'uppercase', letterSpacing: letterSpacing.xs }}>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>#</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Coin</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Price</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Mcap</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Vol 24h</TH>
                </tr>
              </THead>
              <TBody>
                {!cat && !catErr && (
                  <tr><TD colSpan={5} style={{ padding: space[10], color: color.textMuted }}>loading…</TD></tr>
                )}
                {(cat?.rows ?? []).map((r0) => {
                  const c = r0 as CrCoin;
                  return (
                    <TR key={`${c.key}-${c.rank}`}>
                      <td style={{ padding: '5px 6px', color: color.textMuted, width: space[28] }}>{c.rank ?? '—'}</td>
                      <td style={{ padding: '5px 6px' }}>
                        <span style={{ color: color.text }}>{c.name}</span>
                        <span style={{ color: color.textMuted, marginLeft: 5, fontSize: fontSize[10] }}>{c.symbol}</span>
                      </td>
                      <td style={{ padding: '5px 6px', color: color.text }}>{money(c.priceUsd)}</td>
                      <td style={{ padding: '5px 6px', color: color.text }}>{money(c.marketCap)}</td>
                      <td style={{ padding: '5px 6px', color: color.text }}>{moneyCompact(c.volume24hUsd)}</td>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
          <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: space[4] }}>
            {cat?.slice ?? ''} · chg24h ships nowhere on this surface → column omitted upstream, not faked
          </div>
        </div>

        {/* exchanges (spot CEX list) */}
        <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: space[12] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[6], gap: space[8], flexWrap: 'wrap' }}>
            <div style={{ color: color.text, fontWeight: fontWeight.bold, fontSize: fontSize[13] }}>
              Exchanges{exKey === 'dex/spot' ? ' (DEX spot)' : exKey === 'perpetuals' ? ' (perpetuals)' : exKey === 'cex-transparency' ? ' (reserve transparency)' : ' (CEX spot)'}
            </div>
            <div style={{ display: 'flex', gap: space[4] }}>
              {([['cex/spot', 'CEX'], ['dex/spot', 'DEX'], ['perpetuals', 'Perps'], ['cex-transparency', 'Reserves']] as const).map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => setExKey(k)}
                  style={{
                    fontSize: fontSize[10], padding: '3px 8px', borderRadius: radius[6], cursor: 'pointer',
                    border: `1px solid ${exKey === k ? color.accent : color.border}`,
                    background: exKey === k ? color.accent : 'transparent',
                    color: exKey === k ? color.bg : color.textMuted,
                    fontWeight: exKey === k ? fontWeight.bold : fontWeight.regular,
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
            <div style={{ fontSize: fontSize[10], color: color.textMuted }}>{ex?.count ?? '—'} venues</div>
          </div>
          {exErr && (
            <div style={{ fontSize: fontSize[12], color: color.negative, marginBottom: space[6] }}>⚠ exchanges error: {exErr} — nothing faked</div>
          )}
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            <Table>
              <THead>
                <tr style={{ color: color.textMuted, textAlign: 'left', fontSize: fontSize[11], textTransform: 'uppercase', letterSpacing: letterSpacing.xs }}>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>#</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Exchange</TH>
                  {exKey === 'cex-transparency' ? (
                    <>
                      <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Reserves</TH>
                      <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Clean</TH>
                      <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Stable %</TH>
                      <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Wallets</TH>
                    </>
                  ) : (
                    <>
                      <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>24h vol</TH>
                      <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Share</TH>
                      <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Pairs</TH>
                    </>
                  )}
                </tr>
              </THead>
              <TBody>
                {!ex && !exErr && (
                  <tr><TD colSpan={exKey === 'cex-transparency' ? 6 : 5} style={{ padding: space[10], color: color.textMuted }}>loading…</TD></tr>
                )}
                {((ex?.rows ?? []) as CrExchangeRow[]).map((e0) => (
                  <TR key={e0.key}>
                    <td style={{ padding: '5px 6px', color: color.textMuted, width: space[28] }}>{e0.rank ?? '—'}</td>
                    <td style={{ padding: '5px 6px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        {e0.image && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={e0.image} alt="" width={16} height={16} style={{ borderRadius: radius.circle }} />
                        )}
                        <span style={{ color: color.text }}>{e0.name}</span>
                      </div>
                    </td>
                    {exKey === 'cex-transparency' ? (
                      <>
                        <td style={{ padding: '5px 6px', color: color.text, whiteSpace: 'nowrap' }}>{moneyCompact(e0.reservesUsd)}</td>
                        <td style={{ padding: '5px 6px', color: color.text, whiteSpace: 'nowrap' }}>{moneyCompact(e0.cleanReservesUsd)}</td>
                        <td style={{ padding: '5px 6px', color: color.accent, whiteSpace: 'nowrap' }}>
                          {e0.stablecoinsPercent != null ? `${e0.stablecoinsPercent.toFixed(1)}%` : '—'}
                        </td>
                        <td style={{ padding: '5px 6px', color: color.textMuted }}>{e0.walletsCount ?? '—'}</td>
                      </>
                    ) : (
                      <>
                        <td style={{ padding: '5px 6px', color: color.text }}>{moneyCompact(e0.dayVolUsd)}</td>
                        <td style={{ padding: '5px 6px', color: color.accent, whiteSpace: 'nowrap' }}>
                          {e0.percentVolume != null ? `${e0.percentVolume.toFixed(1)}%` : '—'}
                        </td>
                        <td style={{ padding: '5px 6px', color: color.textMuted }}>{e0.pairsCount ?? '—'}</td>
                      </>
                    )}
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: space[4] }}>
            {ex?.slice ?? ''}
          </div>
        </div>

        {/* chain ecosystem (indexed selector + keyed detail) */}
        <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: space[12] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[6], gap: space[8] }}>
            <div style={{ color: color.text, fontWeight: fontWeight.bold, fontSize: fontSize[13] }}>
              Chain{chain?.chain ? `: ${chain.chain.name}` : ''}
            </div>
            <select
              value={chainSlug}
              onChange={(e) => setChainSlug(e.target.value)}
              style={{
                fontSize: fontSize[11], padding: '3px 6px', borderRadius: radius[6], maxWidth: 170,
                border: `1px solid ${color.border}`, background: color.bg, color: color.text,
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
            <div style={{ fontSize: fontSize[10], color: color.textMuted, marginBottom: space[6] }}>
              network {chain.chain.network ?? '—'} · mcap {money(chain.chain.marketCap)}
              {chain.chain.explorerUrl && (
                <>
                  {' · '}
                  <a href={chain.chain.explorerUrl} target="_blank" rel="noreferrer" style={{ color: color.accent }}>
                    explorer ↗
                  </a>
                </>
              )}
            </div>
          )}
          {chainErr && (
            <div style={{ fontSize: fontSize[12], color: color.negative, marginBottom: space[6] }}>⚠ chain '{chainSlug}' error: {chainErr} — nothing faked</div>
          )}
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            <Table>
              <THead>
                <tr style={{ color: color.textMuted, textAlign: 'left', fontSize: fontSize[11], textTransform: 'uppercase', letterSpacing: letterSpacing.xs }}>
                  <TH style={{ padding: '6px 5px', borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>#</TH>
                  <TH style={{ padding: '6px 5px', borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Token</TH>
                  <TH style={{ padding: '6px 5px', borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Price</TH>
                  <TH style={{ padding: '6px 5px', borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Mcap</TH>
                </tr>
              </THead>
              <TBody>
                {!chain && !chainErr && (
                  <tr><TD colSpan={4} style={{ padding: space[10], color: color.textMuted }}>loading…</TD></tr>
                )}
                {(chain?.rows ?? []).slice(0, 100).map((r0) => {
                  const c = r0 as CrCoin;
                  return (
                    <TR key={`${c.key}-${c.rank}`}>
                      <td style={{ padding: '5px 5px', color: color.textMuted, width: 26 }}>{c.rank ?? '—'}</td>
                      <td style={{ padding: '5px 5px' }}>
                        <span style={{ color: color.text }}>{c.name}</span>
                        <span style={{ color: color.textMuted, marginLeft: 5, fontSize: fontSize[10] }}>{c.symbol}</span>
                      </td>
                      <td style={{ padding: '5px 5px', color: color.text }}>{money(c.priceUsd)}</td>
                      <td style={{ padding: '5px 5px', color: color.text }}>{money(c.marketCap)}</td>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
          <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: space[4] }}>
            {chain
              ? `showing ${Math.min(100, chain.count)} of ${chain.count} ecosystem tokens · ${chain.slice ?? ''}`
              : ''}
          </div>
        </div>

        {/* tag taxonomy (index-fed selector + keyed coin list) */}
        <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: space[12] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[6], gap: space[8] }}>
            <div style={{ color: color.text, fontWeight: fontWeight.bold, fontSize: fontSize[13] }}>
              Tag{tag?.tag ? `: ${tag.tag.name}` : ''}
            </div>
            <select
              value={tagSlug}
              onChange={(e) => setTagSlug(e.target.value)}
              style={{
                fontSize: fontSize[11], padding: '3px 6px', borderRadius: radius[6], maxWidth: 170,
                border: `1px solid ${color.border}`, background: color.bg, color: color.text,
              }}
            >
              {(tagRows.length
                ? tagRows
                : [{ slug: tagSlug, name: tagSlug } as CrTagRow]
              ).map((t0) => (
                <option key={t0.slug} value={t0.slug}>{t0.name || t0.slug}</option>
              ))}
            </select>
          </div>
          {tag?.tag && (
            <div style={{ fontSize: fontSize[10], color: color.textMuted, marginBottom: space[6] }}>
              {tag.tag.subtitle ?? '—'}
            </div>
          )}
          {tagErr && (
            <div style={{ fontSize: fontSize[12], color: color.negative, marginBottom: space[6] }}>⚠ tag '{tagSlug}' error: {tagErr} — nothing faked</div>
          )}
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            <Table>
              <THead>
                <tr style={{ color: color.textMuted, textAlign: 'left', fontSize: fontSize[11], textTransform: 'uppercase', letterSpacing: letterSpacing.xs }}>
                  <TH style={{ padding: '6px 5px', borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>#</TH>
                  <TH style={{ padding: '6px 5px', borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Token</TH>
                  <TH style={{ padding: '6px 5px', borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Price</TH>
                  <TH style={{ padding: '6px 5px', borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Mcap</TH>
                </tr>
              </THead>
              <TBody>
                {!tag && !tagErr && (
                  <tr><TD colSpan={4} style={{ padding: space[10], color: color.textMuted }}>loading…</TD></tr>
                )}
                {(tag?.rows ?? []).slice(0, 100).map((r0) => {
                  const c = r0 as CrCoin;
                  return (
                    <TR key={`${c.key}-${c.rank}`}>
                      <td style={{ padding: '5px 5px', color: color.textMuted, width: 26 }}>{c.rank ?? '—'}</td>
                      <td style={{ padding: '5px 5px' }}>
                        <span style={{ color: color.text }}>{c.name}</span>
                        <span style={{ color: color.textMuted, marginLeft: 5, fontSize: fontSize[10] }}>{c.symbol}</span>
                      </td>
                      <td style={{ padding: '5px 5px', color: color.text }}>{money(c.priceUsd)}</td>
                      <td style={{ padding: '5px 5px', color: color.text }}>{money(c.marketCap)}</td>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
          <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: space[4] }}>
            {tag
              ? `showing ${Math.min(100, tag.count)} of ${tag.count} tagged coins · ${tag.slice ?? ''}`
              : ''}
          </div>
        </div>
      </div>

      {/* -------------------------- news feed ------------------------------- */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: space[10], marginTop: space[16] }}>
        <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: space[12] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[6], gap: space[8], flexWrap: 'wrap' }}>
            <div style={{ color: color.text, fontWeight: fontWeight.bold, fontSize: fontSize[13] }}>Latest news</div>
            <div style={{ fontSize: fontSize[10], color: color.textMuted }}>
              {news ? `${news.count} items` : '—'} · links out to original publishers
            </div>
          </div>
          {newsErr && (
            <div style={{ fontSize: fontSize[12], color: color.negative, marginBottom: space[6] }}>⚠ news error: {newsErr} — nothing faked</div>
          )}
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            {(news?.newsRows ?? []).map((n0) => (
              <div key={n0.id ?? n0.title} style={{ padding: '7px 2px', borderBottom: `1px solid ${color.border}` }}>
                <div style={{ display: 'flex', gap: space[8], alignItems: 'baseline' }}>
                  <span style={{
                    fontSize: fontSize[9], fontWeight: fontWeight.bold, textTransform: 'uppercase', letterSpacing: letterSpacing.sm,
                    color: n0.status === 'bullish' ? color.positive : n0.status === 'bearish' ? color.negative : color.textMuted,
                    minWidth: 46,
                  }}>
                    {n0.status ?? '—'}
                  </span>
                  <a
                    href={n0.url ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: color.text, fontSize: fontSize[12], textDecoration: 'none', flex: 1 }}
                  >
                    {n0.title}{n0.url ? ' ↗' : ''}
                  </a>
                </div>
                <div style={{ fontSize: fontSize[10], color: color.textMuted, marginLeft: 54, marginTop: 2 }}>
                  {n0.source ?? '—'} · {n0.date ? shortDate(n0.date) : '—'}
                  {n0.readingMinutes != null ? ` · ${n0.readingMinutes.toFixed(1)} min` : ''}
                  {n0.relatedCoins.length
                    ? ` · ${n0.relatedCoins.slice(0, 3).map((c) => `${c.symbol} ${money(c.priceUsd)}`).join(' · ')}`
                    : ''}
                </div>
              </div>
            ))}
            {!news && !newsErr && (
              <div style={{ padding: space[10], color: color.textMuted, fontSize: fontSize[12] }}>loading…</div>
            )}
            {news && (news.newsRows ?? []).length === 0 && (
              <div style={{ padding: space[10], color: color.textMuted, fontSize: fontSize[12] }}>upstream shipped no rows — nothing faked</div>
            )}
          </div>
          <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: space[4] }}>{news?.slice ?? ''}</div>
        </div>
      </div>

      {/* -------------------------- fundraising ----------------------------- */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: space[10], marginTop: space[16] }}>
        <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: space[12] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[6] }}>
            <div style={{ color: color.text, fontWeight: fontWeight.bold, fontSize: fontSize[13] }}>Recent funding rounds</div>
            <div style={{ fontSize: fontSize[10], color: color.textMuted }}>{home?.fundingRounds?.length ?? '—'} · homepage slice</div>
          </div>
          <Table>
            <TBody>
              {(home?.fundingRounds ?? []).map((f, i) => (
                <TR key={`${f.coinKey}-${f.date}-${i}`}>
                  <td style={{ padding: `${space[6]}px ${space[4]}px`, color: color.textMuted, whiteSpace: 'nowrap' }}>{shortDate(f.date)}</td>
                  <td style={{ padding: `${space[6]}px ${space[4]}px` }}>
                    <div style={{ color: color.text }}>{f.coinName ?? '—'}</div>
                    <div style={{ fontSize: fontSize[10], color: color.textMuted }}>{f.funds.slice(0, 3).join(', ') || '—'}</div>
                  </td>
                  <td style={{ padding: `${space[6]}px ${space[4]}px`, color: color.accent, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {f.type ?? '—'}
                  </td>
                  <td style={{ padding: `${space[6]}px ${space[4]}px`, color: color.text, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {moneyCompact(f.raiseUsd)}
                  </td>
                </TR>
              ))}
              {!home && !homeErr && (
                <tr><td style={{ padding: space[10], color: color.textMuted }}>loading…</td></tr>
              )}
              {home && (home.fundingRounds ?? []).length === 0 && (
                <tr><td style={{ padding: space[10], color: color.textMuted }}>upstream shipped no rows — nothing faked</td></tr>
              )}
            </TBody>
          </Table>
        </div>

        <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: space[12] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[6] }}>
            <div style={{ color: color.text, fontWeight: fontWeight.bold, fontSize: fontSize[13] }}>Upcoming IDO / IEO</div>
            <div style={{ fontSize: fontSize[10], color: color.textMuted }}>{home?.upcomingIco?.length ?? '—'} · homepage slice</div>
          </div>
          <Table>
            <TBody>
              {(home?.upcomingIco ?? []).map((ic, i) => (
                <TR key={`${ic.key}-${i}`}>
                  <td style={{ padding: `${space[6]}px ${space[4]}px`, color: color.textMuted, whiteSpace: 'nowrap' }}>{shortDate(ic.date)}</td>
                  <td style={{ padding: `${space[6]}px ${space[4]}px` }}>
                    <span style={{ color: color.text }}>{ic.name ?? '—'}</span>
                    <span style={{ color: color.textMuted, marginLeft: space[6], fontSize: fontSize[11] }}>{ic.symbol ?? ''}</span>
                    <div style={{ fontSize: fontSize[10], color: color.textMuted }}>{ic.platform ?? '—'}</div>
                  </td>
                  <td style={{ padding: `${space[6]}px ${space[4]}px`, color: color.text, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {moneyCompact(ic.raiseUsd)}
                  </td>
                </TR>
              ))}
              {!home && !homeErr && (
                <tr><td style={{ padding: space[10], color: color.textMuted }}>loading…</td></tr>
              )}
              {home && (home.upcomingIco ?? []).length === 0 && (
                <tr><td style={{ padding: space[10], color: color.textMuted }}>upstream shipped no rows — nothing faked</td></tr>
              )}
            </TBody>
          </Table>
        </div>

        {/* launchpool events (past / upcoming — 3-gate verified 2026-09-27) */}
        <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: space[12] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[6], gap: space[8], flexWrap: 'wrap' }}>
            <div style={{ color: color.text, fontWeight: fontWeight.bold, fontSize: fontSize[13] }}>
              Launchpool{lpKey === 'upcoming' ? ' (upcoming)' : lpKey === 'active' ? ' (active now)' : ' (past)'}
            </div>
            <div style={{ display: 'flex', gap: space[4] }}>
              {([['past', 'Past'], ['active', 'Active'], ['upcoming', 'Upcoming']] as const).map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => setLpKey(k)}
                  style={{
                    fontSize: fontSize[10], padding: '3px 8px', borderRadius: radius[6], cursor: 'pointer',
                    border: `1px solid ${lpKey === k ? color.accent : color.border}`,
                    background: lpKey === k ? color.accent : 'transparent',
                    color: lpKey === k ? color.bg : color.textMuted,
                    fontWeight: lpKey === k ? fontWeight.bold : fontWeight.regular,
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
            <div style={{ fontSize: fontSize[10], color: color.textMuted }}>
              {lp ? (lp.upstreamTotal != null ? `${lp.count} of ${lp.upstreamTotal}` : `${lp.count}`) : '—'} events
            </div>
          </div>
          {lpErr && (
            <div style={{ fontSize: fontSize[12], color: color.negative, marginBottom: space[6] }}>⚠ launchpool error: {lpErr} — nothing faked</div>
          )}
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            <Table>
              <THead>
                <tr style={{ color: color.textMuted, textAlign: 'left', fontSize: fontSize[11], textTransform: 'uppercase', letterSpacing: letterSpacing.xs }}>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Project</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Launchpad</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Window</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Raise</TH>
                </tr>
              </THead>
              <TBody>
                {!lp && !lpErr && (
                  <tr><TD colSpan={4} style={{ padding: space[10], color: color.textMuted }}>loading…</TD></tr>
                )}
                {(lp?.launchpoolRows ?? []).map((r0) => (
                  <TR key={r0.key}>
                    <td style={{ padding: '5px 6px' }}>
                      <span style={{ color: color.text }}>{r0.name}</span>
                      <span style={{ color: color.textMuted, marginLeft: space[6], fontSize: fontSize[10] }}>{r0.symbol}</span>
                      {r0.category && <div style={{ fontSize: fontSize[10], color: color.textMuted }}>{r0.category}</div>}
                    </td>
                    <td style={{ padding: '5px 6px', color: color.textMuted }}>{r0.launchpads.join(', ') || '—'}</td>
                    <td style={{ padding: '5px 6px', color: color.text, whiteSpace: 'nowrap' }}>
                      {r0.when ? shortDate(r0.when) : '—'}{r0.when || r0.till ? ` → ${r0.till ? shortDate(r0.till) : '—'}` : ''}
                    </td>
                    <td style={{ padding: '5px 6px', color: color.text, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {moneyCompact(r0.totalRaiseUsd)}
                    </td>
                  </TR>
                ))}
                {lp && (lp.launchpoolRows ?? []).length === 0 && (
                  <tr><TD colSpan={4} style={{ padding: space[10], color: color.textMuted }}>upstream shipped no rows — nothing faked</TD></tr>
                )}
              </TBody>
            </Table>
          </div>
          <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: space[4] }}>
            {lp?.slice ?? ''}
          </div>
        </div>

        {/* node sales (past / active / upcoming — gated 2026-09-27) */}
        <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: space[12] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[6], gap: space[8], flexWrap: 'wrap' }}>
            <div style={{ color: color.text, fontWeight: fontWeight.bold, fontSize: fontSize[13] }}>
              Nodesale{ndKey === 'upcoming' ? ' (upcoming)' : ndKey === 'active' ? ' (active)' : ' (past)'}
            </div>
            <div style={{ display: 'flex', gap: space[4] }}>
              {([['past', 'Past'], ['active', 'Active'], ['upcoming', 'Upcoming']] as const).map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => setNdKey(k)}
                  style={{
                    fontSize: fontSize[10], padding: '3px 8px', borderRadius: radius[6], cursor: 'pointer',
                    border: `1px solid ${ndKey === k ? color.accent : color.border}`,
                    background: ndKey === k ? color.accent : 'transparent',
                    color: ndKey === k ? color.bg : color.textMuted,
                    fontWeight: ndKey === k ? fontWeight.bold : fontWeight.regular,
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
            <div style={{ fontSize: fontSize[10], color: color.textMuted }}>
              {nd ? (nd.upstreamTotal != null ? `${nd.count} of ${nd.upstreamTotal}` : `${nd.count}`) : '—'} nodesales
            </div>
          </div>
          {ndErr && (
            <div style={{ fontSize: fontSize[12], color: color.negative, marginBottom: space[6] }}>⚠ nodesale error: {ndErr} — nothing faked</div>
          )}
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            <Table>
              <THead>
                <tr style={{ color: color.textMuted, textAlign: 'left', fontSize: fontSize[11], textTransform: 'uppercase', letterSpacing: letterSpacing.xs }}>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Project</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Window</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Node price</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Raised</TH>
                </tr>
              </THead>
              <TBody>
                {!nd && !ndErr && (
                  <tr><TD colSpan={4} style={{ padding: space[10], color: color.textMuted }}>loading…</TD></tr>
                )}
                {(nd?.nodesaleRows ?? []).map((r0) => (
                  <TR key={r0.key}>
                    <td style={{ padding: '5px 6px' }}>
                      <span style={{ color: color.text }}>{r0.name}</span>
                      <span style={{ color: color.textMuted, marginLeft: space[6], fontSize: fontSize[10] }}>{r0.symbol}</span>
                      {r0.category && <div style={{ fontSize: fontSize[10], color: color.textMuted }}>{r0.category}</div>}
                    </td>
                    <td style={{ padding: '5px 6px', color: color.text, whiteSpace: 'nowrap' }}>
                      {r0.when ? shortDate(r0.when) : '—'}{r0.when || r0.till ? ` → ${r0.till ? shortDate(r0.till) : '—'}` : ''}
                    </td>
                    <td style={{ padding: '5px 6px', color: color.text, whiteSpace: 'nowrap' }}>
                      {r0.nodePriceFromUsd != null && r0.nodePriceToUsd != null
                        ? `${moneyCompact(r0.nodePriceFromUsd)} → ${moneyCompact(r0.nodePriceToUsd)}`
                        : '—'}
                    </td>
                    <td style={{ padding: '5px 6px', color: color.text, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {moneyCompact(r0.raiseUsd)}
                      {r0.totalRaiseUsd != null && (
                        <div style={{ fontSize: fontSize[10], color: color.textMuted }}>cap {moneyCompact(r0.totalRaiseUsd)}</div>
                      )}
                    </td>
                  </TR>
                ))}
                {nd && (nd.nodesaleRows ?? []).length === 0 && (
                  <tr><TD colSpan={4} style={{ padding: space[10], color: color.textMuted }}>upstream shipped no rows — nothing faked</TD></tr>
                )}
              </TBody>
            </Table>
          </div>
          <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: space[4] }}>
            {nd?.slice ?? ''}
          </div>
        </div>

        {/* ecosystems (index selector + keyed detail) */}
        <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: space[12] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[6], gap: space[8], flexWrap: 'wrap' }}>
            <div style={{ color: color.text, fontWeight: fontWeight.bold, fontSize: fontSize[13] }}>
              Ecosystem{eco?.ecosystem ? `: ${eco.ecosystem.name}` : ''}
            </div>
            <select
              value={ecoSlug}
              onChange={(e) => setEcoSlug(e.target.value)}
              style={{ fontSize: fontSize[11], padding: '3px 6px', borderRadius: radius[6], maxWidth: 190,
                       background: color.bg, color: color.text, border: `1px solid ${color.border}` }}
            >
              {(ecoIdx?.ecosystemRows ?? []).map((er) => (
                <option key={er.key} value={er.key}>{er.name}</option>
              ))}
            </select>
            <div style={{ fontSize: fontSize[10], color: color.textMuted }}>
              {eco ? (eco.upstreamTotal != null ? `${eco.count} of ${eco.upstreamTotal} coins` : `${eco.count} coins`) : '—'}
            </div>
          </div>
          {ecoErr && (
            <div style={{ fontSize: fontSize[12], color: color.negative, marginBottom: space[6] }}>⚠ ecosystem error: {ecoErr} — nothing faked</div>
          )}
          <div style={{ fontSize: fontSize[11], color: color.textMuted, marginBottom: space[6] }}>
            {eco?.ecosystem
              ? [
                  eco.ecosystem.blockchain ? `chain: ${eco.ecosystem.blockchain.name}` : null,
                  eco.ecosystem.coin
                    ? `native: ${eco.ecosystem.coin.symbol} ${moneyCompact(eco.ecosystem.coin.priceUsd)}${
                        eco.ecosystem.coin.change24h != null
                          ? ` (${eco.ecosystem.coin.change24h >= 0 ? '+' : ''}${eco.ecosystem.coin.change24h.toFixed(2)}%)`
                          : ''}`
                    : null,
                  (() => {
                    const er = (ecoIdx?.ecosystemRows ?? []).find((x) => x.key === ecoSlug);
                    if (!er) return null;
                    const bits: string[] = [];
                    if (er.marketCapUsd != null) bits.push(`mcap ${moneyCompact(er.marketCapUsd)}`);
                    if (er.tvlUsd != null) bits.push(`tvl ${moneyCompact(er.tvlUsd)}`);
                    if (er.projects != null) bits.push(`${er.projects} projects`);
                    return bits.length ? bits.join(' · ') : null;
                  })(),
                ]
                  .filter(Boolean)
                  .join(' · ') || 'loading…'
              : 'loading…'}
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            <Table>
              <THead>
                <tr style={{ color: color.textMuted, textAlign: 'left', fontSize: fontSize[11], textTransform: 'uppercase', letterSpacing: letterSpacing.xs }}>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Project</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Symbol</TH>
                </tr>
              </THead>
              <TBody>
                {!eco && !ecoErr && (
                  <tr><TD colSpan={2} style={{ padding: space[10], color: color.textMuted }}>loading…</TD></tr>
                )}
                {((eco?.rows ?? []) as CrCoin[]).map((c0) => (
                  <TR key={c0.key}>
                    <td style={{ padding: '5px 6px', color: color.text }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        {c0.image && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={c0.image} alt="" width={16} height={16} style={{ borderRadius: radius.circle }} />
                        )}
                        {c0.name}
                      </div>
                    </td>
                    <td style={{ padding: '5px 6px', color: color.textMuted }}>{c0.symbol ?? '—'}</td>
                  </TR>
                ))}
                {eco && (eco.rows ?? []).length === 0 && (
                  <tr><TD colSpan={2} style={{ padding: space[10], color: color.textMuted }}>upstream shipped no coins — nothing faked</TD></tr>
                )}
              </TBody>
            </Table>
          </div>
          <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: space[4] }}>{eco?.slice ?? ''}</div>
        </div>

        {/* RWA assets (index + keyed type/slug detail) */}
        <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: space[12] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[6], gap: space[8], flexWrap: 'wrap' }}>
            <div style={{ color: color.text, fontWeight: fontWeight.bold, fontSize: fontSize[13] }}>
              RWA{rwaDet?.rwaAsset ? `: ${rwaDet.rwaAsset.name}` : ''}
            </div>
            <select
              value={rwaKey}
              onChange={(e) => setRwaKey(e.target.value)}
              style={{ fontSize: fontSize[11], padding: '3px 6px', borderRadius: radius[6], maxWidth: 210,
                       background: color.bg, color: color.text, border: `1px solid ${color.border}` }}
            >
              {(rwa?.rwaRows ?? []).map((rr) => (
                <option key={rr.detailKey} value={rr.detailKey}>{rr.ticker} — {rr.name}</option>
              ))}
            </select>
            <div style={{ fontSize: fontSize[10], color: color.textMuted }}>
              {rwa ? (rwa.upstreamTotal != null ? `${rwa.count} of ${rwa.upstreamTotal}` : `${rwa.count}`) : '—'} assets
            </div>
          </div>
          {rwaErr && (
            <div style={{ fontSize: fontSize[12], color: color.negative, marginBottom: space[6] }}>⚠ rwa error: {rwaErr} — nothing faked</div>
          )}
          {rwaDet?.rwaAsset && (
            <div style={{ fontSize: fontSize[11], color: color.textMuted, marginBottom: space[6] }}>
              {moneyCompact(rwaDet.rwaAsset.priceUsd)}
              {rwaDet.rwaAsset.change24h != null && (
                <span style={{ color: rwaDet.rwaAsset.change24h >= 0 ? color.positive : color.negative }}>
                  {' '}({rwaDet.rwaAsset.change24h >= 0 ? '+' : ''}{(rwaDet.rwaAsset.change24h * 100).toFixed(2)}%)
                </span>
              )}
              {' · '}{rwaDet.rwaAsset.type}
              {rwaDet.rwaAsset.exchange ? ` · ${rwaDet.rwaAsset.exchange}` : ''}
              {rwaDet.rwaAsset.sector ? ` · ${rwaDet.rwaAsset.sector}` : ''}
              {rwaDet.rwaAsset.country ? ` · ${rwaDet.rwaAsset.country}` : ''}
              {rwaDet.rwaAsset.quoteUpdatedAt ? ` · quote ${rwaDet.rwaAsset.quoteUpdatedAt.slice(0, 16).replace('T', ' ')} UTC` : ''}
              {rwaDet.rwaAsset.website && (
                <>
                  {' · '}
                  <a href={rwaDet.rwaAsset.website} target="_blank" rel="noreferrer" style={{ color: color.accent }}>
                    site ↗
                  </a>
                </>
              )}
            </div>
          )}
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            <Table>
              <THead>
                <tr style={{ color: color.textMuted, textAlign: 'left', fontSize: fontSize[11], textTransform: 'uppercase', letterSpacing: letterSpacing.xs }}>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>#</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Asset</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Type</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Price</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>24h</TH>
                </tr>
              </THead>
              <TBody>
                {!rwa && !rwaErr && (
                  <tr><TD colSpan={5} style={{ padding: space[10], color: color.textMuted }}>loading…</TD></tr>
                )}
                {(rwa?.rwaRows ?? []).map((rr) => (
                  <tr
                    key={rr.detailKey}
                    onClick={() => setRwaKey(rr.detailKey)}
                    style={{ borderBottom: `1px solid ${color.border}`, cursor: 'pointer',
                             background: rwaKey === rr.detailKey ? alpha(color.textInverse, 0.05) : 'transparent' }}
                  >
                    <td style={{ padding: '5px 6px', color: color.textMuted, width: 26 }}>{rr.rank ?? '—'}</td>
                    <td style={{ padding: '5px 6px' }}>
                      <span style={{ color: color.text }}>{rr.name}</span>
                      <span style={{ color: color.textMuted, marginLeft: space[6], fontSize: fontSize[10] }}>{rr.ticker}</span>
                    </td>
                    <td style={{ padding: '5px 6px', color: color.textMuted, fontSize: fontSize[11] }}>{rr.type ?? '—'}</td>
                    <td style={{ padding: '5px 6px', color: color.text, whiteSpace: 'nowrap' }}>{moneyCompact(rr.priceUsd)}</td>
                    <td style={{ padding: '5px 6px', whiteSpace: 'nowrap',
                                 color: rr.change24h == null ? color.textMuted : rr.change24h >= 0 ? color.positive : color.negative }}>
                      {rr.change24h != null ? `${rr.change24h >= 0 ? '+' : ''}${(rr.change24h * 100).toFixed(2)}%` : '—'}
                    </td>
                  </tr>
                ))}
                {rwa && (rwa.rwaRows ?? []).length === 0 && (
                  <tr><TD colSpan={5} style={{ padding: space[10], color: color.textMuted }}>upstream shipped no rows — nothing faked</TD></tr>
                )}
              </TBody>
            </Table>
          </div>
          <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: space[4] }}>{rwa?.slice ?? ''}</div>
        </div>

        {/* quarterly returns (BTC/ETH toggle; % computed from upstream O/C) */}
        <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: space[12] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[6], gap: space[8], flexWrap: 'wrap' }}>
            <div style={{ color: color.text, fontWeight: fontWeight.bold, fontSize: fontSize[13] }}>
              Quarterly returns ({qtrSide.toUpperCase()})
            </div>
            <div style={{ display: 'flex', gap: space[4] }}>
              {([['btc', 'BTC'], ['eth', 'ETH']] as const).map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => setQtrSide(k)}
                  style={{
                    fontSize: fontSize[10], padding: '3px 8px', borderRadius: radius[6], cursor: 'pointer',
                    border: `1px solid ${qtrSide === k ? color.accent : color.border}`,
                    background: qtrSide === k ? color.accent : 'transparent',
                    color: qtrSide === k ? color.bg : color.textMuted,
                    fontWeight: qtrSide === k ? fontWeight.bold : fontWeight.regular,
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
            <div style={{ fontSize: fontSize[10], color: color.textMuted }}>
              {qtr ? `${(qtrSide === 'btc' ? qtr.quarterlyBtc : qtr.quarterlyEth)?.length ?? 0} years` : '—'}
            </div>
          </div>
          {qtrErr && (
            <div style={{ fontSize: fontSize[12], color: color.negative, marginBottom: space[6] }}>⚠ quarterly error: {qtrErr} — nothing faked</div>
          )}
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            <Table>
              <THead>
                <tr style={{ color: color.textMuted, textAlign: 'left', fontSize: fontSize[11], textTransform: 'uppercase', letterSpacing: letterSpacing.xs }}>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Year</TH>
                  {['Q1', 'Q2', 'Q3', 'Q4'].map((q) => (
                    <TH key={q} style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold, textAlign: 'right' }}>{q}</TH>
                  ))}
                </tr>
              </THead>
              <TBody>
                {!qtr && !qtrErr && (
                  <tr><TD colSpan={5} style={{ padding: space[10], color: color.textMuted }}>loading…</TD></tr>
                )}
                {((qtrSide === 'btc' ? qtr?.quarterlyBtc : qtr?.quarterlyEth) ?? []).map((y) => (
                  <TR key={y.year ?? Math.random()}>
                    <td style={{ padding: '5px 6px', color: color.text }}>{y.year ?? '—'}</td>
                    {(['q1', 'q2', 'q3', 'q4'] as const).map((qk) => {
                      const q = y[qk];
                      const v = q && q.openUsd != null && q.closeUsd != null && q.openUsd !== 0
                        ? ((q.closeUsd - q.openUsd) / q.openUsd) * 100
                        : null;
                      return (
                        <td key={qk} style={{
                          padding: '5px 6px', textAlign: 'right', whiteSpace: 'nowrap',
                          color: v == null ? color.textMuted : v >= 0 ? color.positive : color.negative,
                        }}>
                          {v == null ? '—' : `${q && !q.isFull ? '~' : ''}${v >= 0 ? '+' : ''}${v.toFixed(1)}%`}
                        </td>
                      );
                    })}
                  </TR>
                ))}
                {qtr && ((qtrSide === 'btc' ? qtr.quarterlyBtc : qtr.quarterlyEth) ?? []).length === 0 && (
                  <tr><TD colSpan={5} style={{ padding: space[10], color: color.textMuted }}>upstream shipped no rows — nothing faked</TD></tr>
                )}
              </TBody>
            </Table>
          </div>
          <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: space[4] }}>{qtr?.slice ?? ''}</div>
        </div>

        {/* prediction markets (aggregates + markets table) */}
        <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: space[12] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[6], gap: space[8], flexWrap: 'wrap' }}>
            <div style={{ color: color.text, fontWeight: fontWeight.bold, fontSize: fontSize[13] }}>Prediction markets</div>
            <div style={{ fontSize: fontSize[10], color: color.textMuted }}>
              {pred ? `${pred.count} of ${pred.upstreamTotal ?? '—'} markets` : '—'}
            </div>
          </div>
          {predErr && (
            <div style={{ fontSize: fontSize[12], color: color.negative, marginBottom: space[6] }}>⚠ prediction error: {predErr} — nothing faked</div>
          )}
          {pred?.prediction && (
            <div style={{ display: 'flex', gap: space[16], flexWrap: 'wrap', fontSize: fontSize[11], color: color.textMuted, marginBottom: space[8] }}>
              <div>
                volume <span style={{ color: color.text }}>{moneyCompact(pred.prediction.totalVolumeUsd)}</span>
                {pred.prediction.volumeChangePct != null && (
                  <span style={{ color: pred.prediction.volumeChangePct >= 0 ? color.positive : color.negative }}>
                    {' '}({pred.prediction.volumeChangePct >= 0 ? '+' : ''}{pred.prediction.volumeChangePct.toFixed(1)}%)
                  </span>
                )}
              </div>
              <div>
                markets <span style={{ color: color.text }}>{pred.prediction.marketsCount ?? '—'}</span>
                {pred.prediction.marketsChangePct != null && (
                  <span style={{ color: pred.prediction.marketsChangePct >= 0 ? color.positive : color.negative }}>
                    {' '}({pred.prediction.marketsChangePct >= 0 ? '+' : ''}{pred.prediction.marketsChangePct.toFixed(1)}%)
                  </span>
                )}
              </div>
              <div>
                OI <span style={{ color: color.text }}>{moneyCompact(pred.prediction.openInterestUsd)}</span>
                {pred.prediction.oiChangePct != null && (
                  <span style={{ color: pred.prediction.oiChangePct >= 0 ? color.positive : color.negative }}>
                    {' '}({pred.prediction.oiChangePct >= 0 ? '+' : ''}{pred.prediction.oiChangePct.toFixed(1)}%)
                  </span>
                )}
              </div>
              <div>
                {pred.prediction.platforms
                  .map((p) => `${p.platform}: ${moneyCompact(p.volumeUsd ?? p.openInterestUsd)}`)
                  .join(' · ')}
              </div>
            </div>
          )}
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            <Table>
              <THead>
                <tr style={{ color: color.textMuted, textAlign: 'left', fontSize: fontSize[11], textTransform: 'uppercase', letterSpacing: letterSpacing.xs }}>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Market</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Platform</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>24h vol</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Bid/Ask</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}></TH>
                </tr>
              </THead>
              <TBody>
                {!pred && !predErr && (
                  <tr><TD colSpan={5} style={{ padding: space[10], color: color.textMuted }}>loading…</TD></tr>
                )}
                {(pred?.predictionRows ?? []).map((m) => (
                  <TR key={m.id}>
                    <td style={{ padding: '5px 6px' }}>
                      <span style={{ color: color.text }}>{m.title}</span>
                      {m.category && <div style={{ fontSize: fontSize[10], color: color.textMuted }}>{m.category}{m.endDate ? ` · ends ${m.endDate}` : ''}</div>}
                    </td>
                    <td style={{ padding: '5px 6px', color: color.textMuted }}>{m.platform ?? '—'}</td>
                    <td style={{ padding: '5px 6px', color: color.text, whiteSpace: 'nowrap' }}>{moneyCompact(m.volume24hUsd)}</td>
                    <td style={{ padding: '5px 6px', color: color.textMuted, whiteSpace: 'nowrap' }}>
                      {m.bid != null ? m.bid.toFixed(2) : '—'} / {m.ask != null ? m.ask.toFixed(2) : '—'}
                    </td>
                    <td style={{ padding: '5px 6px' }}>
                      {m.externalUrl && (
                        <a href={m.externalUrl} target="_blank" rel="noreferrer" style={{ color: color.accent, fontSize: fontSize[11] }}>↗</a>
                      )}
                    </td>
                  </TR>
                ))}
                {pred && (pred.predictionRows ?? []).length === 0 && (
                  <tr><TD colSpan={5} style={{ padding: space[10], color: color.textMuted }}>upstream shipped no rows — nothing faked</TD></tr>
                )}
              </TBody>
            </Table>
          </div>
          <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: space[4] }}>{pred?.slice ?? ''}</div>
        </div>

        {/* ---------------- full price list (converter payload) ------------- */}
        <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: space[12] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[6], gap: space[8], flexWrap: 'wrap' }}>
            <div style={{ color: color.text, fontWeight: fontWeight.bold, fontSize: fontSize[13] }}>Full price list</div>
            <div style={{ fontSize: fontSize[10], color: color.textMuted }}>{conv ? `${conv.count} coins` : '—'} · price only (no 24h change upstream)</div>
          </div>
          {convErr && (
            <div style={{ fontSize: fontSize[12], color: color.negative, marginBottom: space[6] }}>⚠ price list error: {convErr} — nothing faked</div>
          )}
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            <Table>
              <THead>
                <tr style={{ color: color.textMuted, textAlign: 'left', fontSize: fontSize[11], textTransform: 'uppercase', letterSpacing: letterSpacing.xs }}>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Coin</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold }}>Symbol</TH>
                  <TH style={{ padding: `${space[6]}px ${space[6]}px`, borderBottom: `1px solid ${color.border}`, fontWeight: fontWeight.semibold, textAlign: 'right' }}>Price</TH>
                </tr>
              </THead>
              <TBody>
                {!conv && !convErr && (
                  <tr><TD colSpan={3} style={{ padding: space[10], color: color.textMuted }}>loading…</TD></tr>
                )}
                {(conv?.converterRows ?? []).slice(0, 50).map((r0) => (
                  <TR key={r0.key}>
                    <td style={{ padding: '5px 6px', color: color.text }}>{r0.name}</td>
                    <td style={{ padding: '5px 6px', color: color.textMuted }}>{r0.symbol}</td>
                    <td style={{ padding: '5px 6px', color: color.text, textAlign: 'right', whiteSpace: 'nowrap' }}>{money(r0.priceUsd)}</td>
                  </TR>
                ))}
                {conv && (conv.converterRows ?? []).length === 0 && (
                  <tr><TD colSpan={3} style={{ padding: space[10], color: color.textMuted }}>upstream shipped no rows — nothing faked</TD></tr>
                )}
              </TBody>
            </Table>
          </div>
          <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: space[4] }}>
            {conv ? `first 50 of ${conv.count} · ${conv.slice ?? ''}` : ''}
          </div>
        </div>

        {/* ---------------- media feed (YouTube-backed) --------------------- */}
        <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: space[12] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[6], gap: space[8], flexWrap: 'wrap' }}>
            <div style={{ color: color.text, fontWeight: fontWeight.bold, fontSize: fontSize[13] }}>Media feed</div>
            <div style={{ fontSize: fontSize[10], color: color.textMuted }}>
              {media ? `${media.count} of ${media.upstreamTotal ?? '—'} videos` : '—'} · ids ground-truthed via YouTube oembed
            </div>
          </div>
          {mediaErr && (
            <div style={{ fontSize: fontSize[12], color: color.negative, marginBottom: space[6] }}>⚠ media error: {mediaErr} — nothing faked</div>
          )}
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {(media?.mediaRows ?? []).map((m) => (
              <div key={m.id} style={{ padding: '7px 2px', borderBottom: `1px solid ${color.border}` }}>
                <a
                  href={m.id ? `https://www.youtube.com/watch?v=${m.id}` : undefined}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: color.text, fontSize: fontSize[12], textDecoration: 'none' }}
                >
                  {m.title}{m.id ? ' ↗' : ''}
                </a>
                <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: 2 }}>
                  {m.channelTitle ?? '—'} · {shortDate(m.publishedAt)}
                  {m.durationSeconds != null
                    ? ` · ${Math.floor(m.durationSeconds / 60)}:${String(m.durationSeconds % 60).padStart(2, '0')}`
                    : ''}
                </div>
              </div>
            ))}
            {!media && !mediaErr && (
              <div style={{ padding: space[10], color: color.textMuted, fontSize: fontSize[12] }}>loading…</div>
            )}
            {media && (media.mediaRows ?? []).length === 0 && (
              <div style={{ padding: space[10], color: color.textMuted, fontSize: fontSize[12] }}>upstream shipped no rows — nothing faked</div>
            )}
          </div>
          <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: space[4] }}>{media?.slice ?? ''}</div>
        </div>

        {/* ---------------- tagged news (news/tag feed) --------------------- */}
        <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: space[12] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[6], gap: space[8], flexWrap: 'wrap' }}>
            <div style={{ color: color.text, fontWeight: fontWeight.bold, fontSize: fontSize[13] }}>
              Tagged news{ntag?.tag ? `: ${ntag.tag.name}` : ''}
            </div>
            <div style={{ fontSize: fontSize[10], color: color.textMuted }}>{ntag ? `${ntag.count} items` : '—'} · unknown tag → 404 (never unfiltered)</div>
          </div>
          {(ntag?.relatedTags ?? []).length > 0 && (
            <div style={{ display: 'flex', gap: space[6], flexWrap: 'wrap', marginBottom: space[8] }}>
              {(ntag?.relatedTags ?? []).slice(0, 12).map((t) => (
                <button
                  key={t.slug}
                  onClick={() => setNtagSlug(t.slug)}
                  style={{
                    border: `1px solid ${ntagSlug === t.slug ? color.accent : color.border}`,
                    borderRadius: radius.full, background: color.surface, color: ntagSlug === t.slug ? color.text : color.textMuted,
                    fontSize: fontSize[10], padding: '3px 9px', cursor: 'pointer',
                  }}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}
          {ntagErr && (
            <div style={{ fontSize: fontSize[12], color: color.negative, marginBottom: space[6] }}>⚠ tagged news error: {ntagErr} — nothing faked</div>
          )}
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {(ntag?.newsRows ?? []).map((n0) => (
              <div key={n0.id ?? n0.title} style={{ padding: '7px 2px', borderBottom: `1px solid ${color.border}` }}>
                <a
                  href={n0.url ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: color.text, fontSize: fontSize[12], textDecoration: 'none' }}
                >
                  {n0.title}{n0.url ? ' ↗' : ''}
                </a>
                <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: 2 }}>
                  {n0.source ?? '—'} · {n0.date ? shortDate(n0.date) : '—'}
                  {n0.relatedCoins.length
                    ? ` · ${n0.relatedCoins.slice(0, 3).map((c) => `${c.symbol} ${money(c.priceUsd)}`).join(' · ')}`
                    : ''}
                </div>
              </div>
            ))}
            {!ntag && !ntagErr && (
              <div style={{ padding: space[10], color: color.textMuted, fontSize: fontSize[12] }}>loading…</div>
            )}
            {ntag && (ntag.newsRows ?? []).length === 0 && (
              <div style={{ padding: space[10], color: color.textMuted, fontSize: fontSize[12] }}>upstream shipped no rows — nothing faked</div>
            )}
          </div>
          <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: space[4] }}>{ntag?.slice ?? ''}</div>
        </div>

        {/* ---------------- AI market overview (upstream digest) ------------- */}
        <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: space[12] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space[6], gap: space[8], flexWrap: 'wrap' }}>
            <div style={{ color: color.text, fontWeight: fontWeight.bold, fontSize: fontSize[13] }}>AI market overview</div>
            <div style={{ fontSize: fontSize[10], color: color.textMuted }}>upstream AI-generated text (their words) · coherence vs home gated in harness</div>
          </div>
          {aiOvErr && (
            <div style={{ fontSize: fontSize[12], color: color.negative, marginBottom: space[6] }}>⚠ ai overview error: {aiOvErr} — nothing faked</div>
          )}
          {!aiOv && !aiOvErr && (
            <div style={{ padding: space[10], color: color.textMuted, fontSize: fontSize[12] }}>loading…</div>
          )}
          {aiOv?.aiOverview && (
            <div style={{ display: 'grid', gap: space[8] }}>
              {aiOv.aiOverview.market.summary && (
                <div style={{ fontSize: fontSize[12], color: color.text, lineHeight: lineHeight.relaxed }}>
                  {aiOv.aiOverview.market.summary}
                  <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: 2 }}>updated {stamp(Date.parse(aiOv.aiOverview.market.updatedAt ?? '') / 1000 || null)}</div>
                </div>
              )}
              {aiOv.aiOverview.news.length > 0 && (
                <div>
                  <div style={{ fontSize: fontSize[10], color: color.textMuted, textTransform: 'uppercase', letterSpacing: letterSpacing.sm, marginBottom: space[4] }}>Top stories (upstream picks)</div>
                  {aiOv.aiOverview.news.map((n0) => (
                    <div key={n0.id ?? n0.title} style={{ fontSize: fontSize[12], color: color.text, padding: '3px 0', borderBottom: `1px solid ${color.border}` }}>
                      <span style={{ color: n0.isBullish === true ? color.positive : n0.isBullish === false ? color.negative : color.textMuted, fontSize: fontSize[10], marginRight: space[6] }}>
                        {n0.isBullish === null ? '—' : n0.isBullish ? 'bullish' : 'bearish'}
                      </span>
                      {n0.title}
                      <span style={{ color: color.textMuted, fontSize: fontSize[10] }}> · {shortDate(n0.date)}</span>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: space[8] }}>
                {aiOv.aiOverview.funding.summary && (
                  <div>
                    <div style={{ fontSize: fontSize[10], color: color.textMuted, textTransform: 'uppercase', letterSpacing: letterSpacing.sm }}>Funding</div>
                    <div style={{ fontSize: fontSize[11], color: color.text }}>{aiOv.aiOverview.funding.summary}</div>
                    {aiOv.aiOverview.funding.rounds.map((r0) => (
                      <div key={r0.key ?? r0.name} style={{ fontSize: fontSize[11], color: color.textMuted, paddingTop: 2 }}>
                        {r0.name}{r0.stage ? ` · ${r0.stage}` : ''}{r0.raisedUsd != null ? ` · ${moneyCompact(r0.raisedUsd)}` : ''}
                      </div>
                    ))}
                  </div>
                )}
                {aiOv.aiOverview.dropHunting.summary && (
                  <div>
                    <div style={{ fontSize: fontSize[10], color: color.textMuted, textTransform: 'uppercase', letterSpacing: letterSpacing.sm }}>Drop hunting</div>
                    <div style={{ fontSize: fontSize[11], color: color.text }}>{aiOv.aiOverview.dropHunting.summary}</div>
                    {aiOv.aiOverview.dropHunting.activities.map((a) => (
                      <div key={a.key} style={{ fontSize: fontSize[11], color: color.textMuted, paddingTop: 2 }}>
                        {a.coinName ?? a.key}{a.type ? ` · ${a.type}` : ''}
                      </div>
                    ))}
                  </div>
                )}
                {aiOv.aiOverview.vesting.summary && (
                  <div>
                    <div style={{ fontSize: fontSize[10], color: color.textMuted, textTransform: 'uppercase', letterSpacing: letterSpacing.sm }}>Vesting</div>
                    <div style={{ fontSize: fontSize[11], color: color.text }}>{aiOv.aiOverview.vesting.summary}</div>
                    {aiOv.aiOverview.vesting.unlocks.map((u, i) => (
                      <div key={`${u.coinName ?? 'x'}-${i}`} style={{ fontSize: fontSize[11], color: color.textMuted, paddingTop: 2 }}>
                        {u.coinName ?? '—'}{u.date ? ` · ${u.date.slice(0, 10)}` : ''}{u.unlockPercent != null ? ` · ${u.unlockPercent.toFixed(2)}%` : ''}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: space[4] }}>{aiOv?.slice ?? ''}</div>
        </div>
      </div>

      <div style={{ fontSize: fontSize[10], color: color.textMuted, marginTop: space[8] }}>
        {home?.slice ?? ''} — funding rounds + IDO rows come from the homepage slice only (6 + 6, partial by
        design and press-verified: CoinGlass/CoinMarketCap 2026-09-25 matches the GlobeNewswire release);
        Launchpool rows are full event lists (past 50 of 527 / all upcoming) with windows verified against
        KuCoin's official GemPool dates (gno-land 2026-09-16 → 09-26). The /funding-rounds and /token-unlock HTML paths answer a Cloudflare interstitial to every
        client tried, and their Next.js data routes serve SYNTHETIC decoy (nonexistent slugs return 200
        fabricated payloads; measured 2026-09-27) — those modes are refused by the API with a 503, never
        rendered. Contract + decoy detector: scripts/verify/verify-cryptorank.py.
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
    <div style={{ border: `1px solid ${color.border}`, borderRadius: radius[10], background: color.surface, padding: `${space[10]}px ${space[12]}px` }}>
      <div style={{ fontSize: fontSize[10], color: color.textMuted, textTransform: 'uppercase', letterSpacing: letterSpacing.sm }}>{label}</div>
      <div style={{ fontSize: fontSize[16], fontWeight: fontWeight.bold, color: color.text, marginTop: 3 }}>{value}</div>
      <div style={{ fontSize: fontSize[11], color: subColor, marginTop: 1 }}>{sub || ' '}</div>
    </div>
  );
}

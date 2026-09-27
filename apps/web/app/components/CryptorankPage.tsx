'use client';

import { useCallback, useEffect, useState } from 'react';
import { C } from '../../lib/ui/shared';
import {
  CR_BASE,
  type CrCoin,
  type CrEnvelope,
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

async function loadMode(mode: CrMode, fresh = false): Promise<CrEnvelope> {
  const res = await fetch(`/api/cryptorank?mode=${mode}${fresh ? '&fresh=1' : ''}`, { cache: 'no-store' });
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

  useEffect(() => {
    void fetchHome();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      </div>

      <div style={{ fontSize: 10, color: C.dim, marginTop: 8 }}>
        {home?.slice ?? ''} — fundraising rows above come from the homepage slice only (6 rounds + 6 IDOs,
        partial by design and press-verified: CoinGlass/CoinMarketCap 2026-09-25 matches the GlobeNewswire
        release). The /funding-rounds and /token-unlock HTML paths answer a Cloudflare interstitial to every
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

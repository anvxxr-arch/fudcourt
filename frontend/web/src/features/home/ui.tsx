'use client';
import Link from 'next/link';
import { color, fontFamily, fontSize, fontWeight, letterSpacing, lineHeight, radius, space } from '@/styles/tokens';
import { Badge } from '@/ui/badge';
import { Banner } from '@/ui/banner';
import { Loading } from '@/ui/feedback';
import { Meter } from '@/ui/meter';
import { Stat } from '@/ui/stat';
import { imgSrc } from '@/lib/img';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';
import {
  COMMODITY_URL,
  CR_HOME_URL,
  DASH,
  DEFI_PROTOCOLS_URL,
  GAINERS_URL,
  LOSERS_URL,
  MARKETS_TOP_URL,
  NEWS_URL,
  STOCK_US_URL,
  TOP_LIMIT,
  TRENDING_URL,
  fmtDate,
  fmtGas,
  fmtNum,
  fmtPct,
  fmtPrice,
  fmtUsdCompact,
  toneOf,
  type CrHome,
  type CrTrending,
  type LlamaProtocols,
  type MarketsEnvelope,
  type NewsEnvelope,
} from './client';
import {
  cardStyle,
  h2Style,
  h3Style,
  noteStyle,
  listRowStyle,
  theadRowStyle,
  rowStyle,
  useJson,
  Panel,
  Change,
  CoinCell,
} from './ui-shared';
import { MoversColumn, FxColumn, QuoteColumn } from './ui-panels';
import { MacroBoard, IndonesiaBoard, SignalQuality, ProofStrip } from './ui-boards';
export {
  cardStyle,
  h2Style,
  h3Style,
  h4Style,
  summaryStyle,
  noteStyle,
  listRowStyle,
  theadRowStyle,
  rowStyle,
  useJson,
  Panel,
  Change,
  CoinCell,
} from './ui-shared';
export { MoversColumn, FxColumn, QuoteColumn } from './ui-panels';
export { Bp, PolicyRateTable, IndicatorTable, WorldTable, MacroBoard, IndonesiaBoard, SignalQuality, ProofStrip } from './ui-boards';
import { DestinationsSection } from './ui-destinations';
export { DESTINATIONS, type Destination } from './ui-destinations';

/**
 * The landing page (`/`).
 *
 * Read-only: it composes the public families the boards already serve and links
 * into the routed surfaces. It is NOT a second shell — the nav lives in
 * `features/overview/store-shell.tsx`; this page only answers "what is FUDCOURT,
 * and what is the market doing right now".
 *
 * Every section is an independent fetch. A family that fails renders a loud
 * banner and WITHHOLDS its body (never a zero-filled grid), and it does not take
 * its siblings down with it: a CryptoRank outage leaves the DeFi, cross-asset
 * and news panels intact. Every absent metric renders `—`, never `0`.
 */
// ---- the page ---------------------------------------------------------------

export default function HomePage({ isTeam = false }: { isTeam?: boolean }) {
  const cr = useJson<CrHome>(CR_HOME_URL);
  const g = cr.data?.global;
  const live = !!cr.data;

  return (
    <div style={{ background: color.bgBase, minHeight: '100vh', color: color.labelPrimary, fontFamily: fontFamily.mono, padding: space[20] }}>
      <main style={{ maxWidth: 1080, margin: '0 auto' }}>
        {/* ---- hero ---------------------------------------------------------- */}
        <header style={{ borderBottom: `1px solid ${color.separator}`, paddingBottom: space[20], marginBottom: space[20] }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: space[12], flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0, color: color.blue, fontSize: fontSize[28], fontWeight: fontWeight.bold, letterSpacing: letterSpacing.wider }}>
              Crypto market boards you can trust {'—'} every figure verified live
            </h1>
            <Badge variant={live ? 'accent' : 'muted'}>{live ? 'live' : cr.loading ? 'connecting' : 'offline'}</Badge>
          </div>
          <p style={{ margin: `${space[8]}px 0 0`, color: color.labelTertiary, fontSize: fontSize[13], letterSpacing: letterSpacing.wide }}>
            Community · Terminal · Management
          </p>
          <p style={{ margin: `${space[8]}px 0 0`, color: color.labelPrimary, fontSize: fontSize[15], lineHeight: lineHeight.normal, maxWidth: 720 }}>
            FUDCOURT cross-checks every figure against a second source before it ships. Missing data shows as{' '}
            <span style={{ color: color.labelTertiary }}>{DASH}</span>, never <span style={{ color: color.labelTertiary }}>0</span>.
          </p>
          <div style={{ display: 'flex', gap: space[8], flexWrap: 'wrap', marginTop: space[16] }}>
            <Link
              href="/market"
              style={{ background: color.blue, color: color.labelOnAccent, borderRadius: radius[8], padding: `${space[8]}px ${space[16]}px`, fontSize: fontSize[12], fontWeight: fontWeight.bold, textDecoration: 'none' }}
            >
              Open the market hub →
            </Link>
            <Link
              href={isTeam ? '/team/balance' : '/login'}
              style={{ color: color.blue, fontSize: fontSize[12], fontWeight: fontWeight.bold, textDecoration: 'none', alignSelf: 'center' }}
            >
              {isTeam ? 'Treasury terminal →' : 'Sign in →'}
            </Link>
          </div>
          <ul style={{ display: 'flex', gap: space[16], flexWrap: 'wrap', listStyle: 'none', margin: `${space[16]}px 0 0`, padding: 0, color: color.labelTertiary, fontSize: fontSize[11] }}>
            <li>Dual-source parity on every board</li>
            <li>Known-decoy classes rejected, not hidden</li>
            <li>Free to browse {'—'} sign-in only for private terminals</li>
          </ul>
          <ProofStrip />
        </header>

        {/* ---- 1. global market header --------------------------------------- */}
        <section style={{ marginBottom: space[24] }}>
          <h2 style={h2Style}>Market overview</h2>
          {cr.error && (
            <Banner variant="error">
              market overview unavailable — {cr.error}. The tiles are withheld rather than shown as zeroes.
            </Banner>
          )}
          {cr.loading && !cr.error && <Loading label="loading live figures…" />}
          {g && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: space[8] }}>
                <Stat label="Total market cap" value={fmtUsdCompact(g.totalMarketCap)} hint={fmtPct(g.totalMarketCapChangePercent)} tone={toneOf(g.totalMarketCapChangePercent)} valueSize={fontSize[20]} />
                <Stat label="24h volume" value={fmtUsdCompact(g.totalVolume24h)} hint={fmtPct(g.totalVolume24hChangePercent)} tone={toneOf(g.totalVolume24hChangePercent)} valueSize={fontSize[20]} />
                <Stat label="BTC dominance" value={g.btcDominance == null ? DASH : `${g.btcDominance.toFixed(2)}%`} hint={fmtPct(g.btcDominanceChangePercent)} tone={toneOf(g.btcDominanceChangePercent)} valueSize={fontSize[20]} />
                <Stat label="ETH dominance" value={g.ethDominance == null ? DASH : `${g.ethDominance.toFixed(2)}%`} hint={fmtPct(g.ethDominanceChangePercent)} tone={toneOf(g.ethDominanceChangePercent)} valueSize={fontSize[20]} />
                <Stat label="Gas" value={fmtGas(g.gasGwei)} valueSize={fontSize[20]} />
                <Stat label="Currencies tracked" value={fmtNum(g.allCurrencies)} valueSize={fontSize[20]} />
              </div>
              <p style={noteStyle}>
                source {cr.data?.upstream} · read {cr.data ? new Date(cr.data.fetchedAt * 1000).toISOString().replace('T', ' ').slice(0, 16) : DASH}Z · cache {cr.data?.cache}
              </p>
            </>
          )}
        </section>

        {/* ---- 2. top coins -------------------------------------------------- */}
        <Panel<MarketsEnvelope>
          title={`Top ${TOP_LIMIT} by market cap`}
          url={MARKETS_TOP_URL}
          label="loading live figures…"
          render={d => (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
                {d.coins.slice(0, 5).map(c => (
                  <div key={c.symbol} style={listRowStyle}>
                    <CoinCell image={c.image} symbol={c.symbol} name={c.name} />
                    <span style={{ color: color.labelPrimary, whiteSpace: 'nowrap' }}>{fmtPrice(c.lastPrice)}</span>
                    <Change v={c.priceChangePercent} />
                    <span style={{ color: color.labelPrimary, whiteSpace: 'nowrap' }}>{fmtUsdCompact(c.marketCap)}</span>
                  </div>
                ))}
              </div>
              <p style={noteStyle}>
                {d.derived} · pool {d.pool} · {d.upstream} ·{' '}
                <Link href="/market" style={{ color: color.blue }}>full board →</Link>
              </p>
            </>
          )}
        />

        {/* ---- 3. trending --------------------------------------------------- */}
        <Panel<CrTrending>
          title="Trending now"
          url={TRENDING_URL}
          render={d => (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
                {d.rows.slice(0, 6).map(r => (
                  <div key={`${r.key ?? r.symbol ?? 'row'}`} style={listRowStyle}>
                    <CoinCell image={r.image} symbol={r.symbol} name={r.name} />
                    <span style={{ color: color.labelPrimary, whiteSpace: 'nowrap' }}>{fmtPrice(r.priceUsd)}</span>
                    <Change v={r.change24h} />
                    <span style={{ color: color.labelPrimary, whiteSpace: 'nowrap' }}>{fmtUsdCompact(r.volume24hUsd)}</span>
                  </div>
                ))}
              </div>
              <p style={noteStyle}>
                {d.changeSource} change source · rows the venue publishes without a price render {DASH} · {d.upstream} ·{' '}
                <Link href="/market" style={{ color: color.blue }}>full board →</Link>
              </p>
            </>
          )}
        />

        {/* ---- 4. gainers / losers ------------------------------------------- */}
        <section style={{ marginBottom: space[24] }}>
          <h2 style={h2Style}>24h movers</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: space[12] }}>
            <MoversColumn title="Top gainers" url={GAINERS_URL} />
            <MoversColumn title="Top losers" url={LOSERS_URL} />
          </div>
        </section>

        {/* ---- 5. DeFi TVL --------------------------------------------------- */}
        <Panel<LlamaProtocols>
          title="Top DeFi protocols by TVL"
          url={DEFI_PROTOCOLS_URL}
          render={d => (
            <>
              <Meter
                parts={d.rows.slice(0, 6).map(p => ({ label: p.name, value: Math.abs(p.tvl ?? 0) }))}
                style={{ marginBottom: space[12] }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
                {d.rows.slice(0, 6).map(p => (
                  <div key={p.slug} style={listRowStyle}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: space[8], minWidth: 0 }}>
                      {p.logo
                        ? <img src={imgSrc(p.logo)} alt="" style={{ width: space[16], height: space[16], borderRadius: radius.circle }} />
                        : null}
                      <span style={{ color: color.labelPrimary, fontWeight: fontWeight.bold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                    </span>
                    <span style={{ color: color.labelPrimary, whiteSpace: 'nowrap' }}>{fmtUsdCompact(p.tvl)}</span>
                    <Change v={p.change_1d} />
                  </div>
                ))}
              </div>
              <p style={noteStyle}>
                {d.derived} · {d.upstream} ·{' '}
                <Link href="/market" style={{ color: color.blue }}>full board →</Link>
              </p>
            </>
          )}
        />

        {/* ---- 6. beyond crypto ---------------------------------------------- */}
        <section style={{ marginBottom: space[24] }}>
          <h2 style={h2Style}>Beyond crypto</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: space[12] }}>
            <FxColumn />
            <QuoteColumn title="Commodities" url={COMMODITY_URL} />
            <QuoteColumn title="US indices" url={STOCK_US_URL} />
          </div>
        </section>

        {/* ---- 6b. global macro: rates, dollar, volatility, policy, indicators -- */}
        <section style={{ marginBottom: space[24] }}>
          <h2 style={h2Style}>Global macro</h2>
          <MacroBoard />
        </section>

        {/* ---- 6c. Indonesia macro: rupiah, IDX, BI-Rate, structure ----------- */}
        <section style={{ marginBottom: space[24] }}>
          <h2 style={h2Style}>Indonesia macro</h2>
          <IndonesiaBoard />
        </section>

        {/* ---- 7. research slices -------------------------------------------- */}
        {cr.data && (cr.data.fundingRounds.length > 0 || cr.data.upcomingIco.length > 0) && (
          <section style={{ marginBottom: space[24] }}>
            <h2 style={h2Style}>Primary market</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: space[12] }}>
              <div style={cardStyle}>
                <h3 style={h3Style}>Recent funding</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
                  {cr.data.fundingRounds.slice(0, 6).map((r, i) => (
                    <div key={`${r.coinKey || 'unnamed'}-${i}`} style={listRowStyle}>
                      <span style={{ color: color.labelPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.coinName || DASH}
                        {r.type ? <span style={{ color: color.labelTertiary }}> · {r.type}</span> : null}
                      </span>
                      <span style={{ color: color.blue, whiteSpace: 'nowrap' }}>{fmtUsdCompact(r.raiseUsd)}</span>
                      <span style={{ color: color.labelTertiary, whiteSpace: 'nowrap' }}>{fmtDate(r.date)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={cardStyle}>
                <h3 style={h3Style}>Upcoming launches</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
                  {cr.data.upcomingIco.slice(0, 6).map((r, i) => (
                    <div key={`${r.key || 'unnamed'}-${i}`} style={listRowStyle}>
                      <span style={{ color: color.labelPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.name || DASH}
                        {r.symbol ? <span style={{ color: color.labelTertiary }}> · {r.symbol}</span> : null}
                      </span>
                      <span style={{ color: color.blue, whiteSpace: 'nowrap' }}>{fmtUsdCompact(r.raiseUsd)}</span>
                      <span style={{ color: color.labelTertiary, whiteSpace: 'nowrap' }}>{fmtDate(r.date)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>
        )}

        {/* ---- 8. news ------------------------------------------------------- */}
        <Panel<NewsEnvelope>
          title="Latest news"
          url={NEWS_URL}
          render={d => (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
                {d.items.slice(0, 6).map(it => (
                  <Link key={it.link} href="/news" style={{ ...cardStyle, padding: space[12], textDecoration: 'none', display: 'block' }}>
                    <div style={{ color: color.labelPrimary, fontSize: fontSize[13], fontWeight: fontWeight.bold, lineHeight: lineHeight.normal }}>{it.title}</div>
                    <div style={{ color: color.labelTertiary, fontSize: fontSize[11], marginTop: space[8] }}>
                      {it.source || DASH} · {fmtDate(it.pubDate)}
                    </div>
                  </Link>
                ))}
              </div>
              <p style={noteStyle}>{d.total} in the feed · {d.upstream}</p>
            </>
          )}
        />

        {/* ---- 9. signal quality --------------------------------------------- */}
        <SignalQuality />

        {/* ---- 10. destinations ---------------------------------------------- */}
        <DestinationsSection />

        <footer style={{ borderTop: `1px solid ${color.separator}`, marginTop: space[24], paddingTop: space[12] }}>
          <p style={{ margin: 0, color: color.labelTertiary, fontSize: fontSize[11], lineHeight: lineHeight.normal }}>
            Read-only market data, no investment advice. Treasury and admin surfaces require a session.
          </p>
        </footer>
      </main>
    </div>
  );
}

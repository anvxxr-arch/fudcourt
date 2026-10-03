'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { alpha, color, fontFamily, fontSize, fontWeight, letterSpacing, lineHeight, radius, space } from '@/styles/tokens';
import { Badge } from '@/components/ui/badge';
import { Banner } from '@/components/ui/banner';
import { Loading } from '@/components/ui/feedback';
import { Stat } from '@/components/ui/stat';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import {
  CR_HOME_URL,
  DASH,
  MARKETS_TOP_URL,
  TOP_LIMIT,
  fmtDate,
  fmtGas,
  fmtNum,
  fmtPct,
  fmtPrice,
  fmtUsdCompact,
  toneOf,
  type CrHome,
  type MarketsEnvelope,
} from './client';

/**
 * The landing page (`/`).
 *
 * Read-only: it composes the two public families the boards already serve
 * (`mode=home` + `/api/markets`) and links into the routed surfaces. It is NOT
 * a second shell — the nav lives in `components/layout/store-shell.tsx`; this
 * page only answers "what is FUDCOURT, and what is the market doing right now".
 *
 * Honesty rules it inherits from the boards: a failed fetch with nothing cached
 * renders a loud banner and WITHHOLDS the section (never a zero-filled grid),
 * and every absent metric renders `—`.
 */

const DESTINATIONS: { href: string; label: string; blurb: string }[] = [
  {
    href: '/market',
    label: 'Market',
    blurb: 'Cross-checked CEX instruments, on-chain DEX pairs, and per-asset-class sections: crypto, forex, commodity and stock.',
  },
  {
    href: '/signals',
    label: 'Signals',
    blurb: 'Read-only screening output over a 168h window. Not trading signals, not financial advice.',
  },
  {
    href: '/scoreboard',
    label: 'Scoreboard',
    blurb: 'Tracked traders and wallets ranked by realized performance.',
  },
  {
    href: '/news',
    label: 'News',
    blurb: 'Crypto market news aggregated for treasury and trading decisions.',
  },
  {
    href: '/blog',
    label: 'Blog',
    blurb: 'Research, playbooks and insights, published through the Payload CMS.',
  },
];

const cardStyle: React.CSSProperties = {
  background: color.surface,
  border: `1px solid ${color.border}`,
  borderRadius: radius[8],
  padding: space[14],
};

export default function HomePage({ isTeam = false }: { isTeam?: boolean }) {
  const [cr, setCr] = useState<CrHome | null>(null);
  const [mk, setMk] = useState<MarketsEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [crError, setCrError] = useState('');
  const [mkError, setMkError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setCrError('');
    setMkError('');
    const [crRes, mkRes] = await Promise.allSettled([
      fetch(CR_HOME_URL, { cache: 'no-store' }),
      fetch(MARKETS_TOP_URL, { cache: 'no-store' }),
    ]);

    // The market header is the page's spine: if it fails the hero is withheld.
    if (crRes.status === 'fulfilled' && crRes.value.ok) {
      setCr(await crRes.value.json());
    } else {
      setCr(null);
      setCrError(
        crRes.status === 'fulfilled'
          ? `cryptorank HTTP ${crRes.value.status}`
          : String(crRes.reason)
      );
    }

    // The top-coins board is a second, independent family: it degrades on its
    // own so a CryptoRank outage does not blank the coin list, and vice versa.
    if (mkRes.status === 'fulfilled' && mkRes.value.ok) {
      setMk(await mkRes.value.json());
    } else {
      setMk(null);
      setMkError(
        mkRes.status === 'fulfilled'
          ? `markets HTTP ${mkRes.value.status}`
          : String(mkRes.reason)
      );
    }

    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const g = cr?.global;

  return (
    <div style={{ background: color.bg, minHeight: '100vh', color: color.text, fontFamily: fontFamily.mono, padding: space[20] }}>
      <main style={{ maxWidth: 1080, margin: '0 auto' }}>
        {/* ---- hero ---------------------------------------------------------- */}
        <header style={{ borderBottom: `1px solid ${color.border}`, paddingBottom: space[20], marginBottom: space[20] }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: space[12], flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0, color: color.accent, fontSize: fontSize[32], fontWeight: fontWeight.heavy, letterSpacing: letterSpacing.wider }}>
              FUDCOURT
            </h1>
            <Badge variant={cr ? 'accent' : 'muted'}>{cr ? 'live' : loading ? 'connecting' : 'offline'}</Badge>
          </div>
          <p style={{ margin: `${space[8]}px 0 0`, color: color.textMuted, fontSize: fontSize[13], letterSpacing: letterSpacing.wide }}>
            Community · Terminal · Management
          </p>
          <p style={{ margin: `${space[10]}px 0 0`, color: color.text, fontSize: fontSize[14], lineHeight: lineHeight.normal, maxWidth: 720 }}>
            Verified market intelligence boards for everyone, a cross-chain treasury terminal for the team,
            and an admin control panel for management. Every figure below is read live through the same
            proxies the boards use — a metric the upstream did not publish renders{' '}
            <span style={{ color: color.textMuted }}>{DASH}</span>, never <span style={{ color: color.textMuted }}>0</span>.
          </p>
          <div style={{ display: 'flex', gap: space[10], flexWrap: 'wrap', marginTop: space[16] }}>
            <Link
              href="/market"
              style={{ background: color.accent, color: color.textOnAccent, borderRadius: radius[6], padding: `${space[8]}px ${space[18]}px`, fontSize: fontSize[12], fontWeight: fontWeight.bold, textDecoration: 'none' }}
            >
              Open the market hub →
            </Link>
            <Link
              href={isTeam ? '/team/balance' : '/login'}
              style={{ background: color.surface, color: color.text, border: `1px solid ${color.border}`, borderRadius: radius[6], padding: `${space[8]}px ${space[18]}px`, fontSize: fontSize[12], fontWeight: fontWeight.bold, textDecoration: 'none' }}
            >
              {isTeam ? 'Treasury terminal →' : 'Sign in →'}
            </Link>
          </div>
        </header>

        {/* ---- global market header ------------------------------------------ */}
        <section style={{ marginBottom: space[24] }}>
          <h2 style={{ margin: `0 0 ${space[10]}px`, color: color.accent, fontSize: fontSize[14], fontWeight: fontWeight.bold, letterSpacing: letterSpacing.wide }}>
            Market overview
          </h2>

          {crError && (
            <Banner variant="error">
              market overview unavailable — {crError}. The tiles are withheld rather than shown as zeroes.
            </Banner>
          )}

          {loading && !cr && !crError && <Loading label="reading the market header…" />}

          {g && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: space[10] }}>
                <Stat
                  label="Total market cap"
                  value={fmtUsdCompact(g.totalMarketCap)}
                  hint={fmtPct(g.totalMarketCapChangePercent)}
                  tone={toneOf(g.totalMarketCapChangePercent)}
                  valueSize={fontSize[20]}
                />
                <Stat
                  label="24h volume"
                  value={fmtUsdCompact(g.totalVolume24h)}
                  hint={fmtPct(g.totalVolume24hChangePercent)}
                  tone={toneOf(g.totalVolume24hChangePercent)}
                  valueSize={fontSize[20]}
                />
                <Stat
                  label="BTC dominance"
                  value={g.btcDominance == null ? DASH : `${g.btcDominance.toFixed(2)}%`}
                  hint={fmtPct(g.btcDominanceChangePercent)}
                  tone={toneOf(g.btcDominanceChangePercent)}
                  valueSize={fontSize[20]}
                />
                <Stat
                  label="ETH dominance"
                  value={g.ethDominance == null ? DASH : `${g.ethDominance.toFixed(2)}%`}
                  hint={fmtPct(g.ethDominanceChangePercent)}
                  tone={toneOf(g.ethDominanceChangePercent)}
                  valueSize={fontSize[20]}
                />
                <Stat label="Gas" value={fmtGas(g.gasGwei)} valueSize={fontSize[20]} />
                <Stat label="Currencies tracked" value={fmtNum(g.allCurrencies)} valueSize={fontSize[20]} />
              </div>
              <p style={{ margin: `${space[8]}px 0 0`, color: color.textMuted, fontSize: fontSize[10] }}>
                source {cr?.upstream} · read {cr ? new Date(cr.fetchedAt * 1000).toISOString().replace('T', ' ').slice(0, 16) : DASH}Z · cache {cr?.cache}
              </p>
            </>
          )}
        </section>

        {/* ---- top coins ----------------------------------------------------- */}
        <section style={{ marginBottom: space[24] }}>
          <h2 style={{ margin: `0 0 ${space[10]}px`, color: color.accent, fontSize: fontSize[14], fontWeight: fontWeight.bold, letterSpacing: letterSpacing.wide }}>
            Top {TOP_LIMIT} by market cap
          </h2>

          {mkError && (
            <Banner variant="error">
              top-coins board unavailable — {mkError}. The table is withheld rather than rendered empty.
            </Banner>
          )}

          {loading && !mk && !mkError && <Loading label="reading the top-coins pool…" />}

          {mk && (
            <>
              <div style={{ overflowX: 'auto' }}>
                <Table style={{ fontSize: fontSize[11] }}>
                  <THead>
                    <TR style={{ color: color.textMuted, textAlign: 'left', borderBottom: `1px solid ${color.border}` }}>
                      <TH align="right">#</TH>
                      <TH>Coin</TH>
                      <TH align="right">Price</TH>
                      <TH align="right">24h</TH>
                      <TH align="right">Market cap</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {mk.coins.slice(0, TOP_LIMIT).map(c => (
                      <TR key={c.symbol} style={{ borderBottom: `1px solid ${alpha(color.border, 0.4)}` }}>
                        <TD align="right" style={{ color: color.textMuted }}>{fmtNum(c.rank)}</TD>
                        <TD>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: space[6] }}>
                            {c.image
                              ? <img src={c.image} alt="" style={{ width: space[16], height: space[16], borderRadius: radius.circle }} />
                              : <span style={{ width: space[16], height: space[16], borderRadius: radius.circle, background: color.border, display: 'inline-block' }} />}
                            <span style={{ color: color.text, fontWeight: fontWeight.bold }}>{c.symbol || DASH}</span>
                            <span style={{ color: color.textMuted }}>{c.name || DASH}</span>
                          </span>
                        </TD>
                        <TD align="right" style={{ color: color.text }}>{fmtPrice(c.lastPrice)}</TD>
                        <TD align="right" style={{ color: toneOf(c.priceChangePercent) === 'negative' ? color.negative : toneOf(c.priceChangePercent) === 'positive' ? color.positive : color.textMuted }}>
                          {fmtPct(c.priceChangePercent)}
                        </TD>
                        <TD align="right" style={{ color: color.text }}>{fmtUsdCompact(c.marketCap)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
              <p style={{ margin: `${space[8]}px 0 0`, color: color.textMuted, fontSize: fontSize[10] }}>
                {mk.derived} · pool {mk.pool} · {mk.upstream}
              </p>
            </>
          )}
        </section>

        {/* ---- research slices ----------------------------------------------- */}
        {cr && (cr.fundingRounds.length > 0 || cr.upcomingIco.length > 0) && (
          <section style={{ marginBottom: space[24], display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: space[14] }}>
            <div style={cardStyle}>
              <h3 style={{ margin: `0 0 ${space[10]}px`, color: color.accent, fontSize: fontSize[12], fontWeight: fontWeight.bold, letterSpacing: letterSpacing.wide }}>
                Recent funding
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: space[6] }}>
                {cr.fundingRounds.slice(0, 6).map((r, i) => (
                  <div key={`${r.coinKey || 'unnamed'}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', gap: space[8], fontSize: fontSize[11] }}>
                    <span style={{ color: color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.coinName || DASH}
                      {r.type ? <span style={{ color: color.textMuted }}> · {r.type}</span> : null}
                    </span>
                    <span style={{ color: color.accent, whiteSpace: 'nowrap' }}>{fmtUsdCompact(r.raiseUsd)}</span>
                    <span style={{ color: color.textMuted, whiteSpace: 'nowrap' }}>{fmtDate(r.date)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={cardStyle}>
              <h3 style={{ margin: `0 0 ${space[10]}px`, color: color.accent, fontSize: fontSize[12], fontWeight: fontWeight.bold, letterSpacing: letterSpacing.wide }}>
                Upcoming launches
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: space[6] }}>
                {cr.upcomingIco.slice(0, 6).map((r, i) => (
                  <div key={`${r.key || 'unnamed'}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', gap: space[8], fontSize: fontSize[11] }}>
                    <span style={{ color: color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.name || DASH}
                      {r.symbol ? <span style={{ color: color.textMuted }}> · {r.symbol}</span> : null}
                    </span>
                    <span style={{ color: color.accent, whiteSpace: 'nowrap' }}>{fmtUsdCompact(r.raiseUsd)}</span>
                    <span style={{ color: color.textMuted, whiteSpace: 'nowrap' }}>{fmtDate(r.date)}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* ---- destinations -------------------------------------------------- */}
        <section>
          <h2 style={{ margin: `0 0 ${space[10]}px`, color: color.accent, fontSize: fontSize[14], fontWeight: fontWeight.bold, letterSpacing: letterSpacing.wide }}>
            Boards
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: space[12] }}>
            {DESTINATIONS.map(d => (
              <Link key={d.href} href={d.href} style={{ ...cardStyle, textDecoration: 'none', display: 'block' }}>
                <div style={{ color: color.text, fontSize: fontSize[13], fontWeight: fontWeight.bold }}>{d.label} →</div>
                <div style={{ color: color.textMuted, fontSize: fontSize[11], marginTop: space[6], lineHeight: lineHeight.normal }}>{d.blurb}</div>
              </Link>
            ))}
          </div>
        </section>

        <footer style={{ borderTop: `1px solid ${color.border}`, marginTop: space[24], paddingTop: space[12] }}>
          <p style={{ margin: 0, color: color.textMuted, fontSize: fontSize[10], lineHeight: lineHeight.normal }}>
            Read-only market data, no investment advice. Treasury and admin surfaces require a session.
          </p>
        </footer>
      </main>
    </div>
  );
}

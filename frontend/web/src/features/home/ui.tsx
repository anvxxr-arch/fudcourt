'use client';

import { Fragment, useEffect, useState } from 'react';
import Link from 'next/link';
import { alpha, color, fontFamily, fontSize, fontWeight, letterSpacing, lineHeight, radius, space } from '@/styles/tokens';
import { Badge } from '@/components/ui/badge';
import { Banner } from '@/components/ui/banner';
import { Loading } from '@/components/ui/feedback';
import { Stat } from '@/components/ui/stat';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import {
  COMMODITY_URL,
  CR_HOME_URL,
  DASH,
  DEFI_PROTOCOLS_URL,
  FOREX_URL,
  GAINERS_URL,
  INDONESIA_URL,
  LOSERS_URL,
  MACRO_URL,
  MARKETS_TOP_URL,
  NEWS_URL,
  SCOREBOARD_URL,
  STOCK_US_URL,
  TOP_LIMIT,
  TRENDING_URL,
  fmtBp,
  fmtBpRaw,
  fmtDate,
  fmtEconomy,
  fmtGas,
  fmtIndicator,
  fmtNum,
  fmtPct,
  fmtPolicyRate,
  fmtPrice,
  fmtRate,
  fmtUsdCompact,
  fmtX,
  fmtYear,
  fmtYield,
  toneOf,
  type CrHome,
  type CrMovers,
  type CrTrending,
  type EconomyRow,
  type ForexEnvelope,
  type IndicatorRow,
  type IndonesiaEnvelope,
  type IndonesiaQuote,
  type LlamaProtocols,
  type MacroEnvelope,
  type MarketsEnvelope,
  type NewsEnvelope,
  type PolicyRateRow,
  type QuotesEnvelope,
  type ScoreboardBucket,
  type ScoreboardCatch,
  type ScoreboardPayload,
} from './client';

/**
 * The landing page (`/`).
 *
 * Read-only: it composes the public families the boards already serve and links
 * into the routed surfaces. It is NOT a second shell — the nav lives in
 * `components/layout/store-shell.tsx`; this page only answers "what is FUDCOURT,
 * and what is the market doing right now".
 *
 * Every section is an independent fetch. A family that fails renders a loud
 * banner and WITHHOLDS its body (never a zero-filled grid), and it does not take
 * its siblings down with it: a CryptoRank outage leaves the DeFi, cross-asset
 * and news panels intact. Every absent metric renders `—`, never `0`.
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

// ---- shared styles (token-only; the design gate forbids literals here) ------

const cardStyle: React.CSSProperties = {
  background: color.surface,
  border: `1px solid ${color.border}`,
  borderRadius: radius[8],
  padding: space[14],
};
const h2Style: React.CSSProperties = {
  margin: `0 0 ${space[10]}px`,
  color: color.accent,
  fontSize: fontSize[14],
  fontWeight: fontWeight.bold,
  letterSpacing: letterSpacing.wide,
};
const h3Style: React.CSSProperties = {
  margin: `0 0 ${space[10]}px`,
  color: color.accent,
  fontSize: fontSize[12],
  fontWeight: fontWeight.bold,
  letterSpacing: letterSpacing.wide,
};
const noteStyle: React.CSSProperties = {
  margin: `${space[8]}px 0 0`,
  color: color.textMuted,
  fontSize: fontSize[10],
};
const listRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  gap: space[8],
  fontSize: fontSize[11],
};
const theadRowStyle: React.CSSProperties = {
  color: color.textMuted,
  textAlign: 'left',
  borderBottom: `1px solid ${color.border}`,
};
const rowStyle: React.CSSProperties = { borderBottom: `1px solid ${alpha(color.border, 0.4)}` };

// ---- primitives -------------------------------------------------------------

/** One fetch, one state machine. `alive` guards a setState after unmount. */
function useJson<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    fetch(url, { cache: 'no-store' })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<T>;
      })
      .then(j => { if (alive) { setData(j); setLoading(false); } })
      .catch(e => { if (alive) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { alive = false; };
  }, [url]);
  return { data, error, loading };
}

/** A titled section whose body is withheld on error and never zero-filled. */
function Panel<T>({
  title,
  url,
  label,
  render,
}: {
  title: string;
  url: string;
  label?: string;
  render: (d: T) => React.ReactNode;
}) {
  const { data, error, loading } = useJson<T>(url);
  return (
    <section style={{ marginBottom: space[24] }}>
      <h2 style={h2Style}>{title}</h2>
      {error && (
        <Banner variant="error">
          {title} unavailable — {error}. Section withheld rather than rendered empty.
        </Banner>
      )}
      {loading && !error && <Loading label={label ?? `reading ${title.toLowerCase()}…`} />}
      {!error && data != null && render(data)}
    </section>
  );
}

/** A signed percent, coloured by sign; absent -> `—` in the muted tone. */
function Change({ v, digits = 2 }: { v: number | null | undefined; digits?: number }) {
  const t = toneOf(v);
  const c = t === 'negative' ? color.negative : t === 'positive' ? color.positive : color.textMuted;
  return <span style={{ color: c }}>{fmtPct(v, digits)}</span>;
}

/**
 * Symbol + optional name, with the coin icon (or a neutral disc when absent).
 *
 * A venue sometimes lists a coin with no ticker yet (pre-launch): the symbol is
 * the empty string and every metric is null. The label falls back to the name so
 * the row is identifiable, and the absent metrics stay `—` — the row is not
 * dropped, because "trending, price unpublished" is real information.
 */
function CoinCell({ image, symbol, name }: { image: string | null; symbol: string | null; name?: string | null }) {
  const label = symbol || name || DASH;
  const sub = symbol && name ? name : null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: space[6] }}>
      {image
        ? <img src={image} alt="" style={{ width: space[16], height: space[16], borderRadius: radius.circle }} />
        : <span style={{ width: space[16], height: space[16], borderRadius: radius.circle, background: color.border, display: 'inline-block' }} />}
      <span style={{ color: color.text, fontWeight: fontWeight.bold }}>{label}</span>
      {sub ? <span style={{ color: color.textMuted }}>{sub}</span> : null}
    </span>
  );
}

// ---- sections that need more than a single fetch ----------------------------

/** One column of the gainers/losers pair. */
function MoversColumn({ title, url }: { title: string; url: string }) {
  const { data, error, loading } = useJson<CrMovers>(url);
  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>{title}</h3>
      {error && <Banner variant="error">{error}</Banner>}
      {loading && !error && <Loading label={`reading ${title.toLowerCase()}…`} />}
      {!error && data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[6] }}>
          {data.rows.slice(0, 6).map((r, i) => (
            <div key={`${r.key ?? r.symbol ?? 'row'}-${i}`} style={listRowStyle}>
              <CoinCell image={r.image} symbol={r.symbol} />
              <span style={{ color: color.text, whiteSpace: 'nowrap' }}>{fmtPrice(r.priceUsd)}</span>
              <Change v={r.change24h} />
            </div>
          ))}
        </div>
      )}
      {!error && data && <p style={noteStyle}>{data.changeSource} · {data.upstream}</p>}
    </div>
  );
}

/** FX majors. The upstream carries no change, so none is shown — never a fake 0%. */
function FxColumn() {
  const { data, error, loading } = useJson<ForexEnvelope>(FOREX_URL);
  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>FX majors</h3>
      {error && <Banner variant="error">{error}</Banner>}
      {loading && !error && <Loading label="reading FX majors…" />}
      {!error && data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[6] }}>
          {data.pairs.slice(0, 5).map(p => (
            <div key={p.pair} style={listRowStyle}>
              <span style={{ color: color.text, fontWeight: fontWeight.bold }}>{p.pair}</span>
              <span style={{ color: color.text }}>{fmtRate(p.rate)}</span>
            </div>
          ))}
        </div>
      )}
      {!error && data && <p style={noteStyle}>base {data.base} · {data.derived}</p>}
    </div>
  );
}

/** Commodities or stock indices — the same Yahoo shape, one column each. */
function QuoteColumn({ title, url }: { title: string; url: string }) {
  const { data, error, loading } = useJson<QuotesEnvelope>(url);
  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>{title}</h3>
      {error && <Banner variant="error">{error}</Banner>}
      {loading && !error && <Loading label={`reading ${title.toLowerCase()}…`} />}
      {!error && data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[6] }}>
          {data.quotes.slice(0, 5).map(q => (
            <div key={q.symbol} style={listRowStyle}>
              <span style={{ color: color.text, fontWeight: fontWeight.bold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.name}</span>
              <span style={{ color: color.text, whiteSpace: 'nowrap' }}>{fmtPrice(q.price)}</span>
              <Change v={q.changePercent} />
            </div>
          ))}
        </div>
      )}
      {!error && data && (
        <p style={noteStyle}>
          {data.derived}{data.failed.length > 0 ? ` · failed: ${data.failed.join(', ')}` : ''}
        </p>
      )}
    </div>
  );
}

/** A yield delta rendered in basis points, coloured by sign; absent -> `—`. */
function Bp({ v }: { v: number | null | undefined }) {
  const t = toneOf(v);
  const c = t === 'negative' ? color.negative : t === 'positive' ? color.positive : color.textMuted;
  return <span style={{ color: c }}>{fmtBp(v)}</span>;
}

/** Region order the policy-rate table renders in — curated, not alphabetical. */
const POLICY_REGIONS = ['Americas', 'Europe', 'Asia-Pacific', 'Africa & Middle East'];

/** Shared style for a table's group-divider row. */
const groupRowStyle: React.CSSProperties = {
  color: color.accent,
  fontWeight: fontWeight.bold,
  fontSize: fontSize[10],
  letterSpacing: letterSpacing.wider,
  paddingTop: space[10],
};

/**
 * Central-bank policy rates (BIS).
 *
 * Grouped by region so a 33-row table stays scannable, and every row carries the
 * observation date — a policy rate is a step function, so "3.875%" is meaningless
 * without knowing when it was last set. An area BIS did not return stays `—`.
 */
function PolicyRateTable({ rows }: { rows: PolicyRateRow[] }) {
  const regions = POLICY_REGIONS.filter(r => rows.some(x => x.region === r));
  return (
    <div style={{ overflowX: 'auto', marginTop: space[12] }}>
      <Table style={{ fontSize: fontSize[11] }}>
        <THead>
          <TR style={theadRowStyle}>
            <TH>Central bank</TH>
            <TH align="right">Policy rate</TH>
            <TH align="right">As of</TH>
          </TR>
        </THead>
        <TBody>
          {regions.map(region => (
            <Fragment key={region}>
              <TR>
                <TD colSpan={3} style={groupRowStyle}>{region.toUpperCase()}</TD>
              </TR>
              {rows.filter(r => r.region === region).map(r => (
                <TR key={r.area} style={rowStyle}>
                  <TD style={{ color: color.text, fontWeight: fontWeight.bold }}>
                    <span title={r.note}>{r.bank}</span>
                  </TD>
                  <TD align="right" style={{ color: color.text }}>{fmtPolicyRate(r.rate)}</TD>
                  <TD align="right" style={{ color: color.textMuted }}>{r.date || DASH}</TD>
                </TR>
              ))}
            </Fragment>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

/**
 * US macro indicators (FRED).
 *
 * `value` arrives already transformed — a level, a year-over-year percent, or a
 * period change — together with the `unit` that names which, so this prints it
 * verbatim beside its observation date. Grouped by theme; nothing is recomputed.
 */
function IndicatorTable({ rows }: { rows: IndicatorRow[] }) {
  const groups = Array.from(new Set(rows.map(r => r.group)));
  return (
    <div style={{ overflowX: 'auto', marginTop: space[12] }}>
      <Table style={{ fontSize: fontSize[11] }}>
        <THead>
          <TR style={theadRowStyle}>
            <TH>US indicator</TH>
            <TH align="right">Value</TH>
            <TH align="right">Observed</TH>
          </TR>
        </THead>
        <TBody>
          {groups.map(group => (
            <Fragment key={group}>
              <TR>
                <TD colSpan={3} style={groupRowStyle}>{group.toUpperCase()}</TD>
              </TR>
              {rows.filter(r => r.group === group).map(r => (
                <TR key={r.id} style={rowStyle}>
                  <TD style={{ color: color.text, fontWeight: fontWeight.bold }}>
                    <span title={r.note}>{r.name}</span>
                  </TD>
                  <TD align="right" style={{ color: color.text }}>{fmtIndicator(r.value, r.unit, r.decimals)}</TD>
                  <TD align="right" style={{ color: color.textMuted }}>{fmtDate(r.date)}</TD>
                </TR>
              ))}
            </Fragment>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

/**
 * Global economy comparison (World Bank, annual).
 *
 * Each cell prints its OWN year: growth and inflation are published on different
 * lags, so a single shared year column would be wrong for at least one of them.
 */
function EconomyTable({ rows }: { rows: EconomyRow[] }) {
  return (
    <div style={{ overflowX: 'auto', marginTop: space[12] }}>
      <Table style={{ fontSize: fontSize[11] }}>
        <THead>
          <TR style={theadRowStyle}>
            <TH>Economy</TH>
            <TH align="right">GDP growth</TH>
            <TH align="right">Inflation</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map(r => (
            <TR key={r.code} style={rowStyle}>
              <TD style={{ color: color.text, fontWeight: fontWeight.bold }}>{r.name}</TD>
              <TD align="right" style={{ color: color.text }}>
                {r.gdpGrowth === null ? DASH : `${r.gdpGrowth.toFixed(2)}%`}{' '}
                <span style={{ color: color.textMuted }}>{fmtYear(r.gdpYear)}</span>
              </TD>
              <TD align="right" style={{ color: color.text }}>
                {r.inflation === null ? DASH : `${r.inflation.toFixed(2)}%`}{' '}
                <span style={{ color: color.textMuted }}>{fmtYear(r.inflationYear)}</span>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

/**
 * Macro — the US Treasury curve, the dollar index and the volatility indices.
 *
 * A yield is quoted in percent and its move is rendered in BASIS POINTS
 * (`Δ × 100`), the convention for a rate; the index rows keep the percent delta.
 * The curve spreads are the route's locally-derived series and are labelled as
 * such. Everything is a read of the macro family; nothing is recomputed here.
 */
function MacroBoard() {
  const { data, error, loading } = useJson<MacroEnvelope>(MACRO_URL);
  const rates = data ? data.quotes.filter(q => q.unit === 'yield') : [];
  const idx = data ? data.quotes.filter(q => q.unit === 'index') : [];
  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>Rates · dollar · volatility</h3>
      {error && <Banner variant="error">{error}</Banner>}
      {loading && !error && <Loading label="reading the macro board…" />}
      {!error && data && (
        <>
          <div style={{ overflowX: 'auto' }}>
            <Table style={{ fontSize: fontSize[11] }}>
              <THead>
                <TR style={theadRowStyle}>
                  <TH>US rates</TH>
                  <TH align="right">Yield</TH>
                  <TH align="right">Δ</TH>
                </TR>
              </THead>
              <TBody>
                {rates.map(q => (
                  <TR key={q.symbol} style={rowStyle}>
                    <TD style={{ color: color.text, fontWeight: fontWeight.bold }}>
                      <span title={q.note}>{q.name}</span>
                    </TD>
                    <TD align="right" style={{ color: color.text }}>{fmtYield(q.price)}</TD>
                    <TD align="right"><Bp v={q.change} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          {data.spreads.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[14], marginTop: space[8] }}>
              {data.spreads.map(s => (
                <span key={s.label} style={{ fontSize: fontSize[11], color: color.textMuted }} title={s.note}>
                  {s.label}{' '}
                  <span style={{ color: color.text, fontWeight: fontWeight.bold }}>{fmtBpRaw(s.bp)}</span>
                </span>
              ))}
            </div>
          )}
          <div style={{ overflowX: 'auto', marginTop: space[12] }}>
            <Table style={{ fontSize: fontSize[11] }}>
              <THead>
                <TR style={theadRowStyle}>
                  <TH>Dollar &amp; volatility</TH>
                  <TH align="right">Level</TH>
                  <TH align="right">Δ</TH>
                </TR>
              </THead>
              <TBody>
                {idx.map(q => (
                  <TR key={q.symbol} style={rowStyle}>
                    <TD style={{ color: color.text, fontWeight: fontWeight.bold }}>
                      <span title={q.note}>{q.name}</span>
                    </TD>
                    <TD align="right" style={{ color: color.text }}>{fmtNum(q.price, 2)}</TD>
                    <TD align="right"><Change v={q.changePercent} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          {data.policyRates.length > 0 && <PolicyRateTable rows={data.policyRates} />}
          {data.indicators.length > 0 && <IndicatorTable rows={data.indicators} />}
          {data.economies.length > 0 && <EconomyTable rows={data.economies} />}
          <p style={noteStyle}>
            yields in %, delta in basis points (Δ × 100) · curve spreads derived locally, not published upstream · {data.derived}
          </p>
          {data.failed.length > 0 && (
            <p style={noteStyle}>
              withheld, not zero-filled: {data.failed.map(f => f.symbol).join(', ')}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** The live half of the Indonesia board: rupiah crosses and IDX indices. */
function IndonesiaLive({ quotes }: { quotes: IndonesiaQuote[] }) {
  const groups = Array.from(new Set(quotes.map(q => q.group)));
  return (
    <div style={{ overflowX: 'auto' }}>
      <Table style={{ fontSize: fontSize[11] }}>
        <THead>
          <TR style={theadRowStyle}>
            <TH>Rupiah &amp; IDX</TH>
            <TH align="right">Level</TH>
            <TH align="right">Δ</TH>
          </TR>
        </THead>
        <TBody>
          {groups.map(g => (
            <Fragment key={g}>
              <TR>
                <TD colSpan={3} style={groupRowStyle}>{g.toUpperCase()}</TD>
              </TR>
              {quotes.filter(q => q.group === g).map(q => (
                <TR key={q.symbol} style={rowStyle}>
                  <TD style={{ color: color.text, fontWeight: fontWeight.bold }}>
                    <span title={q.note}>{q.name}</span>
                  </TD>
                  <TD align="right" style={{ color: color.text }}>{fmtNum(q.price, 2)}</TD>
                  <TD align="right"><Change v={q.changePercent} /></TD>
                </TR>
              ))}
            </Fragment>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

/**
 * Indonesia — the rupiah and IDX (live), the BI-Rate, and the annual structure.
 *
 * Three horizons in one panel, each row labelled with the one it belongs to:
 * quotes are live, the BI-Rate carries its BIS observation date, and every World
 * Bank row prints the year it was published FOR. The annual block is deliberately
 * not folded into the live table — a 2025 GDP figure sitting next to a live FX
 * quote reads as if both were current, which is exactly the lie to avoid.
 */
function IndonesiaBoard() {
  const { data, error, loading } = useJson<IndonesiaEnvelope>(INDONESIA_URL);
  const economyGroups = data ? Array.from(new Set(data.economy.map(e => e.group))) : [];
  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>Rupiah · BI-Rate · economy</h3>
      {error && <Banner variant="error">{error}</Banner>}
      {loading && !error && <Loading label="reading the Indonesia board…" />}
      {!error && data && (
        <>
          {data.quotes.length > 0 && <IndonesiaLive quotes={data.quotes} />}
          <p style={{ ...noteStyle, marginTop: space[12] }} title={data.policy.note}>
            {data.policy.label}{' '}
            <span style={{ color: color.text, fontWeight: fontWeight.bold }}>{fmtPolicyRate(data.policy.rate)}</span>
            {data.policy.date ? <span> · as of {data.policy.date}</span> : null}
          </p>
          {economyGroups.length > 0 && (
            <div style={{ overflowX: 'auto', marginTop: space[12] }}>
              <Table style={{ fontSize: fontSize[11] }}>
                <THead>
                  <TR style={theadRowStyle}>
                    <TH>Indonesia — annual</TH>
                    <TH align="right">Value</TH>
                    <TH align="right">Year</TH>
                  </TR>
                </THead>
                <TBody>
                  {economyGroups.map(g => (
                    <Fragment key={g}>
                      <TR>
                        <TD colSpan={3} style={groupRowStyle}>{g.toUpperCase()}</TD>
                      </TR>
                      {data.economy.filter(e => e.group === g).map(e => (
                        <TR key={e.id} style={rowStyle}>
                          <TD style={{ color: color.text, fontWeight: fontWeight.bold }}>
                            <span title={e.note}>{e.name}</span>
                          </TD>
                          <TD align="right" style={{ color: color.text }}>{fmtEconomy(e.value, e.kind, e.decimals)}</TD>
                          <TD align="right" style={{ color: color.textMuted }}>{fmtYear(e.year)}</TD>
                        </TR>
                      ))}
                    </Fragment>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
          <p style={noteStyle}>
            quotes live · BI-Rate from BIS (daily) · annual rows from the World Bank, each with its own year · {data.derived}
          </p>
          {data.failed.length > 0 && (
            <p style={noteStyle}>withheld, not zero-filled: {data.failed.map(f => f.symbol).join(', ')}</p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Signal quality — the cohort scoreboard. `run`/`flat`/`dump` are the UPSTREAM's
 * outcome buckets over the cohort window, not our verdict on a token, so the
 * panel labels them as such rather than implying the board endorses a call.
 */
function SignalQuality() {
  const { data, error, loading } = useJson<ScoreboardPayload>(SCOREBOARD_URL);
  const entries = data ? Object.entries(data.chains).filter(([, c]) => c.latest) : [];
  const catches: ScoreboardCatch[] = data ? Object.values(data.chains).flatMap(c => c.catches) : [];
  const best = catches.reduce<ScoreboardCatch | null>(
    (a, b) => ((b.x24h ?? -Infinity) > (a?.x24h ?? -Infinity) ? b : a),
    null
  );
  return (
    <section style={{ marginBottom: space[24] }}>
      <h2 style={h2Style}>Signal quality</h2>
      {error && (
        <Banner variant="error">
          signal quality unavailable — {error}. Section withheld rather than rendered empty.
        </Banner>
      )}
      {loading && !error && <Loading label="reading the signal cohort…" />}
      {!error && data && (
        <>
          <div style={{ overflowX: 'auto' }}>
            <Table style={{ fontSize: fontSize[11] }}>
              <THead>
                <TR style={theadRowStyle}>
                  <TH>Chain</TH>
                  <TH>Cohort day</TH>
                  <TH align="right">Tracked</TH>
                  <TH align="right">Ran</TH>
                  <TH align="right">Flat</TH>
                  <TH align="right">Dumped</TH>
                  <TH align="right">Unknown</TH>
                </TR>
              </THead>
              <TBody>
                {entries.map(([chain, c]) => {
                  const b = c.latest as ScoreboardBucket;
                  return (
                    <TR key={chain} style={rowStyle}>
                      <TD style={{ color: color.text, fontWeight: fontWeight.bold }}>{chain}</TD>
                      <TD style={{ color: color.textMuted }}>{b.day}</TD>
                      <TD align="right" style={{ color: color.text }}>{fmtNum(b.n)}</TD>
                      <TD align="right" style={{ color: color.positive }}>{fmtNum(b.run)}</TD>
                      <TD align="right" style={{ color: color.textMuted }}>{fmtNum(b.flat)}</TD>
                      <TD align="right" style={{ color: color.negative }}>{fmtNum(b.dump)}</TD>
                      <TD align="right" style={{ color: color.textMuted }}>{fmtNum(b.unknown)}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
          {best && (
            <p style={noteStyle}>
              best cohort catch:{' '}
              <span style={{ color: color.text, fontWeight: fontWeight.bold }}>{best.symbol || DASH}</span>{' '}
              <span style={{ color: color.accent }}>{fmtX(best.x24h)}</span> peak 24h · score{' '}
              {fmtNum(best.score, 1)} · {best.decision || DASH} · {best.day}
            </p>
          )}
          <p style={noteStyle}>
            {data.cohortDays}-day cohort · run/flat/dump are the upstream&apos;s outcome buckets, not our verdict · {data.upstream}
          </p>
        </>
      )}
    </section>
  );
}

// ---- the page ---------------------------------------------------------------

export default function HomePage({ isTeam = false }: { isTeam?: boolean }) {
  const cr = useJson<CrHome>(CR_HOME_URL);
  const g = cr.data?.global;
  const live = !!cr.data;

  return (
    <div style={{ background: color.bg, minHeight: '100vh', color: color.text, fontFamily: fontFamily.mono, padding: space[20] }}>
      <main style={{ maxWidth: 1080, margin: '0 auto' }}>
        {/* ---- hero ---------------------------------------------------------- */}
        <header style={{ borderBottom: `1px solid ${color.border}`, paddingBottom: space[20], marginBottom: space[20] }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: space[12], flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0, color: color.accent, fontSize: fontSize[32], fontWeight: fontWeight.heavy, letterSpacing: letterSpacing.wider }}>
              FUDCOURT
            </h1>
            <Badge variant={live ? 'accent' : 'muted'}>{live ? 'live' : cr.loading ? 'connecting' : 'offline'}</Badge>
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

        {/* ---- 1. global market header --------------------------------------- */}
        <section style={{ marginBottom: space[24] }}>
          <h2 style={h2Style}>Market overview</h2>
          {cr.error && (
            <Banner variant="error">
              market overview unavailable — {cr.error}. The tiles are withheld rather than shown as zeroes.
            </Banner>
          )}
          {cr.loading && !cr.error && <Loading label="reading the market header…" />}
          {g && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: space[10] }}>
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
          label="reading the top-coins pool…"
          render={d => (
            <>
              <div style={{ overflowX: 'auto' }}>
                <Table style={{ fontSize: fontSize[11] }}>
                  <THead>
                    <TR style={theadRowStyle}>
                      <TH align="right">#</TH>
                      <TH>Coin</TH>
                      <TH align="right">Price</TH>
                      <TH align="right">24h</TH>
                      <TH align="right">Market cap</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {d.coins.slice(0, TOP_LIMIT).map(c => (
                      <TR key={c.symbol} style={rowStyle}>
                        <TD align="right" style={{ color: color.textMuted }}>{fmtNum(c.rank)}</TD>
                        <TD><CoinCell image={c.image} symbol={c.symbol} name={c.name} /></TD>
                        <TD align="right" style={{ color: color.text }}>{fmtPrice(c.lastPrice)}</TD>
                        <TD align="right"><Change v={c.priceChangePercent} /></TD>
                        <TD align="right" style={{ color: color.text }}>{fmtUsdCompact(c.marketCap)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
              <p style={noteStyle}>{d.derived} · pool {d.pool} · {d.upstream}</p>
            </>
          )}
        />

        {/* ---- 3. trending --------------------------------------------------- */}
        <Panel<CrTrending>
          title="Trending now"
          url={TRENDING_URL}
          render={d => (
            <>
              <div style={{ overflowX: 'auto' }}>
                <Table style={{ fontSize: fontSize[11] }}>
                  <THead>
                    <TR style={theadRowStyle}>
                      <TH align="right">#</TH>
                      <TH>Coin</TH>
                      <TH align="right">Price</TH>
                      <TH align="right">24h</TH>
                      <TH align="right">Volume 24h</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {d.rows.slice(0, 8).map(r => (
                      <TR key={`${r.key ?? r.symbol ?? 'row'}`} style={rowStyle}>
                        <TD align="right" style={{ color: color.textMuted }}>{fmtNum(r.rank)}</TD>
                        <TD><CoinCell image={r.image} symbol={r.symbol} name={r.name} /></TD>
                        <TD align="right" style={{ color: color.text }}>{fmtPrice(r.priceUsd)}</TD>
                        <TD align="right"><Change v={r.change24h} /></TD>
                        <TD align="right" style={{ color: color.text }}>{fmtUsdCompact(r.volume24hUsd)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
              <p style={noteStyle}>
                {d.changeSource} change source · rows the venue publishes without a price render {DASH} · {d.upstream}
              </p>
            </>
          )}
        />

        {/* ---- 4. gainers / losers ------------------------------------------- */}
        <section style={{ marginBottom: space[24] }}>
          <h2 style={h2Style}>24h movers</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: space[14] }}>
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
              <div style={{ overflowX: 'auto' }}>
                <Table style={{ fontSize: fontSize[11] }}>
                  <THead>
                    <TR style={theadRowStyle}>
                      <TH align="right">#</TH>
                      <TH>Protocol</TH>
                      <TH>Category</TH>
                      <TH align="right">TVL</TH>
                      <TH align="right">1d</TH>
                      <TH align="right">7d</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {d.rows.slice(0, 8).map((p, i) => (
                      <TR key={p.slug} style={rowStyle}>
                        <TD align="right" style={{ color: color.textMuted }}>{fmtNum(i + 1)}</TD>
                        <TD>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: space[6] }}>
                            {p.logo
                              ? <img src={p.logo} alt="" style={{ width: space[16], height: space[16], borderRadius: radius.circle }} />
                              : null}
                            <span style={{ color: color.text, fontWeight: fontWeight.bold }}>{p.name}</span>
                          </span>
                        </TD>
                        <TD style={{ color: color.textMuted }}>{p.category || DASH}</TD>
                        <TD align="right" style={{ color: color.text }}>{fmtUsdCompact(p.tvl)}</TD>
                        <TD align="right"><Change v={p.change_1d} /></TD>
                        <TD align="right"><Change v={p.change_7d} /></TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
              <p style={noteStyle}>{d.derived} · {d.upstream}</p>
            </>
          )}
        />

        {/* ---- 6. beyond crypto ---------------------------------------------- */}
        <section style={{ marginBottom: space[24] }}>
          <h2 style={h2Style}>Beyond crypto</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: space[14] }}>
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: space[14] }}>
              <div style={cardStyle}>
                <h3 style={h3Style}>Recent funding</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: space[6] }}>
                  {cr.data.fundingRounds.slice(0, 6).map((r, i) => (
                    <div key={`${r.coinKey || 'unnamed'}-${i}`} style={listRowStyle}>
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
                <h3 style={h3Style}>Upcoming launches</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: space[6] }}>
                  {cr.data.upcomingIco.slice(0, 6).map((r, i) => (
                    <div key={`${r.key || 'unnamed'}-${i}`} style={listRowStyle}>
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
            </div>
          </section>
        )}

        {/* ---- 8. news ------------------------------------------------------- */}
        <Panel<NewsEnvelope>
          title="Latest news"
          url={NEWS_URL}
          render={d => (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: space[10] }}>
                {d.items.slice(0, 6).map(it => (
                  <a key={it.link} href={it.link} target="_blank" rel="noreferrer" style={{ ...cardStyle, padding: space[12], textDecoration: 'none', display: 'block' }}>
                    <div style={{ color: color.text, fontSize: fontSize[13], fontWeight: fontWeight.bold, lineHeight: lineHeight.normal }}>{it.title}</div>
                    <div style={{ color: color.textMuted, fontSize: fontSize[10], marginTop: space[6] }}>
                      {it.source || DASH} · {fmtDate(it.pubDate)}
                    </div>
                  </a>
                ))}
              </div>
              <p style={noteStyle}>{d.total} in the feed · {d.upstream}</p>
            </>
          )}
        />

        {/* ---- 9. signal quality --------------------------------------------- */}
        <SignalQuality />

        {/* ---- 10. destinations ---------------------------------------------- */}
        <section>
          <h2 style={h2Style}>Boards</h2>
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

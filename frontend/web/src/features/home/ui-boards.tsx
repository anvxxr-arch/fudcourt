'use client';

import { Fragment } from 'react';
import Link from 'next/link';
import { color, fontSize, fontWeight, letterSpacing, space } from '@/styles/tokens';
import { Banner } from '@/ui/banner';
import { Meter } from '@/ui/meter';
import { Loading } from '@/ui/feedback';
import { TBody, TD, TH, THead, TR, Table } from '@/ui/table';
import {
  CR_HOME_URL,
  DASH,
  INDONESIA_URL,
  MACRO_URL,
  MARKETS_TOP_URL,
  NEWS_URL,
  SCOREBOARD_URL,
  deltaDir,
  fmtBp,
  fmtBpRaw,
  fmtDate,
  fmtDelta,
  fmtEconomy,
  fmtIndicator,
  fmtNum,
  fmtPolicyRate,
  fmtX,
  fmtYear,
  fmtYield,
  toneOf,
  type CrHome,
  type IndicatorRow,
  type IndonesiaEnvelope,
  type IndonesiaQuote,
  type MacroEnvelope,
  type MarketsEnvelope,
  type NewsEnvelope,
  type PolicyRateRow,
  type ScoreboardBucket,
  type ScoreboardCatch,
  type ScoreboardPayload,
  type WorldIndicatorRow,
  type WorldRow,
} from './client';
import { cardStyle, h2Style, h3Style, h4Style, summaryStyle, noteStyle, theadRowStyle, rowStyle, useJson, Change } from './ui-shared';

/** A yield delta rendered in basis points, coloured by sign; absent -> `—`. */
export function Bp({ v }: { v: number | null | undefined }) {
  const t = toneOf(v);
  const c = t === 'negative' ? color.red : t === 'positive' ? color.green : color.labelTertiary;
  return <span style={{ color: c }}>{fmtBp(v)}</span>;
}

/** Region order the policy-rate table renders in — curated, not alphabetical. */
const POLICY_REGIONS = ['Americas', 'Europe', 'Asia-Pacific', 'Africa & Middle East'];

/** Shared style for a table's group-divider row. */
const groupRowStyle: React.CSSProperties = {
  color: color.blue,
  fontWeight: fontWeight.bold,
  fontSize: fontSize[11],
  letterSpacing: letterSpacing.wider,
  paddingTop: space[8],
};

/**
 * Central-bank policy rates (BIS).
 *
 * Grouped by region so a 33-row table stays scannable, and every row carries the
 * observation date — a policy rate is a step function, so "3.875%" is meaningless
 * without knowing when it was last set. An area BIS did not return stays `—`.
 */
export function PolicyRateTable({ rows }: { rows: PolicyRateRow[] }) {
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
                  <TD style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>
                    <span title={r.note}>{r.bank}</span>
                  </TD>
                  <TD align="right" style={{ color: color.labelPrimary }}>{fmtPolicyRate(r.rate)}</TD>
                  <TD align="right" style={{ color: color.labelTertiary }}>{r.date || DASH}</TD>
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
export function IndicatorTable({ rows }: { rows: IndicatorRow[] }) {
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
                  <TD style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>
                    <span title={r.note}>{r.name}</span>
                  </TD>
                  <TD align="right" style={{ color: color.labelPrimary }}>{fmtIndicator(r.value, r.unit, r.decimals)}</TD>
                  <TD align="right" style={{ color: color.labelTertiary }}>{fmtDate(r.date)}</TD>
                </TR>
              ))}
            </Fragment>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

/** Region order the worldwide table renders in — curated, not alphabetical. */
const WORLD_REGIONS = ['Americas', 'Europe', 'Asia-Pacific', 'Africa & Middle East'];

/** Group order for the aggregates table. */
const WORLD_AGGREGATE_GROUPS = ['World & income', 'Regions & unions'];

/**
 * Theme order for the grouped header. Stated here rather than imported: the
 * landing page must not reach across the feature boundary into the macro family,
 * so each column carries its own `theme` and this list only fixes the ORDER the
 * blocks appear in.
 */
const WORLD_THEME_ORDER = [
  'Output & prices',
  'People',
  'Labour & welfare',
  'External',
  'Money & state',
  'Government finance',
  'Companies',
  'Structure & sustainability',
];

/** The theme band that spans a column block's headings. */
const themeHeadStyle: React.CSSProperties = {
  color: color.blue,
  fontSize: fontSize[11],
  fontWeight: fontWeight.semibold,
  letterSpacing: letterSpacing.wider,
  textTransform: 'uppercase',
  paddingTop: space[8],
  paddingBottom: space[8],
  borderBottom: `1px solid ${color.separator}`,
};

/**
 * Cell padding for the worldwide board. The table component ships NO padding
 * default — measured, deliberately, because the tree's existing padding is a flat
 * spread with no winner — so every dense table states its own. Without this the
 * numeric columns run together into one unreadable band.
 */
const worldHeadStyle: React.CSSProperties = {
  padding: `${space[4]}px ${space[8]}px`,
  whiteSpace: 'nowrap',
};

/** A numeric cell: value over its change, top-aligned so the two lines stay in their column. */
const worldCellStyle: React.CSSProperties = {
  padding: `${space[4]}px ${space[8]}px`,
  whiteSpace: 'nowrap',
  verticalAlign: 'top',
};

/**
 * The rule that opens a theme block. With 24 columns and no vertical grid, a
 * reader loses which values belong together; one hairline at each block boundary
 * carries the grouping the theme band announces.
 */
const worldBlockStyle: React.CSSProperties = { borderLeft: `1px solid ${color.separator}` };

/** Colour a change by DIRECTION — a rising debt and a rising lifespan both print `+`. */
function dirColor(dir: -1 | 0 | 1): string {
  return dir > 0 ? color.green : dir < 0 ? color.red : color.labelTertiary;
}

/**
 * The worldwide economy board (World Bank, annual).
 *
 * A country × indicator matrix grouped by `region`, with the indicator columns
 * themselves grouped under their theme. Every cell prints its OWN reference year
 * AND its change against the observation ~10 years earlier: the series publish on
 * different lags, so one shared year column would be wrong for most of them, and
 * a level without its trend is only half the picture.
 *
 * Columns this table cannot fill are DROPPED, not shown blank: the aggregates
 * table has no current-account or reserves series upstream, and a permanently
 * empty column costs width without carrying information. A cell missing WITHIN a
 * rendered column stays an em dash — never a zero — and its year goes with it.
 */
export function WorldTable({
  rows,
  columns,
  groups,
}: {
  rows: WorldRow[];
  columns: WorldIndicatorRow[];
  groups: string[];
}) {
  const present = groups.filter(g => rows.some(r => r.region === g));
  // A column renders only where THIS table can actually fill it. The aggregates
  // table has no current-account or reserves series upstream, and a column that is
  // mostly blank costs width without carrying information — so the bar is half the
  // table's rows. A cell missing WITHIN a rendered column still shows as an em
  // dash; a column that is mostly dashes is not a column, it is a gap.
  const filled = columns.filter(c => rows.filter(r => r.cells[c.id]?.value != null).length * 2 >= rows.length);
  const blocks = WORLD_THEME_ORDER.map(theme => ({ theme, cols: filled.filter(c => c.theme === theme) })).filter(
    b => b.cols.length > 0
  );
  const cols = blocks.flatMap(b => b.cols);
  /** The first column of each theme block, which carries the block's opening rule. */
  const blockStart = new Set(blocks.map(b => b.cols[0].id));
  return (
    <div style={{ overflowX: 'auto', marginTop: space[12] }}>
      <Table style={{ fontSize: fontSize[11] }}>
        <THead>
          <TR style={theadRowStyle}>
            <TH rowSpan={2} style={{ verticalAlign: 'bottom' }}>
              Economy
            </TH>
            {blocks.map(b => (
              <TH
                key={b.theme}
                colSpan={b.cols.length}
                align="center"
                style={{ ...themeHeadStyle, ...worldBlockStyle }}
              >
                {b.theme}
              </TH>
            ))}
          </TR>
          <TR style={theadRowStyle}>
            {cols.map(c => (
              <TH key={c.id} align="right" style={blockStart.has(c.id) ? { ...worldHeadStyle, ...worldBlockStyle } : worldHeadStyle}>
                <span title={c.note}>{c.short}</span>
              </TH>
            ))}
          </TR>
        </THead>
        <TBody>
          {present.map(group => (
            <Fragment key={group}>
              <TR>
                <TD colSpan={cols.length + 1} style={groupRowStyle}>
                  {group.toUpperCase()}
                </TD>
              </TR>
              {rows
                .filter(r => r.region === group)
                .map(r => (
                  <TR key={r.code} style={rowStyle}>
                    <TD
                      style={{
                        color: color.labelPrimary,
                        fontWeight: fontWeight.bold,
                        padding: `${space[4]}px ${space[12]}px ${space[4]}px 0`,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {r.name}
                    </TD>
                    {cols.map(c => {
                      const cell = r.cells[c.id];
                      const value = cell?.value ?? null;
                      const prior = cell?.prior ?? null;
                      const dir = deltaDir(value, prior);
                      return (
                        <TD
                          key={c.id}
                          align="right"
                          style={blockStart.has(c.id) ? { ...worldCellStyle, ...worldBlockStyle } : worldCellStyle}
                        >
                          <div style={{ color: color.labelPrimary }}>
                            {fmtEconomy(value, c.kind, c.decimals)}{' '}
                            <span style={{ color: color.labelTertiary }}>{fmtYear(cell?.year)}</span>
                          </div>
                          <div
                            style={{ color: dirColor(dir), fontSize: fontSize[11] }}
                            title={prior ? `vs ${prior.year}: ${fmtEconomy(prior.value, c.kind, c.decimals)}` : 'no earlier observation to compare'}
                          >
                            {fmtDelta(value, prior, c.kind, c.decimals)}
                          </div>
                        </TD>
                      );
                    })}
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
 * Macro — the US Treasury curve, the dollar index and the volatility indices.
 *
 * A yield is quoted in percent and its move is rendered in BASIS POINTS
 * (`Δ × 100`), the convention for a rate; the index rows keep the percent delta.
 * The curve spreads are the route's locally-derived series and are labelled as
 * such. Everything is a read of the macro family; nothing is recomputed here.
 */
export function MacroBoard() {
  const { data, error, loading } = useJson<MacroEnvelope>(MACRO_URL);
  const rates = data ? data.quotes.filter(q => q.unit === 'yield') : [];
  const idx = data ? data.quotes.filter(q => q.unit === 'index') : [];
  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>Rates · dollar · volatility</h3>
      {error && <Banner variant="error">{error}</Banner>}
      {loading && !error && <Loading label="loading live figures…" />}
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
                    <TD style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>
                      <span title={q.note}>{q.name}</span>
                    </TD>
                    <TD align="right" style={{ color: color.labelPrimary }}>{fmtYield(q.price)}</TD>
                    <TD align="right"><Bp v={q.change} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          {data.spreads.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[12], marginTop: space[8] }}>
              {data.spreads.map(s => (
                <span key={s.label} style={{ fontSize: fontSize[11], color: color.labelTertiary }} title={s.note}>
                  {s.label}{' '}
                  <span style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>{fmtBpRaw(s.bp)}</span>
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
                    <TD style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>
                      <span title={q.note}>{q.name}</span>
                    </TD>
                    <TD align="right" style={{ color: color.labelPrimary }}>{fmtNum(q.price, 2)}</TD>
                    <TD align="right"><Change v={q.changePercent} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          {data.policyRates.length > 0 && <PolicyRateTable rows={data.policyRates} />}
          {data.indicators.length > 0 && <IndicatorTable rows={data.indicators} />}
          {data.worldIndicators.length > 0 && data.aggregates.length > 0 && (
            <>
              <h4 style={h4Style}>World &amp; regional aggregates</h4>
              <WorldTable rows={data.aggregates} columns={data.worldIndicators} groups={WORLD_AGGREGATE_GROUPS} />
            </>
          )}
          {data.worldIndicators.length > 0 && data.economies.length > 0 && (
            <details>
              <summary style={summaryStyle}>
                Major economies — {data.economies.length} countries × {data.worldIndicators.length} indicators, each with its decade change
              </summary>
              <WorldTable rows={data.economies} columns={data.worldIndicators} groups={WORLD_REGIONS} />
            </details>
          )}
          <p style={noteStyle}>
            each cell is value · reference year, over its change against the observation ~10 years earlier — a dash there means no
            comparable observation exists, not that nothing moved · a column a table cannot fill is dropped, not shown blank · yields
            in %, delta in basis points (Δ × 100) · curve spreads derived locally, not published upstream · {data.derived}
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
                  <TD style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>
                    <span title={q.note}>{q.name}</span>
                  </TD>
                  <TD align="right" style={{ color: color.labelPrimary }}>{fmtNum(q.price, 2)}</TD>
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
export function IndonesiaBoard() {
  const { data, error, loading } = useJson<IndonesiaEnvelope>(INDONESIA_URL);
  const economyGroups = data ? Array.from(new Set(data.economy.map(e => e.group))) : [];
  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>Rupiah · BI-Rate · economy</h3>
      {error && <Banner variant="error">{error}</Banner>}
      {loading && !error && <Loading label="loading live figures…" />}
      {!error && data && (
        <>
          {data.quotes.length > 0 && <IndonesiaLive quotes={data.quotes} />}
          <p style={{ ...noteStyle, marginTop: space[12] }} title={data.policy.note}>
            {data.policy.label}{' '}
            <span style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>{fmtPolicyRate(data.policy.rate)}</span>
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
                          <TD style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>
                            <span title={e.note}>{e.name}</span>
                          </TD>
                          <TD align="right" style={{ color: color.labelPrimary }}>{fmtEconomy(e.value, e.kind, e.decimals)}</TD>
                          <TD align="right" style={{ color: color.labelTertiary }}>{fmtYear(e.year)}</TD>
                        </TR>
                      ))}
                    </Fragment>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
          <p style={noteStyle}>
            quotes live · BI-Rate from BIS (daily) · annual rows from the World Bank, each with its own year · government finance from the IMF Fiscal Monitor
            {data.apbn ? `, actuals through ${data.apbn.actualThrough}` : ''} · {data.derived}
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
export function SignalQuality() {
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
      {loading && !error && <Loading label="loading live figures…" />}
      {!error && data && (
        <>
          {entries.map(([chain, c]) => {
            const b = c.latest as ScoreboardBucket;
            return (
              <div key={`meter-${chain}`} style={{ marginBottom: space[12] }}>
                <h4 style={{ ...h4Style, marginTop: 0 }}>{chain} — {b.day}</h4>
                <Meter
                  parts={[
                    { label: 'ran', value: b.run, color: color.green },
                    { label: 'flat', value: b.flat, color: color.labelTertiary },
                    { label: 'dumped', value: b.dump, color: color.red },
                    { label: 'unknown', value: b.unknown, color: color.separator },
                  ]}
                />
              </div>
            );
          })}
          {entries.length === 0 && <p style={noteStyle}>no cohort read for this window</p>}
          {best && (
            <p style={noteStyle}>
              best cohort catch:{' '}
              <span style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>{best.symbol || DASH}</span>{' '}
              <span style={{ color: color.blue }}>{fmtX(best.x24h)}</span> peak 24h · score{' '}
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

/**
 * Live-data proof strip (round-5 social proof).
 *
 * Honest numbers only: every figure comes from the same fetchers the sections
 * below already use — no hardcoded user counts, no testimonials, no logos.
 * Each stat withholds itself (renders nothing) when its source fetch fails or
 * is still loading, so the strip can only ever show verified live figures.
 * Internal links only, zero outbound.
 */
export function ProofStrip() {
  const cr = useJson<CrHome>(CR_HOME_URL);
  const mk = useJson<MarketsEnvelope>(MARKETS_TOP_URL);
  const sb = useJson<ScoreboardPayload>(SCOREBOARD_URL);
  const nw = useJson<NewsEnvelope>(NEWS_URL);
  const items: { label: string; value: string; href: string }[] = [];
  const tracked = cr.data?.global.allCurrencies;
  if (tracked != null && Number.isFinite(tracked)) {
    items.push({ label: 'Currencies tracked', value: fmtNum(tracked), href: '/market' });
  }
  if (mk.data != null && Number.isFinite(mk.data.pool)) {
    items.push({ label: 'Coins in live pool', value: fmtNum(mk.data.pool), href: '/market' });
  }
  if (sb.data?.chains) {
    const chains = Object.values(sb.data.chains);
    const n = chains.reduce((a, c) => a + (c.latest?.n ?? 0), 0);
    if (n > 0) items.push({ label: 'Wallets screened (latest cohort)', value: fmtNum(n), href: '/signals' });
  }
  if (nw.data != null && Number.isFinite(nw.data.total) && nw.data.total > 0) {
    items.push({ label: 'News items gated', value: fmtNum(nw.data.total), href: '/news' });
  }
  if (items.length === 0) return null;
  return (
    <p style={{ margin: `${space[12]}px 0 0`, color: color.labelTertiary, fontSize: fontSize[11] }}>
      live now:{' '}
      {items.map((it, i) => (
        <span key={it.label}>
          {i > 0 ? ' · ' : null}
          <Link href={it.href} style={{ color: color.blue, textDecoration: 'none', fontWeight: fontWeight.bold }}>
            {it.value} {it.label.toLowerCase()}
          </Link>
        </span>
      ))}
    </p>
  );
}

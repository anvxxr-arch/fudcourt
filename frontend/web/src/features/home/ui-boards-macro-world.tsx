'use client';
import { Fragment } from 'react';
import Link from 'next/link';
import { color, fontSize, fontWeight, letterSpacing, space } from '@/styles/tokens';
import { Banner } from '@/ui/banner';
import { Loading } from '@/ui/feedback';
import { TBody, TD, TH, THead, TR, Table } from '@/ui/table';
import {
  INDONESIA_URL,
  MACRO_URL,
  deltaDir,
  fmtBpRaw,
  fmtDelta,
  fmtEconomy,
  fmtNum,
  fmtPolicyRate,
  fmtYear,
  fmtYield,
  type IndonesiaEnvelope,
  type IndonesiaQuote,
  type MacroEnvelope,
  type WorldIndicatorRow,
  type WorldRow,
} from './client';
import { cardStyle, h3Style, noteStyle, theadRowStyle, rowStyle, listRowStyle, useJson, Change } from './ui-shared';
import { Sparkline } from '@/ui/sparkline';
import { Bp, groupRowStyle } from './ui-boards-macro-policy';
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
            {rates.map(q => (
              <div key={q.symbol} style={listRowStyle}>
                <span title={q.note} style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>{q.name}</span>
                <Sparkline points={q.trend ?? []} width={64} height={16} />
                <span style={{ color: color.labelPrimary, whiteSpace: 'nowrap' }}>{fmtYield(q.price)}</span>
                <Bp v={q.change} />
              </div>
            ))}
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: space[8], marginTop: space[12] }}>
            {idx.map(q => (
              <div key={q.symbol} style={listRowStyle}>
                <span title={q.note} style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>{q.name}</span>
                <Sparkline points={q.trend ?? []} width={64} height={16} />
                <span style={{ color: color.labelPrimary, whiteSpace: 'nowrap' }}>{fmtNum(q.price, 2)}</span>
                <Change v={q.changePercent} />
              </div>
            ))}
          </div>
          <p style={{ ...noteStyle, marginTop: space[12] }}>
            {data.policyRates.length} policy rates · {data.indicators.length} indicators · {data.economies.length} economies ×{' '}
            {data.worldIndicators.length} world indicators — full tables on the{' '}
            <Link href="/economy" style={{ color: color.blue }}>economy dashboard →</Link>
          </p>
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
            <TH align="right">Trend</TH>
            <TH align="right">Level</TH>
            <TH align="right">Δ</TH>
          </TR>
        </THead>
        <TBody>
          {groups.map(g => (
            <Fragment key={g}>
              <TR>
                <TD colSpan={4} style={groupRowStyle}>{g.toUpperCase()}</TD>
              </TR>
              {quotes.filter(q => q.group === g).map(q => (
                <TR key={q.symbol} style={rowStyle}>
                  <TD style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>
                    <span title={q.note}>{q.name}</span>
                  </TD>
                  <TD align="right" style={{ color: color.labelPrimary }}>
                    <Sparkline points={q.trend ?? []} width={64} height={16} />
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
            <p style={{ ...noteStyle, marginTop: space[12] }}>
              {data.economy.length} annual series across {economyGroups.length} groups (World Bank, IMF Fiscal Monitor) ·{' '}
              <Link href="/economy" style={{ color: color.blue }}>full Indonesia board →</Link>
            </p>
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

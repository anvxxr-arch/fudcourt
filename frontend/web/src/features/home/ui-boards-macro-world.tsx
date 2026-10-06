'use client';
import { Fragment } from 'react';
import { color, fontSize, fontWeight, letterSpacing, space } from '@/styles/tokens';
import { TBody, TD, TH, THead, TR, Table } from '@/ui/table';
import {
  deltaDir,
  fmtDelta,
  fmtEconomy,
  fmtYear,
  type WorldIndicatorRow,
  type WorldRow,
} from './client';
import { theadRowStyle, rowStyle } from './ui-shared';
import { groupRowStyle } from './ui-boards-macro-policy';
/** Live boards — implemented alongside, re-exported here so existing importers keep working. */
export { MacroBoard, IndonesiaBoard } from './ui-boards-macro-boards';
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

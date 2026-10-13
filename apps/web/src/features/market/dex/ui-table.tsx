'use client';
import { alpha, themeColor, fontSize, space } from '@/styles/tokens';
import { Table, TBody, THead } from '@/ui/table';
import type { ReactNode } from 'react';
import { memo } from 'react';

/**
 * One DEX table skeleton shared by the canonical board and the DexScreener
 * pairs board. The two boards shipped byte-similar copies of the same ten
 * columns — same cell paddings, same em-dash treatments, same row rule — and
 * copies that similar drift apart on every styling change. The COLUMN VALUES
 * stay the caller's: this component owns only the skeleton (wrapper, header
 * row, row rule, cell chrome), never a formatter.
 *
 * Rows are `ReactNode[]` in header order. A null cell renders the em-dash
 * here so "absent" cannot silently become an empty cell (which reads as a
 * rendering bug) or a zero (which reads as data).
 */
export type MarketColumn = {
  key: string;
  label: string;
  /** Right-align numeric columns so amounts scan down their decimal point. */
  align?: 'left' | 'right';
  /** Numeric columns render tabular figures: a column of prices that jitters
   * horizontally as values tick is unreadable. */
  numeric?: boolean;
  width?: number | string;
};

export type MarketRowCells = {
  key: string;
  cells: (ReactNode | null)[];
};

const DASH_CELL = <span style={{ color: themeColor.labelTertiary }}>—</span>;

const Row = memo(function Row({ cells, cols }: { cells: (ReactNode | null)[]; cols: readonly MarketColumn[] }) {
  return (
    <tr style={{ borderBottom: `1px solid ${alpha(themeColor.labelOnAccent, 0.04)}` }}>
      {cols.map((c, i) => (
        <td
          key={c.key}
          style={{
            padding: '5px 6px',
            textAlign: c.align === 'right' ? 'right' : undefined,
            whiteSpace: 'nowrap',
            fontVariantNumeric: c.numeric ? 'tabular-nums' : undefined,
            color: themeColor.labelPrimary,
          }}
        >
          {cells[i] ?? DASH_CELL}
        </td>
      ))}
    </tr>
  );
});

export function MarketTable({
  columns,
  rows,
  empty,
  overflowNote,
}: {
  columns: readonly MarketColumn[];
  rows: MarketRowCells[];
  /** Rendered when the row list is empty — the caller states WHY it is empty. */
  empty: ReactNode;
  /** "showing first 100 of N" — the caller computes it; an unbounded board is a lie. */
  overflowNote?: ReactNode;
}) {
  if (rows.length === 0) return <>{empty}</>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <Table style={{ fontSize: fontSize[11] }}>
        <THead>
          <tr style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], textAlign: 'left' }}>
            {columns.map((h) => (
              <th
                key={h.key}
                scope="col"
                style={{
                  padding: `${space[4]}px ${space[8]}px`,
                  borderBottom: `1px solid ${themeColor.separator}`,
                  whiteSpace: 'nowrap',
                  textAlign: h.align === 'right' ? 'right' : undefined,
                  width: h.width,
                }}
              >
                {h.label}
              </th>
            ))}
          </tr>
        </THead>
        <TBody>
          {rows.slice(0, 100).map((r) => (
            <Row key={r.key} cells={r.cells} cols={columns} />
          ))}
        </TBody>
      </Table>
      {overflowNote}
    </div>
  );
}

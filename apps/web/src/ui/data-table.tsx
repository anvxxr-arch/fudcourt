import type { ReactNode } from 'react';
import Link from 'next/link';
import { alpha, color, fontSize, fontWeight, letterSpacing, space } from '@/styles/tokens';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';

/**
 * A dense table whose rows link to a canonical slug. The economy and trade
 * module kits shipped byte-identical copies of this exact shape — one
 * canonical atom now, and every caller renders from it.
 */
export function DataTable({ head, rows }: { head: readonly string[]; rows: readonly { cells: ReactNode[]; href?: string }[] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <Table>
        <THead>
          <TR>
            {head.map((h) => (
              <TH key={h} style={{ textAlign: 'left', padding: `${space[8]}px ${space[8]}px`, color: color.labelTertiary, fontWeight: fontWeight.medium, fontSize: fontSize[11], letterSpacing: letterSpacing.sm, textTransform: 'uppercase', borderBottom: `1px solid ${color.separator}` }}>{h}</TH>
            ))}
          </TR>
        </THead>
        <TBody>
          {rows.map((r, i) => (
            <TR key={i}>
              {r.cells.map((c, j) => (
                <TD key={j} style={{ padding: `${space[8]}px ${space[8]}px`, borderBottom: `1px solid ${alpha(color.separator, 0.6)}`, color: color.labelPrimary, whiteSpace: j === 0 ? 'normal' : 'nowrap' }}>
                  {j === 0 && r.href ? (
                    <Link href={r.href} style={{ color: color.blue, textDecoration: 'none' }}>{c}</Link>
                  ) : (
                    c
                  )}
                </TD>
              ))}
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

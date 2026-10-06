import { themeColor, fontFamily, fontSize, fontWeight } from '@/styles/tokens';

type Align = 'left' | 'right' | 'center';

/**
 * Defaults are MEASURED. Unit of measurement:
 *   * table-level:  one `<table>` region;
 *   * TH/TD:        one region that actually contains a `<th>`/`<td>` (a region with none
 *                   cannot vote on that cell's padding);
 *   * TR borders:   one MAPPED BODY ROW (`<tr key=…>`) — the header row and the colSpan
 *                   empty-state row are a different shape and drown out the body otherwise.
 * Counting per-cell would let cryptorank's 15 tables outvote the other 12 files; a default's
 * job is "make the most TABLES adopt with no override".
 *
 * Measured at HEAD (pre-migration), because that is the rendering the zero-visual-change rule
 * preserves — the adopters have since dropped the inline styles these defaults replace:
 *
 *   <table>  width '100%' 24/24 (100%) · borderCollapse 28/28 (100%) · fontSize 12 25/32 (78%,
 *            11 5/32, 13 2/32)  → all three defaulted. Every live `<Table>` caller that wants
 *            another size already passes one (dex 11; llama 12; scoreboard/
 *            signals 11); executor's cells all carry their own `fontSize`, so nothing moves.
 *   <th>     fontWeight semibold 13/33 (39%, tied with unset) — kept as the header treatment,
 *            which matches the `<tr style={{ color: …, textAlign: 'left' }}>` idiom the tree
 *            puts the muted colour on (the cell never carries `color`: 33/33 unset).
 *            padding is FLAT — `6px 6px` 9, unset 6, `6px 8px` 3, `6px 5px` 3, `4px 6px` 3,
 *            6 3, `5px 8px` 2, … — and 9 of the top 13 sit in ONE file → NO default.
 *   <td>     padding equally flat (`5px 6px` 10, unset 6, `6px 8px` 3, `5px 5px` 3, 6 3, …)
 *            → NO default. textAlign 26 unset / 10 right → no winner; the `align` prop says it.
 *   <tr>     borderBottom `1px solid themeColor.separator` 21/37 mapped body rows (57%) vs unset 6 —
 *            a clear plurality, and the 21 are cryptorank's 14 tables, which migrated to a
 *            bare `<TR key=…>` and would lose their row rules without it. The sites that want
 *            a different rule already override it (llama `borderBottom: 0` +
 *            borderTop; dex the same; signals/scoreboard/reconciliation an alpha border), so
 *            defaulting it is a no-op for them and restores cryptorank's HEAD rendering.
 *
 * The `space` values that dominate real cell padding cannot be tokenized — `space` has no 5
 * step (`'5px 6px'` 49 cells, `'5px 8px'` 17, `'5px 5px'` 13). REPORTED, not minted: a token
 * with no defined scale position is drift in the other direction.
 */
type TableProps = { children: React.ReactNode; style?: React.CSSProperties };

export function Table({ children, style }: TableProps) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: fontSize[12], ...style }}>
      {children}
    </table>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  return <thead>{children}</thead>;
}

export function TBody({ children }: { children: React.ReactNode }) {
  return <tbody>{children}</tbody>;
}

type TRProps = { children: React.ReactNode; style?: React.CSSProperties };

export function TR({ children, style }: TRProps) {
  return <tr style={{ borderBottom: `1px solid ${themeColor.separator}`, ...style }}>{children}</tr>;
}

type THProps = {
  children?: React.ReactNode;
  align?: Align;
  style?: React.CSSProperties;
  /** For a grouped header: a theme cell spans its columns, the label column spans its rows. */
  colSpan?: number;
  rowSpan?: number;
};

export function TH({ children, align = 'left', style, colSpan, rowSpan }: THProps) {
  return (
    <th
      colSpan={colSpan}
      rowSpan={rowSpan}
      style={{ textAlign: align, color: themeColor.labelTertiary, fontWeight: fontWeight.semibold, ...style }}
    >
      {children}
    </th>
  );
}

type TDProps = { children?: React.ReactNode; align?: Align; style?: React.CSSProperties; mono?: boolean; colSpan?: number };

export function TD({ children, align = 'left', style, mono, colSpan }: TDProps) {
  return (
    <td colSpan={colSpan} style={{ textAlign: align, ...(mono ? { fontFamily: fontFamily.mono } : null), ...style }}>
      {children}
    </td>
  );
}

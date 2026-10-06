/**
 * atoms/table — Table, TableHeader, TableBody, TableFooter, TableRow, TableCell,
 * ColumnHeader, SortIndicator, RowSelector, ResizeHandle.
 *
 * The atomic table layer ONLY. The plan is explicit about what is NOT here yet:
 * TableToolbar, FilterMenu, Pagination, BulkActionBar, ColumnVisibility popover, full
 * DataTable orchestration, server pagination, query-state synchronization. Those are
 * Section 02.
 *
 * DENSITY IS A DIMENSION, NOT A FORK. `<Table density="compact" />` is one implementation
 * reading `dims('compact').row` — there are no CompactTable/DefaultTable/ComfortableTable.
 *
 * ALIGNMENT DEFAULTS ARE MEANINGFUL: text/entity/status/date left, numeric financial right,
 * actions right, checkbox center. A column of prices that is not right-aligned cannot be
 * scanned down its decimal point.
 */
import { forwardRef, type ReactNode, type ThHTMLAttributes, type TdHTMLAttributes } from 'react';
import { cssVar, type SemanticToken } from '@/ui/foundations/color';
import { dims, type Density } from '@/ui/foundations/spacing';
import { focusRingClass } from '@/ui/foundations/accessibility';
import { nonColorCues } from '@/ui/foundations/accessibility';

type BaseProps = {
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/** What a cell holds, which decides its default alignment. */
export type CellKind = 'text' | 'entity' | 'status' | 'date' | 'numeric' | 'actions' | 'checkbox';

/** The default alignment per kind. */
const KIND_ALIGN: Record<CellKind, 'left' | 'right' | 'center'> = {
  text: 'left',
  entity: 'left',
  status: 'left',
  date: 'left',
  numeric: 'right',
  actions: 'right',
  checkbox: 'center',
};

/** A row's atomic state. */
export type RowState = 'default' | 'hover' | 'selected' | 'active' | 'disabled' | 'loading' | 'warning' | 'critical';

/** The background role a row state resolves to. */
const ROW_BG: Record<RowState, SemanticToken | null> = {
  default: null,
  hover: 'surface-secondary',
  selected: 'brand-subtle',
  active: 'surface-secondary',
  disabled: 'surface-secondary',
  loading: 'surface-secondary',
  warning: 'warning-subtle',
  critical: 'negative-subtle',
};

/** A cell's atomic state. */
export type CellState = 'default' | 'editable' | 'focused' | 'changed' | 'error';

type TableProps = BaseProps & {
  children: ReactNode;
  density?: Density;
  /** Stretches the table to its container. Default true. */
  fullWidth?: boolean;
};

/** Table — the `<table>` element with the density and typography baseline. */
export const Table = forwardRef<HTMLTableElement, TableProps>(function Table(
  { children, density = 'default', fullWidth = true, className, style, theme = 'light' },
  ref,
) {
  const d = dims(density);
  return (
    <table
      ref={ref}
      className={['fc-table', `fc-table-${density}`, className].filter(Boolean).join(' ')}
      style={{
        width: fullWidth ? '100%' : undefined,
        borderCollapse: 'collapse',
        fontFamily: 'var(--fc-font-sans)',
        fontSize: 'var(--fc-type-body-sm-size)',
        lineHeight: 'var(--fc-type-body-sm-line)',
        color: cssVar('text-primary'),
        // The row height is the density contract's row dimension.
        ['--fc-table-row-h' as string]: `${d.row}px`,
        ...style,
      }}
    >
      {children}
    </table>
  );
});

/** TableHeader — the `<thead>`. Sticky is permitted here as a primitive. */
export const TableHeader = forwardRef<HTMLTableSectionElement, BaseProps & { children: ReactNode; sticky?: boolean }>(
  function TableHeader({ children, sticky, className, style, theme = 'light' }, ref) {
    return (
      <thead
        ref={ref}
        className={['fc-table-header', sticky ? 'fc-table-header-sticky' : '', className].filter(Boolean).join(' ')}
        style={{
          background: cssVar('surface-secondary'),
          ...(sticky ? { position: 'sticky', top: 0, zIndex: 'var(--fc-z-index-sticky)' } : null),
          ...style,
        }}
      >
        {children}
      </thead>
    );
  },
);

/** TableBody — the `<tbody>`. */
export const TableBody = forwardRef<HTMLTableSectionElement, BaseProps & { children: ReactNode }>(
  function TableBody({ children, className, style, theme = 'light' }, ref) {
    return (
      <tbody ref={ref} className={['fc-table-body', className].filter(Boolean).join(' ')} style={style}>
        {children}
      </tbody>
    );
  },
);

/** TableFooter — the `<tfoot>`, for a totals row. */
export const TableFooter = forwardRef<HTMLTableSectionElement, BaseProps & { children: ReactNode }>(
  function TableFooter({ children, className, style, theme = 'light' }, ref) {
    return (
      <tfoot
        ref={ref}
        className={['fc-table-footer', className].filter(Boolean).join(' ')}
        style={{ background: cssVar('surface-secondary'), borderTop: `1px solid ${cssVar('border-strong')}`, ...style }}
      >
        {children}
      </tfoot>
    );
  },
);

type TableRowProps = BaseProps & {
  children: ReactNode;
  state?: RowState;
  /** Marks the row as the current keyboard/selection target. */
  selected?: boolean;
  onClick?: () => void;
};

/** TableRow — a `<tr>` with its atomic state. */
export const TableRow = forwardRef<HTMLTableRowElement, TableRowProps>(function TableRow(
  { children, state = 'default', selected, onClick, className, style, theme = 'light', ...rest },
  ref,
) {
  const effective: RowState = selected ? 'selected' : state;
  const bg = ROW_BG[effective];
  return (
    <tr
      ref={ref}
      className={['fc-table-row', `fc-table-row-${effective}`, className].filter(Boolean).join(' ')}
      aria-selected={selected}
      onClick={onClick}
      style={{
        height: 'var(--fc-table-row-h)',
        background: bg ? cssVar(bg) : undefined,
        borderBottom: `1px solid ${cssVar('border-subtle')}`,
        cursor: onClick ? 'pointer' : undefined,
        opacity: effective === 'disabled' ? 0.55 : 1,
        transition: 'background-color var(--fc-motion-fast) var(--fc-ease-standard)',
        ...style,
      }}
      {...rest}
    >
      {children}
    </tr>
  );
});

type TableCellProps = Omit<TdHTMLAttributes<HTMLTableCellElement>, 'className'> & {
  children?: ReactNode;
  /** What the cell holds, which sets the default alignment. */
  kind?: CellKind;
  /** Overrides the kind's default alignment. */
  align?: 'left' | 'right' | 'center';
  state?: CellState;
  /** Renders the value in Geist Mono with tabular figures. Implied by `kind="numeric"`. */
  mono?: boolean;
  /** Spans columns. */
  colSpan?: number;
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/** The border role a cell state resolves to. */
const CELL_BORDER: Record<CellState, SemanticToken | null> = {
  default: null,
  editable: 'border-default',
  focused: 'focus-ring',
  changed: 'brand-border',
  error: 'negative',
};

/** TableCell — a `<td>`. */
export const TableCell = forwardRef<HTMLTableCellElement, TableCellProps>(function TableCell(
  { children, kind = 'text', align, state = 'default', mono, colSpan, className, style, theme = 'light', ...rest },
  ref,
) {
  const a = align ?? KIND_ALIGN[kind];
  const isMono = mono ?? kind === 'numeric';
  const border = CELL_BORDER[state];
  return (
    <td
      ref={ref}
      colSpan={colSpan}
      className={['fc-table-cell', `fc-table-cell-${kind}`, className].filter(Boolean).join(' ')}
      style={{
        textAlign: a,
        padding: '0 var(--fc-space-3)',
        height: 'var(--fc-table-row-h)',
        verticalAlign: 'middle',
        fontFamily: isMono ? 'var(--fc-font-mono)' : undefined,
        fontVariantNumeric: isMono ? ('tabular-nums' as const) : undefined,
        color: state === 'error' ? cssVar('negative-critical') : cssVar('text-primary'),
        border: border ? `1px solid ${cssVar(border)}` : undefined,
        ...style,
      }}
      {...rest}
    >
      {children}
    </td>
  );
});

type ColumnHeaderProps = Omit<ThHTMLAttributes<HTMLTableCellElement>, 'className'> & {
  children?: ReactNode;
  kind?: CellKind;
  align?: 'left' | 'right' | 'center';
  /** Makes the column sortable and wires up the sort indicator. */
  sortable?: boolean;
  /** The current sort direction. Omit when unsorted. */
  sortDirection?: 'asc' | 'desc' | null;
  /** Called with the next direction when the header is activated. */
  onSort?: (dir: 'asc' | 'desc') => void;
  /** A fixed width, for the column-width primitive. */
  width?: number | string;
  colSpan?: number;
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * ColumnHeader — a `<th>` that knows what it holds and whether it sorts.
 *
 * A sortable header is a real `<button>` inside the `<th>`, so Enter/Space activate it and
 * the sort direction is announced. An unsortable header is plain text — a button that does
 * nothing is a lie told to a keyboard user.
 */
export const ColumnHeader = forwardRef<HTMLTableCellElement, ColumnHeaderProps>(function ColumnHeader(
  { children, kind = 'text', align, sortable, sortDirection = null, onSort, width, colSpan, className, style, theme = 'light', ...rest },
  ref,
) {
  const a = align ?? KIND_ALIGN[kind];
  const isMono = kind === 'numeric';
  const next: 'asc' | 'desc' = sortDirection === 'asc' ? 'desc' : 'asc';
  return (
    <th
      ref={ref}
      colSpan={colSpan}
      scope="col"
      aria-sort={sortDirection === 'asc' ? 'ascending' : sortDirection === 'desc' ? 'descending' : sortable ? 'none' : undefined}
      className={['fc-column-header', `fc-column-header-${kind}`, className].filter(Boolean).join(' ')}
      style={{
        textAlign: a,
        padding: '0 var(--fc-space-3)',
        height: 'var(--fc-table-row-h)',
        verticalAlign: 'middle',
        width,
        fontFamily: isMono ? 'var(--fc-font-mono)' : 'var(--fc-font-sans)',
        fontSize: 'var(--fc-type-label-sm-size)',
        fontWeight: 'var(--fc-font-weight-semibold)',
        color: cssVar('text-muted'),
        whiteSpace: 'nowrap',
        ...style,
      }}
      {...rest}
    >
      {sortable ? (
        <button
          type="button"
          onClick={() => onSort?.(next)}
          className={focusRingClass}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--fc-space-1)',
            padding: 0,
            border: 0,
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            cursor: 'pointer',
            flexDirection: a === 'right' ? 'row-reverse' : 'row',
          }}
        >
          {children}
          <SortIndicator direction={sortDirection} />
        </button>
      ) : (
        children
      )}
    </th>
  );
});

type SortIndicatorProps = {
  /** The current direction. `null` means unsorted — the indicator is then a neutral glyph. */
  direction: 'asc' | 'desc' | null;
  className?: string;
  style?: React.CSSProperties;
};

/**
 * SortIndicator — the arrow that says which way a column sorts.
 *
 * The direction is in the glyph AND in `aria-sort` on the header, so it survives a
 * colour-blind reader and a screen reader. An unsorted column shows a dimmed both-ways
 * glyph rather than nothing, so the affordance is discoverable.
 */
export const SortIndicator = forwardRef<HTMLSpanElement, SortIndicatorProps>(function SortIndicator(
  { direction, className, style },
  ref,
) {
  const glyph = direction === 'asc' ? '▲' : direction === 'desc' ? '▼' : '△';
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={['fc-sort-indicator', className].filter(Boolean).join(' ')}
      style={{
        display: 'inline-block',
        fontSize: 'var(--fc-font-size-8)',
        lineHeight: 'var(--fc-line-height-none)',
        color: direction ? cssVar('text-secondary') : cssVar('text-disabled'),
        ...style,
      }}
    >
      {glyph}
    </span>
  );
});

type RowSelectorProps = {
  /** Accessible name, e.g. "Select row 3". */
  label: string;
  checked?: boolean;
  indeterminate?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * RowSelector — the checkbox that selects a row.
 *
 * Centered by the `checkbox` cell kind. The indeterminate state is set on the DOM node
 * because React has no prop for it — a tri-state checkbox is a real accessibility need (a
 * header that selects some but not all rows).
 */
export const RowSelector = forwardRef<HTMLInputElement, RowSelectorProps>(function RowSelector(
  { label, checked, indeterminate, onChange, disabled, className, style, theme = 'light' },
  ref,
) {
  return (
    <input
      ref={(node) => {
        if (node) node.indeterminate = !!indeterminate;
        if (typeof ref === 'function') ref(node);
        else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = node;
      }}
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.checked)}
      className={[focusRingClass, 'fc-row-selector', className].filter(Boolean).join(' ')}
      style={{ width: 14, height: 14, accentColor: cssVar('brand-primary'), cursor: disabled ? 'not-allowed' : 'pointer', ...style }}
    />
  );
});

type ResizeHandleProps = {
  /** Accessible name, e.g. "Resize Price column". */
  label: string;
  /** Called with the pointer's clientX on drag. The caller owns the width state. */
  onResize?: (deltaX: number) => void;
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * ResizeHandle — the draggable edge of a column.
 *
 * A real `<button>` with `aria-label`, so a keyboard user can at least reach and activate
 * it; the pointer drag is the fast path, not the only path. The width state belongs to the
 * caller — this atom reports the delta and nothing else.
 */
export const ResizeHandle = forwardRef<HTMLButtonElement, ResizeHandleProps>(function ResizeHandle(
  { label, onResize, className, style, theme = 'light' },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={[focusRingClass, 'fc-resize-handle', className].filter(Boolean).join(' ')}
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const move = (ev: PointerEvent) => onResize?.(ev.clientX - startX);
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
      style={{
        display: 'block',
        width: 8,
        height: '100%',
        minHeight: 16,
        padding: 0,
        border: 0,
        background: 'transparent',
        cursor: 'col-resize',
        position: 'relative',
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 2,
          bottom: 2,
          right: 3,
          width: 1,
          background: cssVar('border-default'),
        }}
      />
    </button>
  );
});

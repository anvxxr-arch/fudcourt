/**
 * atoms/layout — Container, Grid, GridItem, Stack, Inline, Cluster, Spacer, ScrollArea,
 * StickyRegion.
 *
 * Layout primitives ONLY. The plan is explicit that navigation composition, breadcrumb
 * composition, page scaffolding and feature layouts are out of scope — these are the
 * vocabulary a page composes from, not the pages themselves.
 *
 * Responsive behaviour is opt-in per prop, never automatic: a layout that silently reflows
 * at a breakpoint is a layout that breaks a caller's assumptions.
 */
import { forwardRef, type ReactNode } from 'react';
import { cssVar } from '@/ui/foundations/color';
import { breakpoints } from '@/ui/foundations/layout';

type BaseProps = {
  children?: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

type ContainerProps = BaseProps & {
  /**
   * `product` — the 12-column dashboard width with 24–32px page padding,
   * `editorial` — the 680–760px reading column,
   * `workspace` — full width with 16px minimum padding.
   */
  family?: 'product' | 'editorial' | 'workspace';
  /** Caps the width. Defaults to the family's natural maximum. */
  maxWidth?: number | string;
  /** Centers the container horizontally. Default true. */
  centered?: boolean;
};

/** The natural maximum width per family. */
const FAMILY_MAX = {
  product: `${breakpoints['3xl']}px`,
  editorial: 'var(--fc-editorial-reading)',
  workspace: '100%',
} as const;

/** The horizontal padding per family. */
const FAMILY_PAD = {
  product: 'var(--fc-grid-page-min)',
  editorial: 'var(--fc-space-4)',
  workspace: 'var(--fc-workspace-pad)',
} as const;

/**
 * Container — the outermost width constraint for a region.
 *
 * One container per page region, not one per component: nesting containers is how a layout
 * ends up with three different gutters and no way to reason about any of them.
 */
export const Container = forwardRef<HTMLDivElement, ContainerProps>(function Container(
  { children, family = 'product', maxWidth, centered = true, className, style, theme = 'light' },
  ref,
) {
  return (
    <div
      ref={ref}
      className={['fc-container', `fc-container-${family}`, className].filter(Boolean).join(' ')}
      style={{
        width: '100%',
        maxWidth: maxWidth ?? FAMILY_MAX[family],
        marginLeft: centered ? 'auto' : undefined,
        marginRight: centered ? 'auto' : undefined,
        paddingLeft: FAMILY_PAD[family],
        paddingRight: FAMILY_PAD[family],
        boxSizing: 'border-box',
        ...style,
      }}
    >
      {children}
    </div>
  );
});

type GridProps = BaseProps & {
  /** Column count. Default 12 (the product grid). */
  columns?: number;
  /** Gap between cells. Default the 24px product gutter. */
  gap?: number | string;
  /** Responsive column counts, keyed by breakpoint name. */
  responsive?: Partial<Record<'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl', number>>;
};

/**
 * Grid — a 12-column (or N-column) layout grid.
 *
 * `responsive` collapses the column count at named breakpoints. It is opt-in: a grid that
 * reflows because a container got narrow is a grid that surprises its caller.
 */
export const Grid = forwardRef<HTMLDivElement, GridProps>(function Grid(
  { children, columns = 12, gap = 'var(--fc-grid-gutter)', responsive, className, style, theme = 'light' },
  ref,
) {
  const responsiveCss: React.CSSProperties = {};
  if (responsive) {
    for (const [bp, cols] of Object.entries(responsive)) {
      if (cols === undefined) continue;
      // A media query cannot be expressed in an inline style, so the responsive map is
      // emitted as a CSS custom property per breakpoint and the caller's stylesheet
      // consumes it. Without a stylesheet the grid stays at `columns`.
      responsiveCss[`--fc-grid-cols-${bp}` as string] = String(cols);
    }
  }
  return (
    <div
      ref={ref}
      className={['fc-grid', className].filter(Boolean).join(' ')}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap,
        ...responsiveCss,
        ...style,
      }}
    >
      {children}
    </div>
  );
});

type GridItemProps = BaseProps & {
  /** How many columns to span. Default 1. */
  span?: number;
  /** The column to start at. Omit to let the grid place it. */
  start?: number;
  /** Responsive spans, keyed by breakpoint name. */
  responsive?: Partial<Record<'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl', number>>;
};

/** GridItem — one cell of a Grid. */
export const GridItem = forwardRef<HTMLDivElement, GridItemProps>(function GridItem(
  { children, span = 1, start, responsive, className, style, theme = 'light' },
  ref,
) {
  const responsiveCss: React.CSSProperties = {};
  if (responsive) {
    for (const [bp, cols] of Object.entries(responsive)) {
      if (cols === undefined) continue;
      responsiveCss[`--fc-grid-item-span-${bp}` as string] = String(cols);
    }
  }
  return (
    <div
      ref={ref}
      className={['fc-grid-item', className].filter(Boolean).join(' ')}
      style={{
        gridColumn: start ? `${start} / span ${span}` : `span ${span}`,
        minWidth: 0,
        ...responsiveCss,
        ...style,
      }}
    >
      {children}
    </div>
  );
});

type StackProps = BaseProps & {
  /** Gap between children. Default 16px. */
  gap?: number | string;
  /** Aligns children on the cross axis. */
  align?: 'start' | 'center' | 'end' | 'stretch';
  /** Justifies children on the main axis. */
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  /** Divides children with a hairline. */
  divided?: boolean;
};

/**
 * Stack — children in a column.
 *
 * The most-used layout primitive. `divided` marks the stack so a stylesheet can insert a
 * `border-subtle` rule between children rather than around them, which is the shape a
 * settings list wants.
 */
export const Stack = forwardRef<HTMLDivElement, StackProps>(function Stack(
  { children, gap = 'var(--fc-space-4)', align = 'stretch', justify = 'start', divided, className, style, theme = 'light' },
  ref,
) {
  return (
    <div
      ref={ref}
      className={['fc-stack', divided ? 'fc-stack-divided' : '', className].filter(Boolean).join(' ')}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap,
        alignItems: align === 'start' ? 'flex-start' : align === 'end' ? 'flex-end' : align,
        justifyContent: justify === 'between' ? 'space-between' : justify === 'around' ? 'space-around' : justify === 'start' ? 'flex-start' : justify,
        ...style,
      }}
    >
      {children}
    </div>
  );
});

type InlineProps = BaseProps & {
  gap?: number | string;
  align?: 'start' | 'center' | 'end' | 'baseline' | 'stretch';
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  /** Wraps children onto multiple lines. Default true. */
  wrap?: boolean;
};

/** Inline — children in a row. */
export const Inline = forwardRef<HTMLDivElement, InlineProps>(function Inline(
  { children, gap = 'var(--fc-space-2)', align = 'center', justify = 'start', wrap = true, className, style, theme = 'light' },
  ref,
) {
  return (
    <div
      ref={ref}
      className={['fc-inline', className].filter(Boolean).join(' ')}
      style={{
        display: 'flex',
        flexDirection: 'row',
        gap,
        alignItems: align,
        justifyContent: justify === 'between' ? 'space-between' : justify === 'around' ? 'space-around' : justify,
        flexWrap: wrap ? 'wrap' : 'nowrap',
        ...style,
      }}
    >
      {children}
    </div>
  );
});

type ClusterProps = BaseProps & {
  gap?: number | string;
  /** Horizontal alignment of the whole cluster. */
  justify?: 'start' | 'center' | 'end' | 'between';
};

/**
 * Cluster — a wrapping row of small items.
 *
 * For tags, chips, filter pills and icon groups: many small equal-weight items that should
 * flow onto as many lines as they need without a grid's column arithmetic.
 */
export const Cluster = forwardRef<HTMLDivElement, ClusterProps>(function Cluster(
  { children, gap = 'var(--fc-space-2)', justify = 'start', className, style, theme = 'light' },
  ref,
) {
  return (
    <div
      ref={ref}
      className={['fc-cluster', className].filter(Boolean).join(' ')}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap,
        justifyContent: justify === 'between' ? 'space-between' : justify === 'start' ? 'flex-start' : justify,
        ...style,
      }}
    >
      {children}
    </div>
  );
});

type SpacerProps = {
  /** The space to occupy. Default 16px. */
  size?: number | string;
  /** `horizontal` grows width, `vertical` (default) grows height. */
  orientation?: 'horizontal' | 'vertical';
  /** Fills the available space, ignoring `size`. */
  flex?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

/**
 * Spacer — an explicit gap.
 *
 * Exists so a caller does not reach for a magic `marginLeft: 24` when it means "push these
 * apart". `flex` makes it fill, which is the "push to opposite ends" idiom.
 */
export const Spacer = forwardRef<HTMLDivElement, SpacerProps>(function Spacer(
  { size = 'var(--fc-space-4)', orientation = 'vertical', flex, className, style },
  ref,
) {
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={['fc-spacer', className].filter(Boolean).join(' ')}
      style={{
        flex: flex ? '1 1 auto' : '0 0 auto',
        width: orientation === 'horizontal' ? size : undefined,
        height: orientation === 'vertical' ? size : undefined,
        ...style,
      }}
    />
  );
});

type ScrollAreaProps = BaseProps & {
  /** Caps the height and scrolls. Omit for an auto-height region. */
  maxHeight?: number | string;
  /** Caps the width and scrolls horizontally. */
  maxWidth?: number | string;
  /** Shows a fade at the scrolling edge. Default true. */
  fade?: boolean;
};

/**
 * ScrollArea — a region that scrolls on its own.
 *
 * A real scroll container with `overflow: auto`, so keyboard scrolling and screen-reader
 * navigation are the platform's. The fade is a decorative overlay and is `aria-hidden`.
 */
export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  { children, maxHeight, maxWidth, fade = true, className, style, theme = 'light' },
  ref,
) {
  return (
    <div
      ref={ref}
      className={['fc-scroll-area', className].filter(Boolean).join(' ')}
      style={{
        position: 'relative',
        overflow: 'auto',
        maxHeight,
        maxWidth,
        overscrollBehavior: 'contain',
        ...style,
      }}
    >
      {children}
      {fade ? (
        <span
          aria-hidden="true"
          style={{
            position: 'sticky',
            bottom: 0,
            left: 0,
            right: 0,
            display: 'block',
            height: 24,
            marginTop: -24,
            background: `linear-gradient(to top, ${cssVar('surface-primary')}, transparent)`,
            pointerEvents: 'none',
          }}
        />
      ) : null}
    </div>
  );
});

type StickyRegionProps = BaseProps & {
  /** Which edge to stick to. Default `top`. */
  edge?: 'top' | 'bottom';
  /** Offset from the edge, for a sticky region below a fixed header. */
  offset?: number;
  /** Raises the region above scrolling content. Default true. */
  elevated?: boolean;
};

/**
 * StickyRegion — a region that stays at an edge while content scrolls.
 *
 * Hierarchy comes from surface + border, NOT a shadow: the plan's primary elevation
 * mechanism. `elevated` paints the surface role and a border, which is what makes the
 * region read as "above" without a drop shadow.
 */
export const StickyRegion = forwardRef<HTMLDivElement, StickyRegionProps>(function StickyRegion(
  { children, edge = 'top', offset = 0, elevated = true, className, style, theme = 'light' },
  ref,
) {
  return (
    <div
      ref={ref}
      className={['fc-sticky-region', className].filter(Boolean).join(' ')}
      style={{
        position: 'sticky',
        [edge]: offset,
        zIndex: elevated ? 3 : undefined,
        background: elevated ? cssVar('surface-primary') : undefined,
        borderBottom: edge === 'top' && elevated ? `1px solid ${cssVar('border-default')}` : undefined,
        borderTop: edge === 'bottom' && elevated ? `1px solid ${cssVar('border-default')}` : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
});

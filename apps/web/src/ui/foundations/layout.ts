/**
 * foundations/layout.ts — the three grid families and the breakpoint scale.
 *
 * Frozen by the spec (§9). Three families because the product has three genuinely different
 * layout pressures:
 *
 *   - `product`    — 12-column dashboard/terminal surfaces, the default,
 *   - `editorial`  — a reading column with a support rail (blog, research),
 *   - `workspace`  — full-bleed panels with tight gaps (the trading workspace).
 *
 * Breakpoints are LAYOUT PRESSURE, not device names. `xs` means "below this the layout has
 * to change", not "this is a phone".
 *
 * Leaf module: imports only `@/styles/tokens`. No JSX, no React.
 */
import { breakpoint, grid } from '@/styles/tokens';

/** A breakpoint key. */
export type Breakpoint = keyof typeof breakpoint;
/** A grid family key. */
export type GridFamily = 'product' | 'editorial' | 'workspace';

/** The breakpoint scale in px. */
export const breakpoints = breakpoint;

/** The breakpoint keys, in declaration order. */
export const breakpointKeys: readonly Breakpoint[] = Object.keys(breakpoint) as Breakpoint[];

/** The raw grid constants. */
export const gridTokens = grid;

/** The product grid: 12 columns, 24px gutter, 24–32px desktop page padding. */
export const productGrid = {
  columns: grid['grid-columns'],
  gutter: grid['grid-gutter'],
  pageMin: grid['grid-page-min'],
  pageMax: grid['grid-page-max'],
} as const;

/** The editorial grid: a reading column, a support rail, a wide breakout. */
export const editorialGrid = {
  reading: grid['editorial-reading'],
  rail: grid['editorial-rail'],
  breakout: grid['editorial-breakout'],
} as const;

/** The workspace grid: full width, 16px minimum padding, 8–12px panel gaps. */
export const workspaceGrid = {
  pad: grid['workspace-pad'],
  gap: grid['workspace-gap'],
} as const;

/** All three families, keyed. */
export const grids = {
  product: productGrid,
  editorial: editorialGrid,
  workspace: workspaceGrid,
} as const;

/**
 * A media query for one breakpoint, min-width.
 *
 * `mq('lg')` is `(min-width: 1024px)`. The max-width form is the same breakpoint minus one
 * pixel, which is what "below lg" means without a second scale.
 */
export const mq = (bp: Breakpoint): string => `(min-width: ${breakpoint[bp]}px)`;

/** The max-width companion: everything strictly below `bp`. */
export const mqBelow = (bp: Breakpoint): string => `(max-width: ${breakpoint[bp] - 1}px)`;

/** The range between two breakpoints, inclusive of the lower bound. */
export const mqBetween = (from: Breakpoint, to: Breakpoint): string =>
  `(min-width: ${breakpoint[from]}px) and (max-width: ${breakpoint[to] - 1}px)`;

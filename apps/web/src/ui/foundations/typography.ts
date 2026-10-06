/**
 * foundations/typography.ts — the FUDCourt type scale as typed data.
 *
 * The scale is frozen by the spec (see docs/design-system/fudcourt-foundations-atoms-spec.md
 * §4). This module exposes it three ways so a consumer never re-derives it:
 *
 *   - `typeScale` — the raw variant table (size/line/weight/family),
 *   - `variant(v)` — one variant resolved to a ready-to-spread style object,
 *   - `numeric` / `tabular` — the numeric utilities the plan requires.
 *
 * THE MONO RULE: `data-*` variants are Geist Mono and tabular; every other variant is Plus
 * Jakarta Sans. Geist Mono is never applied to narrative numbers in article text — a
 * `body-*` variant stays sans even when the text is "3 of 4".
 *
 * Leaf module: imports only `@/styles/tokens`. No JSX, no React.
 */
import { fcType } from '@/styles/tokens';

/** A type-scale variant name. */
export type TypeVariant = keyof typeof fcType;
/** The family a variant renders in. */
export type TypeFamily = 'sans' | 'mono';

/** The frozen scale, in declaration order. */
export const typeScale = fcType;

/** Every variant name, in declaration order. */
export const typeVariants: readonly TypeVariant[] = Object.keys(fcType) as TypeVariant[];

/** The variants that render in Geist Mono — the financial/technical set. */
export const monoVariants: readonly TypeVariant[] = typeVariants.filter((v) => fcType[v].family === 'mono');

/** The variants that render in Plus Jakarta Sans — the UI set. */
export const sansVariants: readonly TypeVariant[] = typeVariants.filter((v) => fcType[v].family === 'sans');

/** A resolved variant: the four CSS properties a component needs to spread. */
export interface TypeStyle {
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
  fontWeight: number;
  fontVariantNumeric?: string;
}

/**
 * One variant resolved to a style object.
 *
 * `fontVariantNumeric` is set only for mono variants — that is the plan's "all
 * frequently-changing financial numerics use tabular-nums" rule, applied where it belongs
 * rather than globally on `body` (which would also tabularise narrative numbers).
 */
export function variant(v: TypeVariant): TypeStyle {
  const t = fcType[v];
  const style: TypeStyle = {
    fontFamily: t.family === 'mono' ? "var(--fc-font-mono)" : "var(--fc-font-sans)",
    fontSize: `var(--fc-type-${v}-size)`,
    lineHeight: `var(--fc-type-${v}-line)`,
    fontWeight: t.weight,
  };
  if (t.family === 'mono') style.fontVariantNumeric = 'tabular-nums';
  return style;
}

/** The class name for a variant, matching `src/styles/typography.css`. */
export const variantClass = (v: TypeVariant): string => `fc-${v}`;

/**
 * The numeric utility: tabular figures for any element carrying a frequently-changing
 * financial value.
 *
 * Applied on top of whatever variant the element already has, so a `body-md` paragraph that
 * happens to contain a price can opt that one span in without switching the family.
 */
export const numeric = {
  fontVariantNumeric: 'tabular-nums',
  fontFeatureSettings: "'tnum' 1",
} as const;

/** The class form of `numeric`, for hand-written CSS and Tailwind composition. */
export const tabular = 'fc-tabular';

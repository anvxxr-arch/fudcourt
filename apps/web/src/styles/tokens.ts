/**
 * Design tokens — the single source of truth (SSOT), Apple HIG semantic system.
 *
 * Second generation of this module: the first generation proved the migration
 * off three drifted sources value-for-value. This generation re-points every value at the Apple Human
 * Interface Guidelines system — semantic backgrounds/labels/separators with a `.dark`
 * flip, HIG accent ramps, the SF stack, the HIG type scale, an 8pt spacing grid,
 * continuous-corner radii, a 44pt touch target, HIG motion, and reduced-motion.
 * The pixel change is INTENTIONAL this time (green accent -> blue, dark-green
 * chrome -> system backgrounds); the gate that keeps it honest is still
 * `scripts/checks/check-design-tokens.py` (no raw literals outside this file,
 * no token without a consumer).
 *
 * NO INVENTED TOKENS — every value below has REAL consumers in the tree; a token
 * with no consumer fails the dead-token alarm. Tints stay derived: `alpha()` at
 * the bottom of this module. All colour tokens it receives must be `#rrggbb`
 * (the opaque HIG solids); `scrim` is the one rgba token and is never passed
 * to `alpha()` — it is used verbatim as the modal dim layer.
 *
 * DARK MODE: `color` holds the LIGHT (default `:root`) values; `darkColor` holds
 * the `.dark` overrides, key-for-key (`{ [K in keyof typeof color]: string }`,
 * so adding a light key without its dark twin is a compile error). `darkColor`
 * is deliberately NOT `as const` — the dead-token gate only parses `as const`
 * blocks, and the dark values are consumed by the emitter (into the `.dark`
 * block), never referenced as `darkColor.x` at call sites.
 *
 * Leaf module (DR-018): no imports, no JSX.
 */
export const color = {
  bgBase: '#FFFFFF',
  bgSecondary: '#F2F2F7',
  bgTertiary: '#E5E5EA',
  bgElevated: '#FFFFFF',
  labelPrimary: '#000000',
  labelSecondary: '#3C3C43',
  labelTertiary: '#636366',
  separator: '#C6C6C8',
  blue: '#0058C7',
  green: '#1E7E34',
  red: '#D70015',
  orange: '#B25000',
  labelOnAccent: '#FFFFFF',
  scrim: 'rgba(0, 0, 0, 0.35)',
} as const;
/**
 * The `.dark` flip of `color`, key-for-key (see header). Consumed by the emitter only.
 */
export const darkColor: { [K in keyof typeof color]: string } = {
  bgBase: '#000000',
  bgSecondary: '#1C1C1E',
  bgTertiary: '#2C2C2E',
  bgElevated: '#1C1C1E',
  labelPrimary: '#FFFFFF',
  labelSecondary: '#EBEBF5',
  labelTertiary: '#8E8E93',
  separator: '#38383A',
  blue: '#0A84FF',
  green: '#30D158',
  red: '#FF453A',
  orange: '#FF9F0A',
  labelOnAccent: '#FFFFFF',
  scrim: 'rgba(0, 0, 0, 0.6)',
};
/**
 * `color`, re-pointed at the CSS custom properties the emitter writes.
 *
 * WHY THIS EXISTS: `color` above holds the LIGHT hexes as literals, because the emitter
 * reads them to generate the `:root` block. But 68 files and ~821 inline styles consume
 * `color.bgBase` directly in React, and a literal baked into a `style` attribute is frozen
 * at build time — `.dark` on `<html>` cannot reach it. That is exactly why the header,
 * the nav bar and every page shell stayed white in dark mode while `body` and the
 * `--fc-*` variables flipped correctly.
 *
 * Re-pointing the values at `var(--fc-color-…)` makes every one of those call sites
 * theme-aware with ZERO source edits: the same `color.bgBase` expression now resolves
 * through the cascade, so `.dark` re-points it. This is the same mapping the emitter
 * already writes into `tailwind.tokens.json` (`tokensJson()`), so the two representations
 * cannot drift.
 *
 * `color` itself is untouched and remains the literal source of truth; `darkColor` remains
 * the `.dark` overrides. This view is the bridge for React consumers.
 */
export const themeColor: { [K in keyof typeof color]: string } = Object.fromEntries(
  Object.keys(color).map((k) => [k, `var(--fc-color-${k})`]),
) as { [K in keyof typeof color]: string };
/** px, 8pt grid + 4pt sub-step. */
export const space = { 0: 0, 4: 4, 8: 8, 12: 12, 16: 16, 20: 20, 24: 24, 32: 32, 40: 40 } as const;
/** px continuous corners, plus the `'50%'` keyword for round avatars/dots. */
export const radius = { 0: 0, 8: 8, 10: 10, 12: 12, 16: 16, 20: 20, circle: '50%' } as const;
/** px, HIG type scale (largeTitle 34 … caption2 11). */
export const fontSize = { 11: 11, 12: 12, 13: 13, 15: 15, 17: 17, 20: 20, 22: 22, 28: 28, 34: 34 } as const;
export const fontWeight = { regular: 400, medium: 500, semibold: 600, bold: 700 } as const;
/** unitless CSS ratios (not px). */
export const lineHeight = { tight: 1.3, normal: 1.6, loose: 1.7 } as const;
/** unitless (px at a 1px advance width). */
export const letterSpacing = { none: 0, xs: 0.4, sm: 0.5, wide: 1, wider: 2 } as const;
export const zIndex = { modal: 100 } as const;
export const fontFamily = { mono: 'ui-monospace, monospace', sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', Inter, ui-sans-serif, system-ui, sans-serif" } as const;
/** HIG motion: durations plus the standard easing curve. */
export const motion = { quick: '100ms', normal: '200ms', deliberate: '250ms', slow: '350ms', ease: 'cubic-bezier(0.32, 0.72, 0, 1)' } as const;
/** Minimum tappable target, px (HIG 44pt). */
export const target = { min: 44 } as const;
/**
 * FUDCourt token families (the FUDCourt Design System generation).
 *
 * These are ADDITIVE — the HIG families above stay exactly as they are, because 90 files
 * import them and a mass rename is a migration the plan explicitly forbids. The FUDCourt
 * families are a second, parallel palette consumed by `src/ui/foundations/` and
 * `src/ui/atoms/`; the two generations coexist and are emitted by the same generator into
 * the same `:root` / `.dark` blocks from this one source file.
 *
 * LAYERING (plan §2): primitive → semantic → component. `primitiveTokens` holds the raw
 * ramps; `semanticTokens` maps primitives to roles and is the ONLY layer an atom may read;
 * `componentTokens` holds per-component dimensions. `designTokens` is the flat union the
 * emitter walks.
 *
 * LIGHT/DARK PARITY: every semantic token exists in both themes with the SAME key, so
 * `lightSemanticKeys === darkSemanticKeys` is checkable at runtime (Task 4's parity test).
 * The type-level guarantee is `{ [K in keyof typeof lightSemantic]: string }`.
 */
// ---------------------------------------------------------------------------
// Primitive ramps (plan §6, §7, §8) — the only place a raw hex is written.
// ---------------------------------------------------------------------------
/** Brand orange ramp. `500` is canonical brand. Orange is brand/action, NEVER warning. */
export const orangeRamp = {
  'orange-50': '#FFF4EC',
  'orange-100': '#FFE5D1',
  'orange-200': '#FFC79E',
  'orange-300': '#FFA267',
  'orange-400': '#F57E35',
  'orange-500': '#E86A17',
  'orange-600': '#C95710',
  'orange-700': '#9F430D',
  'orange-800': '#79340F',
  'orange-900': '#5F2C10',
  'orange-950': '#341507',
} as const;
/** Warm graphite ramp. Never substitute zinc/slate/gray inside design-system components. */
export const neutralRamp = {
  'neutral-0': '#FFFFFF',
  'neutral-50': '#FAF9F7',
  'neutral-100': '#F3F1EE',
  'neutral-200': '#E6E2DE',
  'neutral-300': '#D3CEC8',
  'neutral-400': '#AAA39B',
  'neutral-500': '#817A73',
  'neutral-600': '#625C56',
  'neutral-700': '#48433E',
  'neutral-800': '#312E2B',
  'neutral-850': '#272421',
  'neutral-900': '#1E1C1A',
  'neutral-925': '#181614',
  'neutral-950': '#11100F',
  'neutral-1000': '#090908',
} as const;
/**
 * Market semantic base colours. Muted for portfolio/research/analytics/summary surfaces;
 * vivid ONLY for live ticks, orderbook, execution state, urgent signals, critical alerts.
 */
export const marketRamp = {
  'positive-muted': '#3F8F68',
  'positive-vivid': '#22C55E',
  'negative-muted': '#B85C5C',
  'negative-vivid': '#EF4444',
  'warning-muted': '#AF823B',
  'warning-vivid': '#F59E0B',
  'info-muted': '#4E7FA8',
  'info-vivid': '#3B82F6',
} as const;
/**
 * AAA critical foregrounds (~7:1 target). Theme-aware: the light set is tuned against
 * `neutral-50`/`neutral-0`/`neutral-100`, the dark set against `neutral-1000`/`neutral-950`/
 * `neutral-925`/`neutral-900`. Contrast tests are authoritative — if the rendered
 * background drops below target the CRITICAL variant is adjusted, never the base palette.
 */
export const criticalLight = {
  'positive-critical': '#285A42',
  'negative-critical': '#7C3E3E',
  'warning-critical': '#674C23',
  'info-critical': '#33546E',
  'brand-critical': '#833C0D',
} as const;
export const criticalDark = {
  'positive-critical': '#7CB399',
  'negative-critical': '#D29999',
  'warning-critical': '#C7A166',
  'info-critical': '#8BACC6',
  'brand-critical': '#EE9154',
} as const;
/** Every primitive ramp, flattened. The emitter and the contrast tests both walk this. */
export const primitiveTokens = {
  ...orangeRamp,
  ...neutralRamp,
  ...marketRamp,
  ...criticalLight,
} as const;
// ---------------------------------------------------------------------------
// Semantic theme layer (plan §9) — the ONLY colour layer an atom may read.
// ---------------------------------------------------------------------------
/**
 * Light theme. Values are primitive token NAMES, not hex: the emitter resolves them, so a
 * component never sees `neutral-925` or `orange-600`. The `*-subtle` roles carry a literal
 * rgba tint, which is the one place a derived colour is written down.
 */
export const lightSemantic = {
  background: 'neutral-50',
  'surface-primary': 'neutral-0',
  'surface-secondary': 'neutral-100',
  'surface-raised': 'neutral-0',
  'surface-overlay': 'neutral-0',
  'text-primary': 'neutral-950',
  'text-secondary': 'neutral-600',
  'text-muted': 'neutral-600',
  'text-disabled': 'neutral-400',
  'text-inverse': 'neutral-0',
  'border-subtle': 'neutral-100',
  'border-default': 'neutral-200',
  'border-strong': 'neutral-500',
  'border-focus': 'orange-500',
  'brand-primary': 'orange-500',
  'brand-hover': 'orange-600',
  'brand-pressed': 'orange-700',
  'brand-subtle': 'orange-50',
  'brand-border': 'orange-200',
  'brand-foreground': 'neutral-1000',
  positive: 'positive-muted',
  'positive-subtle': 'rgba(63, 143, 104, 0.12)',
  'positive-strong': 'positive-vivid',
  'positive-live': 'positive-vivid',
  'positive-critical': 'positive-critical',
  negative: 'negative-muted',
  'negative-subtle': 'rgba(184, 92, 92, 0.12)',
  'negative-strong': 'negative-vivid',
  'negative-live': 'negative-vivid',
  'negative-critical': 'negative-critical',
  warning: 'warning-muted',
  'warning-subtle': 'rgba(175, 130, 59, 0.12)',
  'warning-strong': 'warning-vivid',
  'warning-critical': 'warning-critical',
  info: 'info-muted',
  'info-subtle': 'rgba(78, 127, 168, 0.12)',
  'info-strong': 'info-vivid',
  'info-critical': 'info-critical',
  'brand-critical': 'brand-critical',
  'focus-ring': 'orange-500',
  selection: 'orange-100',
  scrim: 'neutral-1000',
} as const;
/** Dark theme — the SAME keys as `lightSemantic`, mapped to dark-appropriate primitives. */
export const darkSemantic: { [K in keyof typeof lightSemantic]: string } = {
  background: 'neutral-1000',
  'surface-primary': 'neutral-950',
  'surface-secondary': 'neutral-925',
  'surface-raised': 'neutral-900',
  'surface-overlay': 'neutral-900',
  'text-primary': 'neutral-50',
  'text-secondary': 'neutral-400',
  'text-muted': 'neutral-400',
  'text-disabled': 'neutral-600',
  'text-inverse': 'neutral-950',
  'border-subtle': 'neutral-900',
  'border-default': 'neutral-850',
  'border-strong': 'neutral-400',
  'border-focus': 'orange-400',
  'brand-primary': 'orange-500',
  'brand-hover': 'orange-400',
  'brand-pressed': 'orange-300',
  'brand-subtle': 'orange-950',
  'brand-border': 'orange-800',
  'brand-foreground': 'neutral-1000',
  positive: 'positive-muted',
  'positive-subtle': 'rgba(63, 143, 104, 0.18)',
  'positive-strong': 'positive-vivid',
  'positive-live': 'positive-vivid',
  'positive-critical': 'positive-critical',
  negative: 'negative-muted',
  'negative-subtle': 'rgba(184, 92, 92, 0.18)',
  'negative-strong': 'negative-vivid',
  'negative-live': 'negative-vivid',
  'negative-critical': 'negative-critical',
  warning: 'warning-muted',
  'warning-subtle': 'rgba(175, 130, 59, 0.18)',
  'warning-strong': 'warning-vivid',
  'warning-critical': 'warning-critical',
  info: 'info-muted',
  'info-subtle': 'rgba(78, 127, 168, 0.18)',
  'info-strong': 'info-vivid',
  'info-critical': 'info-critical',
  'brand-critical': 'brand-critical',
  'focus-ring': 'orange-400',
  selection: 'orange-950',
  scrim: 'neutral-1000',
};
/** Both themes, keyed for iteration. The parity test asserts the key sets are identical. */
export const semanticTokens = { light: lightSemantic, dark: darkSemantic } as const;
// ---------------------------------------------------------------------------
// Spacing / radius / elevation / density / motion / grid (plan §11–§16)
// ---------------------------------------------------------------------------
/** 8pt-first with 4px micro increments. `2px` is exceptional. */
export const fcSpace = {
  'space-0': 0,
  'space-half': 2,
  'space-1': 4,
  'space-2': 8,
  'space-3': 12,
  'space-4': 16,
  'space-5': 20,
  'space-6': 24,
  'space-8': 32,
  'space-10': 40,
  'space-12': 48,
  'space-16': 64,
  'space-20': 80,
  'space-24': 96,
} as const;
/** Soft institutional radius. `full` is for avatar/status dot/small metadata badge only. */
export const fcRadius = {
  'radius-xs': 4,
  'radius-sm': 6,
  'radius-md': 8,
  'radius-lg': 12,
  'radius-xl': 16,
  'radius-full': 9999,
} as const;
/**
 * Elevation is border-first. Only two shadows exist (floating, overlay); a normal
 * card/panel carries NONE. Hierarchy is surface + border + spacing.
 */
export const elevation = {
  'elevation-0': 'none',
  'elevation-1': 'none',
  'elevation-2': 'none',
  'elevation-3': '0 4px 16px rgba(9, 9, 8, 0.12), 0 1px 3px rgba(9, 9, 8, 0.08)',
  'elevation-4': '0 16px 48px rgba(9, 9, 8, 0.24), 0 2px 8px rgba(9, 9, 8, 0.12)',
} as const;
/**
 * Density contracts. Consumers READ these dimensions; there are no
 * CompactTable/DefaultTable/ComfortableTable forks.
 */
export const density = {
  control: { compact: 28, default: 32, comfortable: 36 },
  row: { compact: 32, default: 40, comfortable: 48 },
  field: { compact: 28, default: 40, comfortable: 48 },
  gap: { compact: 8, default: 12, comfortable: 16 },
  pad: { compact: 8, default: 12, comfortable: 16 },
} as const;
/** Minimal utility motion. Never `transition-all` as a design-system default. */
export const fcMotion = {
  'motion-instant': 80,
  'motion-fast': 120,
  'motion-base': 160,
  'motion-slow': 220,
  'motion-panel': 280,
  'ease-standard': 'cubic-bezier(0.2, 0, 0, 1)',
  'ease-enter': 'cubic-bezier(0, 0, 0.2, 1)',
  'ease-exit': 'cubic-bezier(0.4, 0, 1, 1)',
  'realtime-flash': 200,
} as const;
/** Breakpoints are layout pressure, not device names. */
export const breakpoint = {
  xs: 480,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1440,
  '3xl': 1600,
} as const;
/** Three layout families (plan §15). */
export const grid = {
  'grid-columns': 12,
  'grid-gutter': 24,
  'grid-page-min': 24,
  'grid-page-max': 32,
  'editorial-reading': 720,
  'editorial-rail': 300,
  'editorial-breakout': 1200,
  'workspace-pad': 16,
  'workspace-gap': 12,
} as const;
/** Canonical typography for the FUDCourt generation (plan §10). */
export const fcFontFamily = {
  'font-sans': "'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif",
  'font-mono': "'Geist Mono', ui-monospace, monospace",
} as const;
/**
 * Type scale. `line` is the line-height in px, `weight` the numeric weight, `family`
 * `'sans' | 'mono'`. Every `data-*` variant is mono + tabular.
 */
export const fcType = {
  'display-xl': { size: 48, line: 56, weight: 700, family: 'sans' },
  'display-lg': { size: 40, line: 48, weight: 700, family: 'sans' },
  'heading-xl': { size: 32, line: 40, weight: 650, family: 'sans' },
  'heading-lg': { size: 24, line: 32, weight: 650, family: 'sans' },
  'heading-md': { size: 20, line: 28, weight: 600, family: 'sans' },
  'heading-sm': { size: 16, line: 24, weight: 600, family: 'sans' },
  'body-lg': { size: 16, line: 26, weight: 400, family: 'sans' },
  'body-md': { size: 14, line: 22, weight: 400, family: 'sans' },
  'body-sm': { size: 13, line: 20, weight: 400, family: 'sans' },
  'label-lg': { size: 14, line: 20, weight: 600, family: 'sans' },
  'label-md': { size: 13, line: 18, weight: 600, family: 'sans' },
  'label-sm': { size: 12, line: 16, weight: 600, family: 'sans' },
  'data-display': { size: 32, line: 40, weight: 600, family: 'mono' },
  'data-lg': { size: 20, line: 28, weight: 550, family: 'mono' },
  'data-md': { size: 14, line: 20, weight: 500, family: 'mono' },
  'data-sm': { size: 12, line: 18, weight: 500, family: 'mono' },
  'data-xs': { size: 11, line: 16, weight: 500, family: 'mono' },
} as const;
/** Icon sizes (plan §18). 16–20px is the default application size. */
export const iconSize = {
  'icon-xs': 12,
  'icon-sm': 14,
  'icon-md': 16,
  'icon-lg': 18,
  'icon-xl': 20,
  'icon-2xl': 24,
  'icon-3xl': 32,
} as const;
/**
 * Component tokens (plan §2, layer 3). Per-component dimensions so an atom reads a named
 * component token rather than picking a primitive by hand.
 */
export const componentTokens = {
  'button-height-xs': 28,
  'button-height-sm': 32,
  'button-height-md': 40,
  'button-height-lg': 48,
  'button-height-xl': 56,
  'input-height-sm': 32,
  'input-height-md': 40,
  'input-height-lg': 48,
  'focus-ring-width': 2,
  'focus-ring-offset': 2,
  'sparkline-sm-width': 64,
  'sparkline-sm-height': 24,
  'sparkline-md-width': 96,
  'sparkline-md-height': 32,
  'sparkline-lg-width': 128,
  'sparkline-lg-height': 40,
} as const;
/** The flat union the emitter walks, in emission order. */
export const designTokens = {
  ...primitiveTokens,
  ...fcSpace,
  ...fcRadius,
  ...elevation,
  ...fcMotion,
  ...breakpoint,
  ...grid,
  ...fcFontFamily,
  ...iconSize,
  ...componentTokens,
} as const;
/**
 * A token colour's tint: `#rrggbb` + alpha → `rgba(r,g,b,a)`.
 *
 * The ONLY sanctioned way to make a tint of a token. An `rgba()` literal in a
 * component is a gate violation; `alpha(color.red, 0.08)` is not. Alpha is
 * clamped to [0,1]; anything other than a 6-digit `#rrggbb` throws, so a typo
 * surfaces at the call site rather than as a transparent box in production.
 * Never called with `color.scrim` (already rgba — used verbatim).
 *
 * A `var(--fc-color-…)` reference is accepted too, because `themeColor` hands those out
 * instead of literals. A var cannot be decomposed into channels at build time, so the tint
 * is expressed as `color-mix(in srgb, <var> <pct>%, transparent)` — the browser resolves it
 * at paint time, which also means the tint follows the `.dark` flip rather than freezing the
 * light channel values into the stylesheet.
 */
export function alpha(hex: string, a: number): string {
  const clamped = Math.min(1, Math.max(0, a));
  if (hex.startsWith('var(')) {
    return `color-mix(in srgb, ${hex} ${Math.round(clamped * 100)}%, transparent)`;
  }
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) throw new Error('alpha(): expected a #rrggbb colour, got ' + hex);
  const value = parseInt(match[1], 16);
  return 'rgba(' + ((value >> 16) & 0xff) + ', ' + ((value >> 8) & 0xff) + ', ' + (value & 0xff) + ', ' + clamped + ')';
}

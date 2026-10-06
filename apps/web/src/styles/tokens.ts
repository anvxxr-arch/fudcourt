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
/** `.dark` flip of `color`, key-for-key (see header). Consumed by the emitter only. */
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
 * A token colour's tint: `#rrggbb` + alpha → `rgba(r,g,b,a)`.
 *
 * The ONLY sanctioned way to make a tint of a token. An `rgba()` literal in a
 * component is a gate violation; `alpha(color.red, 0.08)` is not. Alpha is
 * clamped to [0,1]; anything other than a 6-digit `#rrggbb` throws, so a typo
 * surfaces at the call site rather than as a transparent box in production.
 * Never called with `color.scrim` (already rgba — used verbatim).
 */
export function alpha(hex: string, a: number): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) throw new Error('alpha(): expected a #rrggbb colour, got ' + hex);
  const value = parseInt(match[1], 16);
  const clamped = Math.min(1, Math.max(0, a));
  return 'rgba(' + ((value >> 16) & 0xff) + ', ' + ((value >> 8) & 0xff) + ', ' + (value & 0xff) + ', ' + clamped + ')';
}

/**
 * Design tokens — the single source of truth (SSOT) for every visual value in the web app.
 *
 * Before this module the design values lived in three places that could drift: `C` in
 * `src/styles/shared.ts` (flat hex), a separate HSL `:root` set in
 * `src/app/(frontend)/globals.css` (which did NOT match `C` — every one of the seven
 * comparable pairs had drifted), and `tailwind.config.js` (`theme.extend` empty, so no
 * utility class could reach a token at all). Feature UIs additionally hand-rolled raw hex
 * (`#ffd166`, `#ff9f43`, `#04140f`, rgba overlays), magic font sizes, paddings and radii.
 * This module is the one place those values are written down.
 *
 * NO INVENTED TOKENS — the rule this module is governed by. Every value below is one that
 * already has (or, for the colours the migration is re-pointing, is about to gain) REAL
 * consumers in the tree; a token with no consumer is drift in the other direction and the
 * `check-design-tokens.py` dead-token alarm fails the build for it. Adding a token is
 * therefore a two-part change: the value here AND the call site that uses it. ("I need a TINT
 * of an existing token" is not a reason to add one — that is `alpha()` at the bottom of this
 * module, which derives the tint from the token instead of minting a near-duplicate of it.)
 *
 * WHY THE SCALES ARE KEYED BY THEIR OWN VALUE (`space[12] === 12`, `fontSize[13] === 13`):
 * the migration off the three drifted sources is value-for-value — `fontSize: 13` becomes
 * `fontSize: fontSize[13]`, `padding: '10px 18px'` becomes `padding: \`${space[10]}px ${space[18]}px\``.
 * No rounding, no rem conversion, no re-tint: the rendered pixels are provably unchanged, so
 * a visual regression can only come from a mistake in the migration, never from the token
 * table. `radius.full` (9999) is the one value written for its MEANING (the pill/circle
 * sentinel that `borderRadius: 9999` already used) rather than for its arithmetic.
 *
 * WHAT IS DELIBERATELY NOT HERE: the domain palettes (`CHAIN_COLOR`, `COLOR_PRESETS` in
 * `src/styles/shared.ts`) are DATA, not design chrome — provider/brand colours and the
 * user's own wallet swatch choices — and the status-colour maps that key off them stay
 * with their domain. The legacy `C` object is likewise retained until the migration
 * cutover; this module does not re-export it.
 *
 * Leaf module (DR-018): no imports, no JSX, `as const` everywhere so every key and value is
 * a literal type — a typo'd `color.bg2` is a compile error, and the emitted CSS
 * (`scripts/design/emit-tokens.ts`) reads these exact keys.
 */
export const color = {
  bg: '#07110f',
  surface: '#0d1f1a',
  border: '#1c3a31',
  text: '#e8fff7',
  textMuted: '#6b8f82',
  textOnAccent: '#04140f',
  textInverse: '#ffffff',
  accent: '#3ddc97',
  positive: '#3ddc97',
  negative: '#ff6b6b',
  warn: '#ffd166',
  attention: '#ff9f43',
  overlay: 'rgba(0,0,0,0.8)',
} as const;

/** px, key === value (see the header: the migration is value-for-value). */
export const space = { 0: 0, 4: 4, 6: 6, 8: 8, 10: 10, 12: 12, 14: 14, 16: 16, 18: 18, 20: 20, 24: 24, 28: 28, 30: 30, 32: 32, 40: 40 } as const;

/**
 * px, key === value, plus two specials: `full` (9999) is the pill sentinel already in use as
 * `borderRadius: 9999`, and `circle` is the `'50%'` keyword used for round avatars and dots — a
 * keyword, not a scale value, which is why it stays a string.
 */
export const radius = { 0: 0, 4: 4, 6: 6, 8: 8, 10: 10, 12: 12, 14: 14, full: 9999, circle: '50%' } as const;

/** px, key === value. */
export const fontSize = { 9: 9, 10: 10, 11: 11, 12: 12, 13: 13, 14: 14, 16: 16, 18: 18, 20: 20, 24: 24, 32: 32, 40: 40 } as const;

export const fontWeight = { regular: 400, medium: 500, semibold: 600, bold: 700, heavy: 800 } as const;

/** unitless CSS ratios (not px). */
export const lineHeight = { tight: 1.3, snug: 1.4, relaxed: 1.5, normal: 1.6, loose: 1.7 } as const;

/** unitless (px at a 1px advance width). */
export const letterSpacing = { none: 0, xs: 0.4, sm: 0.5, wide: 1, wider: 2 } as const;

export const zIndex = { modal: 100 } as const;

export const fontFamily = { mono: 'ui-monospace, monospace', sans: 'Inter, ui-sans-serif, system-ui, sans-serif' } as const;

/**
 * A token colour's tint: `#rrggbb` + alpha → `rgba(r,g,b,a)`.
 *
 * This is the ONLY sanctioned way to make a tint of a token. The palette is deliberately flat hex
 * (no alpha channel), so before this helper every tint was hand-spelled inline — and the same tint
 * spelled twice had already drifted (`#ff6b6b` vs `rgba(255,80,80,…)`, both meant "negative at
 * low alpha"). An `rgba()` literal in a component is a gate violation; `alpha(color.negative, 0.08)`
 * is not. Alpha is clamped to [0,1]; anything other than a 6-digit `#rrggbb` throws, so a typo
 * surfaces at the call site rather than as a transparent box in production.
 */
export function alpha(hex: string, a: number): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) throw new Error(`alpha(): expected a #rrggbb colour, got '${hex}'`);
  const value = parseInt(match[1], 16);
  const clamped = Math.min(1, Math.max(0, a));
  return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${clamped})`;
}

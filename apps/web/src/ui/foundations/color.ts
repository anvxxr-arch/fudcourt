/**
 * foundations/color.ts — the semantic colour layer, resolved for the current theme.
 *
 * This is the ONLY colour module an atom may import. It exists so a component never learns
 * which primitive a role is: `surface.primary` is `neutral-0` in light and `neutral-950` in
 * dark, and the component does not care which.
 *
 * WHY IT READS `tokens.ts` RATHER THAN CSS VARS: the app's house style is inline `style`
 * objects with token values (see docs/architecture/DESIGN-SYSTEM.md), and a React component
 * needs a real colour string at render time. The CSS custom properties emitted into
 * `globals.css` are the runtime surface for hand-written CSS and Tailwind utilities; this
 * module is the typed surface for TSX. Both are generated from the same source, so they
 * cannot disagree.
 *
 * THEME RESOLUTION: `theme()` returns the resolved map for one theme. The default is
 * `light`; a consumer inside a `.dark` subtree passes `'dark'`. There is no ambient
 * "current theme" singleton — that would make a component's output depend on import order
 * and break SSR. The app's theme is class-based (`layout.tsx` toggles `.dark` on `<html>`),
 * so a component that must follow the class reads the CSS var instead (see `cssVar`).
 *
 * Leaf module: imports only `@/styles/tokens`. No JSX, no React, no feature code.
 */
import {
  criticalDark,
  criticalLight,
  darkSemantic,
  lightSemantic,
  marketRamp,
  neutralRamp,
  orangeRamp,
  primitiveTokens,
  type fcType,
} from '@/styles/tokens';

/** A semantic role name, as declared in `lightSemantic` / `darkSemantic`. */
export type SemanticToken = keyof typeof lightSemantic;
/** A primitive ramp key, as declared in the ramps. */
export type PrimitiveToken = keyof typeof primitiveTokens;

/**
 * The primitive ramps, re-exported under their own names so a consumer that genuinely
 * needs a raw ramp (a chart's categorical scale, a legend swatch) reads it from here rather
 * than reaching past the semantic layer into `tokens.ts`.
 */
export const primitive = {
  orange: orangeRamp,
  neutral: neutralRamp,
  market: marketRamp,
  criticalLight,
  criticalDark,
} as const;

/**
 * Resolve one semantic role to a concrete colour for one theme.
 *
 * A role may name a primitive ramp entry (`'neutral-0'`) or carry a literal tint
 * (`'rgba(63, 143, 104, 0.12)'`). A literal is returned as written; a name is looked up in
 * the ramp, with the critical foregrounds resolved per theme because they are the one ramp
 * whose values differ between light and dark.
 */
export function resolve(role: SemanticToken, theme: Theme = 'light'): string {
  const name = theme === 'dark' ? darkSemantic[role] : lightSemantic[role];
  if (name.startsWith('rgba(') || name.startsWith('rgb(')) return name;
  const ramp: Record<string, string> =
    theme === 'dark' ? { ...primitiveTokens, ...criticalDark } : { ...primitiveTokens, ...criticalLight };
  const hex = ramp[name];
  if (hex === undefined) {
    throw new Error(`foundations/color: semantic role '${role}' (${theme}) names no primitive '${name}'`);
  }
  return hex;
}

/** The two first-class themes. Equal by construction: the same roles, different mappings. */
export type Theme = 'light' | 'dark';

/** Every semantic role, resolved for one theme. */
export function theme(which: Theme = 'light'): Record<SemanticToken, string> {
  const out = {} as Record<SemanticToken, string>;
  for (const role of Object.keys(lightSemantic) as SemanticToken[]) out[role] = resolve(role, which);
  return out;
}

/** Both themes, keyed. The parity test asserts these two objects share a key set. */
export const themes: Record<Theme, Record<SemanticToken, string>> = {
  light: theme('light'),
  dark: theme('dark'),
};

/** The role names, in declaration order. Used by the parity test and the docs. */
export const semanticRoles: readonly SemanticToken[] = Object.keys(lightSemantic) as SemanticToken[];

/**
 * The CSS custom property for a semantic role: `surface-primary` → `var(--fc-surface-primary)`.
 *
 * This is the form a component uses when it must follow the `.dark` class rather than a
 * prop-threaded theme — a `<body>`-level surface, a portal target, anything rendered outside
 * the React tree that knows the theme. The var is emitted by `emit-tokens.ts` into both the
 * `:root` and `.dark` blocks, so the browser resolves it.
 */
export function cssVar(role: SemanticToken): string {
  return `var(--fc-${role})`;
}

/**
 * A tint of a semantic role, derived rather than minted.
 *
 * The `*-subtle` roles already carry their own tint values, so this is for the case where a
 * component needs a different alpha of the same hue (a hover wash, a selected row). It
 * accepts only a `#rrggbb` primitive, so a typo surfaces at the call site.
 */
export function tint(hex: string, a: number): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) throw new Error(`foundations/color.tint(): expected a #rrggbb colour, got '${hex}'`);
  const value = parseInt(match[1], 16);
  const clamped = Math.min(1, Math.max(0, a));
  return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${clamped})`;
}

/** The type-scale variant names, re-exported so a consumer types against one module. */
export type TypeVariant = keyof typeof fcType;

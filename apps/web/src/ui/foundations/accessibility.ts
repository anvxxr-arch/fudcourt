/**
 * foundations/accessibility.ts — the accessibility contract as data.
 *
 * Frozen by the spec (§11): WCAG 2.2 AA globally, AAA for critical financial foregrounds.
 * This module holds the numbers a test asserts against and the utilities a component
 * composes with. The CSS lives in `src/styles/accessibility.css`; this is the typed surface.
 *
 * The two rules that matter most and are easiest to get wrong:
 *
 *   1. MEANING IS NEVER COLOUR-ONLY. A positive delta carries an arrow and a sign, not just
 *      a green. `nonColorCues` is the vocabulary for that.
 *   2. FOCUS IS NEVER REMOVED. `focusRing` is the replacement, and it is equal-or-better
 *      than the browser default (2px, 2px offset, ≥3:1 against both theme backgrounds).
 *
 * No custom keyboard mechanics are introduced here: the app's primitives are real
 * `<button>`/`<input>`/`<select>` elements, so native keyboard behaviour is already correct
 * and a second implementation would be a second thing to keep correct.
 *
 * Leaf module: imports only `@/styles/tokens`. No JSX, no React.
 */
import { componentTokens } from '@/styles/tokens';

/** The contrast targets, as ratios. */
export const contrastTargets = {
  /** Normal critical financial text. */
  criticalText: 7,
  /** Large critical financial text. */
  criticalTextLarge: 4.5,
  /** AA baseline for normal text. */
  aaText: 4.5,
  /** AA baseline for large text. */
  aaTextLarge: 3,
  /** UI boundaries and the focus indicator. */
  uiBoundary: 3,
} as const;

/** The focus indicator: 2px ring, 2px offset, in the theme's focus colour. */
export const focusRing = {
  outlineWidth: `${componentTokens['focus-ring-width']}px`,
  outlineOffset: `${componentTokens['focus-ring-offset']}px`,
  outlineStyle: 'solid',
  outlineColor: 'var(--fc-focus-ring)',
} as const;

/** The class that applies `focusRing`. */
export const focusRingClass = 'fc-focus-ring';

/**
 * The screen-reader-only utility.
 *
 * Content stays in the accessibility tree but leaves the visual layout. `display: none` and
 * `visibility: hidden` would remove it from the tree, which is the bug this prevents — an
 * icon-only button with no accessible name is unreachable, not merely invisible.
 */
export const srOnly = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  borderWidth: 0,
} as const;

/** The class form of `srOnly`. */
export const srOnlyClass = 'fc-sr-only';

/** The class that forces a system-colour border under Windows high contrast. */
export const forcedBorderClass = 'fc-forced-border';

/** The class marking a control as disabled (dimmed, unclickable, untabbable). */
export const disabledClass = 'fc-disabled';

/**
 * The non-colour cues that must accompany a colour-coded state.
 *
 * The plan's examples: `↑ +2.41%`, `Failed + icon`, `Delayed + status label`. A direction
 * carries an arrow AND a sign; a failure carries an icon AND a word. This is the vocabulary
 * a component reaches for so the cue is never forgotten.
 */
export const nonColorCues = {
  up: '↑',
  down: '↓',
  flat: '→',
  positiveSign: '+',
  negativeSign: '−',
} as const;

/** The keys every actionable atom must support, where applicable. */
export const keyboardKeys = [
  'Tab',
  'Shift+Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Enter',
  'Space',
  'Escape',
  'Home',
  'End',
] as const;

/** An `aria-live` politeness level for a region whose content changes without a focus move. */
export type LivePoliteness = 'off' | 'polite' | 'assertive';

/**
 * The `aria-live` value for a live financial value.
 *
 * `polite`, never `assertive`: a price that changed is worth announcing, but it must not
 * interrupt a screen-reader user mid-sentence. A value that represents a FAILURE (an
 * execution rejection, a provider outage) is the case for `assertive`, and it is the
 * caller's decision — this module only names the two levels so the choice is explicit.
 */
export const livePoliteness: Record<'update' | 'failure', LivePoliteness> = {
  update: 'polite',
  failure: 'assertive',
};

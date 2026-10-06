/**
 * foundations/motion.ts — the FUDCourt motion presets as typed data.
 *
 * Frozen by the spec (§10): minimal, utility-first, fast, predictable, non-distracting.
 * Five presets, each naming the properties it animates — `transition-all` is not a
 * design-system default and is not reachable from here.
 *
 * The realtime preset is the one with a behavioural contract: a semantic flash of 150–250ms
 * then back to neutral. Live trading numbers are never animated like slot-machine wheels.
 *
 * Leaf module: imports only `@/styles/tokens`. No JSX, no React.
 */
import { fcMotion } from '@/styles/tokens';

/** A motion preset name. */
export type MotionPreset = 'interactive' | 'overlay' | 'navigation' | 'realtime' | 'panel';

/** The frozen durations, easings and the realtime flash length. */
export const motionTokens = fcMotion;

/** A resolved preset: the properties it animates, for how long, on which curve. */
export interface Preset {
  transitionProperty: string;
  transitionDuration: string;
  transitionTimingFunction: string;
}

/**
 * The five presets.
 *
 * Each names its properties explicitly. A preset that animated `all` would let a hover
 * quietly animate a layout property, which is both a performance bug and the "distracting"
 * the philosophy rules out.
 */
export const presets: Record<MotionPreset, Preset> = {
  // A control answering pointer/focus. Colour and shadow only — never geometry.
  interactive: {
    transitionProperty: 'background-color, border-color, color, box-shadow, opacity',
    transitionDuration: 'var(--fc-motion-fast)',
    transitionTimingFunction: 'var(--fc-ease-standard)',
  },
  // A popover or dialog entering and leaving.
  overlay: {
    transitionProperty: 'opacity, transform',
    transitionDuration: 'var(--fc-motion-panel)',
    transitionTimingFunction: 'var(--fc-ease-enter)',
  },
  // A view or panel swap.
  navigation: {
    transitionProperty: 'opacity, transform',
    transitionDuration: 'var(--fc-motion-base)',
    transitionTimingFunction: 'var(--fc-ease-standard)',
  },
  // The live-value flash. Short by contract.
  realtime: {
    transitionProperty: 'background-color, color',
    transitionDuration: 'var(--fc-realtime-flash)',
    transitionTimingFunction: 'var(--fc-ease-standard)',
  },
  // A resizable or collapsible region settling.
  panel: {
    transitionProperty: 'width, height, flex-basis, transform',
    transitionDuration: 'var(--fc-motion-panel)',
    transitionTimingFunction: 'var(--fc-ease-standard)',
  },
};

/** The preset names, in declaration order. */
export const presetKeys: readonly MotionPreset[] = Object.keys(presets) as MotionPreset[];

/** The class form of a preset, matching `src/styles/motion.css`. */
export const presetClass = (p: MotionPreset): string => `fc-motion-${p}`;

/** The reduced-motion media query every preset must honour. */
export const reducedMotionQuery = '@media (prefers-reduced-motion: reduce)';

/**
 * atoms/visualization/sparkline.tsx — a tiny inline trend line.
 *
 * Sizes sm 64×24 / md 96×32 / lg 128×40, opt-in tooltip. The plan lists it separately from
 * the chart primitives because it is the one visualization that lives inline in a table cell
 * or a stat block rather than in a plot.
 *
 * The existing `src/ui/sparkline.tsx` is the LEGACY implementation. It is left untouched —
 * this is the design-system generation, and migrating its call sites is out of scope.
 */
import { forwardRef } from 'react';
import { cssVar } from '@/ui/foundations/color';
import { componentTokens } from '@/styles/tokens';
import { nonColorCues } from '@/ui/foundations/accessibility';

/** A sparkline size. */
export type SparklineSize = 'sm' | 'md' | 'lg';

/** The dimensions per size. */
const SIZE: Record<SparklineSize, { w: number; h: number }> = {
  sm: { w: componentTokens['sparkline-sm-width'], h: componentTokens['sparkline-sm-height'] },
  md: { w: componentTokens['sparkline-md-width'], h: componentTokens['sparkline-md-height'] },
  lg: { w: componentTokens['sparkline-lg-width'], h: componentTokens['sparkline-lg-height'] },
};

type SparklineProps = {
  /** The series. `null` entries are gaps, not zeros. */
  points: (number | null)[];
  size?: SparklineSize;
  /** Overrides the derived width. */
  width?: number;
  /** Overrides the derived height. */
  height?: number;
  /**
   * Shows a tooltip with the first and last value. Opt-in: a tooltip on every row of a
   * 200-row table is 200 hover targets.
   */
  tooltip?: boolean;
  /** Accessible name. Required — a line with no name is a squiggle. */
  label: string;
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * Sparkline — a tiny trend line.
 *
 * Fewer than two finite points renders the em dash, NOT a flat line: a flat line asserts
 * "no change", and a series with one point has said nothing about change.
 *
 * The direction cue is an arrow in the accessible name, so the trend survives without colour.
 */
export const Sparkline = forwardRef<HTMLSpanElement, SparklineProps>(function Sparkline(
  { points, size = 'md', width, height, tooltip, label, className, style, theme = 'light' },
  ref,
) {
  const dims = SIZE[size];
  const w = width ?? dims.w;
  const h = height ?? dims.h;
  const vals = points.filter((p): p is number => p !== null && Number.isFinite(p));
  if (vals.length < 2) {
    return (
      <span ref={ref} className={className} style={style}>
        <span className="fc-data-xs fc-tabular" style={{ color: cssVar('text-muted') }}>—</span>
        <span className="fc-sr-only">{`${label}: no trend data`}</span>
      </span>
    );
  }
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = w / (vals.length - 1);
  // A 1px inset top and bottom so the stroke is not clipped by the viewBox edge.
  const inset = 1;
  const usable = h - inset * 2;
  const path = vals
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${(inset + usable - ((v - min) / span) * usable).toFixed(2)}`)
    .join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  const stroke = up ? cssVar('positive') : cssVar('negative');
  const cue = up ? nonColorCues.up : nonColorCues.down;
  const first = vals[0];
  const last = vals[vals.length - 1];
  return (
    <span
      ref={ref}
      className={['fc-sparkline', className].filter(Boolean).join(' ')}
      title={tooltip ? `${label}: ${first} → ${last}` : undefined}
      style={{ display: 'inline-flex', alignItems: 'center', ...style }}
    >
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label}: trend ${up ? 'up' : 'down'}`} style={{ display: 'block', overflow: 'visible' }}>
        <path d={path} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="fc-sr-only">{`${cue} ${first} to ${last}`}</span>
    </span>
  );
});

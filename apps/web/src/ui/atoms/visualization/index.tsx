/**
 * atoms/visualization — ChartAxis, ChartGrid, ChartLegend, ChartTooltip, ChartCursor,
 * ChartMarker, ChartLabel, ChartAnnotation, ChartReferenceLine, ChartReferenceArea,
 * ChartSeriesIndicator.
 *
 * VISUAL CHARACTER: Institutional Minimal. Subtle grid, muted axis, no glow, no aggressive
 * gradient, no decorative point markers everywhere, no rainbow categorical palette.
 *
 * Semantic colours keep their meaning: green positive, red negative, orange
 * brand/interaction. Categorical series use a SEPARATE categorical token set — a chart's
 * fifth series must not be mistaken for a loss.
 *
 * There is no chart engine in this repo (no Recharts, no D3, no Visx), so these are SVG and
 * label primitives that a Molecule composes into a chart. The plan allows exactly this:
 * "financial primitives where supported by current chart engine" — with no engine, the
 * vocabulary is exposed as primitives.
 *
 * Complete charts (LineChart, CandlestickChart, CorrelationMatrix, YieldCurve dashboard,
 * MarketDepth application) are NOT implemented here.
 */
import { forwardRef, type ReactNode } from 'react';
import { cssVar, type SemanticToken } from '@/ui/foundations/color';
import { variant } from '@/ui/foundations/typography';
import { nonColorCues } from '@/ui/foundations/accessibility';

type BaseProps = {
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * The categorical palette. Deliberately NOT the semantic market colours: a chart's series
 * are categories, and colouring a category red would read as a loss. Eight steps drawn from
 * the brand orange ramp and the neutral ramp, ordered so adjacent series are maximally
 * distinguishable and none collides with a market semantic.
 */
export const CATEGORICAL = [
  'var(--fc-orange-500)',
  'var(--fc-orange-700)',
  'var(--fc-neutral-500)',
  'var(--fc-orange-300)',
  'var(--fc-neutral-700)',
  'var(--fc-orange-900)',
  'var(--fc-neutral-400)',
  'var(--fc-orange-200)',
] as const;

/** A series' visual role. */
export type SeriesKind = 'price' | 'volume' | 'benchmark' | 'forecast' | 'threshold' | 'band' | 'categorical';

/** How each series kind is drawn, so a forecast is never mistaken for a measurement. */
export const SERIES_STYLE: Record<SeriesKind, { dash?: string; width: number; opacity: number }> = {
  price: { width: 1.5, opacity: 1 },
  volume: { width: 1, opacity: 0.5 },
  // A benchmark is the thing being compared against: thinner and dimmer.
  benchmark: { dash: '4 3', width: 1, opacity: 0.7 },
  // A forecast is a PROJECTION, not data. Dashed and dimmed so it cannot be read as fact.
  forecast: { dash: '5 4', width: 1.25, opacity: 0.65 },
  threshold: { dash: '2 3', width: 1, opacity: 0.8 },
  band: { width: 0, opacity: 0.12 },
  categorical: { width: 1.5, opacity: 1 },
};

/** A series' colour, resolved from its kind. */
export function seriesColor(kind: SeriesKind, index = 0): string {
  if (kind === 'price') return 'var(--fc-brand-primary)';
  if (kind === 'benchmark') return 'var(--fc-text-muted)';
  if (kind === 'forecast') return 'var(--fc-info-muted)';
  if (kind === 'threshold') return 'var(--fc-warning-muted)';
  if (kind === 'band') return 'var(--fc-info-muted)';
  return CATEGORICAL[index % CATEGORICAL.length];
}

type ChartAxisProps = BaseProps & {
  /** `x` or `y`. */
  orientation: 'x' | 'y';
  /** The tick values to label. */
  ticks: number[];
  /** Formats a tick's label. */
  format?: (v: number) => string;
  /** The axis title, e.g. `Price (USD)`. */
  title?: string;
};

/**
 * ChartAxis — a labelled axis with its ticks.
 *
 * Muted by construction: the axis is scaffolding, not data. The title is the accessible
 * name, so a screen reader hears what the axis measures rather than a list of bare numbers.
 */
export const ChartAxis = forwardRef<HTMLDivElement, ChartAxisProps>(function ChartAxis(
  { orientation, ticks, format, title, className, style, theme = 'light' },
  ref,
) {
  const t = variant('data-xs');
  return (
    <div
      ref={ref}
      role="group"
      aria-label={title ?? (orientation === 'x' ? 'X axis' : 'Y axis')}
      className={['fc-chart-axis', `fc-chart-axis-${orientation}`, className].filter(Boolean).join(' ')}
      style={{
        display: 'flex',
        flexDirection: orientation === 'x' ? 'row' : 'column',
        alignItems: orientation === 'x' ? 'center' : 'flex-end',
        justifyContent: orientation === 'x' ? 'space-between' : 'center',
        gap: 'var(--fc-space-2)',
        color: cssVar('text-muted'),
        ...t,
        ...style,
      }}
    >
      {ticks.map((v, i) => (
        <span key={i}>{format ? format(v) : v}</span>
      ))}
    </div>
  );
});

type ChartGridProps = BaseProps & {
  /** Horizontal gridline positions, 0–1 of the plot height. */
  lines?: number[];
  orientation?: 'horizontal' | 'vertical';
};

/**
 * ChartGrid — the plot's scaffolding lines.
 *
 * Subtle by construction: `border-subtle`, 1px, no dashes. A grid that competes with the
 * data is a grid that has failed.
 */
export const ChartGrid = forwardRef<HTMLDivElement, ChartGridProps>(function ChartGrid(
  { lines = [0.25, 0.5, 0.75], orientation = 'horizontal', className, style, theme = 'light' },
  ref,
) {
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={['fc-chart-grid', className].filter(Boolean).join(' ')}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', ...style }}
    >
      {lines.map((p, i) => (
        <span
          key={i}
          style={
            orientation === 'horizontal'
              ? { position: 'absolute', left: 0, right: 0, top: `${p * 100}%`, height: 1, background: cssVar('border-subtle') }
              : { position: 'absolute', top: 0, bottom: 0, left: `${p * 100}%`, width: 1, background: cssVar('border-subtle') }
          }
        />
      ))}
    </div>
  );
});

/** One legend entry. */
export interface LegendEntry {
  label: string;
  color: string;
  /** The series kind, which decides whether the swatch is dashed. */
  kind?: SeriesKind;
}

type ChartLegendProps = BaseProps & {
  entries: LegendEntry[];
};

/**
 * ChartLegend — the key that says which line is which.
 *
 * Every entry carries its LABEL, not just a swatch: a legend of coloured dashes is
 * unreadable to a colour-blind user and to anyone printing in greyscale.
 */
export const ChartLegend = forwardRef<HTMLUListElement, ChartLegendProps>(function ChartLegend(
  { entries, className, style, theme = 'light' },
  ref,
) {
  return (
    <ul
      ref={ref}
      className={['fc-chart-legend', className].filter(Boolean).join(' ')}
      style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--fc-space-4)', margin: 0, padding: 0, listStyle: 'none', ...style }}
    >
      {entries.map((e, i) => (
        <li key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--fc-space-2)', fontFamily: 'var(--fc-font-sans)', fontSize: 'var(--fc-type-label-sm-size)', color: cssVar('text-secondary') }}>
          <span
            aria-hidden="true"
            style={{
              display: 'block',
              width: 14,
              height: 0,
              borderTop: `${SERIES_STYLE[e.kind ?? 'categorical'].width}px ${e.kind && SERIES_STYLE[e.kind].dash ? 'dashed' : 'solid'} ${e.color}`,
              opacity: SERIES_STYLE[e.kind ?? 'categorical'].opacity,
            }}
          />
          {e.label}
        </li>
      ))}
    </ul>
  );
});

type ChartTooltipProps = BaseProps & {
  /** The tooltip's title — usually the x value. */
  title: ReactNode;
  /** The rows: a label and its value. */
  rows?: Array<{ label: string; value: ReactNode; color?: string }>;
  /** Anchors the tooltip. The caller positions it. */
  x?: number;
  y?: number;
};

/**
 * ChartTooltip — the hover readout.
 *
 * Values render in Geist Mono with tabular figures, because a tooltip that reflows as the
 * pointer moves is unusable. The tooltip is `role="tooltip"` with the plot as its
 * `aria-describedby` target — the caller wires the association.
 */
export const ChartTooltip = forwardRef<HTMLDivElement, ChartTooltipProps>(function ChartTooltip(
  { title, rows = [], x = 0, y = 0, className, style, theme = 'light' },
  ref,
) {
  const t = variant('data-sm');
  return (
    <div
      ref={ref}
      role="tooltip"
      className={['fc-chart-tooltip', className].filter(Boolean).join(' ')}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: 'translate(-50%, -100%)',
        marginTop: -8,
        minWidth: 120,
        padding: 'var(--fc-space-2) var(--fc-space-3)',
        background: cssVar('surface-overlay'),
        border: `1px solid ${cssVar('border-default')}`,
        borderRadius: 'var(--fc-radius-md)',
        boxShadow: 'var(--fc-elevation-3)',
        pointerEvents: 'none',
        zIndex: 'var(--fc-z-index-tooltip)',
        ...style,
      }}
    >
      <div style={{ fontFamily: 'var(--fc-font-sans)', fontSize: 'var(--fc-type-label-sm-size)', fontWeight: 'var(--fc-font-weight-semibold)', color: cssVar('text-muted'), marginBottom: 'var(--fc-space-1)' }}>{title}</div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--fc-space-3)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--fc-space-1)', fontFamily: 'var(--fc-font-sans)', fontSize: 'var(--fc-type-label-sm-size)', color: cssVar('text-secondary') }}>
            {r.color ? <span aria-hidden="true" style={{ display: 'block', width: 8, height: 8, borderRadius: 'var(--fc-radius-full)', background: r.color }} /> : null}
            {r.label}
          </span>
          <span style={{ ...t, color: cssVar('text-primary') }}>{r.value}</span>
        </div>
      ))}
    </div>
  );
});

type ChartCursorProps = BaseProps & {
  /** The cursor's x position in the plot's coordinate space. */
  x?: number;
  /** The cursor's y position. */
  y?: number;
  /** `crosshair` draws both lines, `vertical` only x. */
  mode?: 'crosshair' | 'vertical' | 'horizontal';
};

/**
 * ChartCursor — the crosshair that follows the pointer.
 *
 * A guide, not data: `border-default` and no marker. The cursor never carries a value —
 * that is the tooltip's job, and duplicating it here would be two things to keep in step.
 */
export const ChartCursor = forwardRef<HTMLDivElement, ChartCursorProps>(function ChartCursor(
  { x, y, mode = 'crosshair', className, style, theme = 'light' },
  ref,
) {
  if (x === undefined && y === undefined) return null;
  return (
    <div ref={ref} aria-hidden="true" className={['fc-chart-cursor', className].filter(Boolean).join(' ')} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', ...style }}>
      {x !== undefined && mode !== 'horizontal' ? <span style={{ position: 'absolute', top: 0, bottom: 0, left: x, width: 1, background: cssVar('border-strong') }} /> : null}
      {y !== undefined && mode !== 'vertical' ? <span style={{ position: 'absolute', left: 0, right: 0, top: y, height: 1, background: cssVar('border-strong') }} /> : null}
    </div>
  );
});

type ChartMarkerProps = BaseProps & {
  /** The marker's position in the plot's coordinate space. */
  x: number;
  y: number;
  /** Accessible name. Required — a marker with no name is a dot. */
  label: string;
  color?: string;
  size?: number;
};

/**
 * ChartMarker — a single annotated point.
 *
 * Used sparingly, per the plan's "no decorative point markers everywhere". The label is the
 * accessible name, so the marker announces what it marks rather than being a silent dot.
 */
export const ChartMarker = forwardRef<HTMLDivElement, ChartMarkerProps>(function ChartMarker(
  { x, y, label, color, size = 8, className, style, theme = 'light' },
  ref,
) {
  return (
    <div
      ref={ref}
      role="img"
      aria-label={label}
      title={label}
      className={['fc-chart-marker', className].filter(Boolean).join(' ')}
      style={{
        position: 'absolute',
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        borderRadius: 'var(--fc-radius-full)',
        background: color ?? cssVar('brand-primary'),
        border: `2px solid ${cssVar('surface-primary')}`,
        ...style,
      }}
    />
  );
});

type ChartLabelProps = BaseProps & {
  children: ReactNode;
  x: number;
  y: number;
  /** Anchors the label's box relative to (x, y). */
  anchor?: 'start' | 'middle' | 'end';
};

/** ChartLabel — free text placed on the plot. */
export const ChartLabel = forwardRef<HTMLDivElement, ChartLabelProps>(function ChartLabel(
  { children, x, y, anchor = 'middle', className, style, theme = 'light' },
  ref,
) {
  return (
    <div
      ref={ref}
      className={['fc-chart-label', className].filter(Boolean).join(' ')}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: anchor === 'middle' ? 'translate(-50%, -50%)' : anchor === 'end' ? 'translate(-100%, -50%)' : 'translate(0, -50%)',
        fontFamily: 'var(--fc-font-sans)',
        fontSize: 'var(--fc-type-label-sm-size)',
        fontWeight: 'var(--fc-font-weight-semibold)',
        color: cssVar('text-secondary'),
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        ...style,
      }}
    >
      {children}
    </div>
  );
});

type ChartAnnotationProps = BaseProps & {
  /** The annotation's text. */
  children: ReactNode;
  x: number;
  y: number;
  /** Accessible name. Defaults to the text content. */
  label?: string;
};

/**
 * ChartAnnotation — a note pinned to a point on the plot.
 *
 * `role="note"` with an accessible name, so the annotation is reachable in the
 * accessibility tree rather than being decoration a screen reader skips.
 */
export const ChartAnnotation = forwardRef<HTMLDivElement, ChartAnnotationProps>(function ChartAnnotation(
  { children, x, y, label, className, style, theme = 'light' },
  ref,
) {
  return (
    <div
      ref={ref}
      role="note"
      aria-label={label ?? (typeof children === 'string' ? children : undefined)}
      className={['fc-chart-annotation', className].filter(Boolean).join(' ')}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: 'translate(-50%, -100%)',
        padding: '2px 6px',
        background: cssVar('surface-overlay'),
        border: `1px solid ${cssVar('border-default')}`,
        borderRadius: 'var(--fc-radius-sm)',
        fontFamily: 'var(--fc-font-sans)',
        fontSize: 'var(--fc-type-label-sm-size)',
        color: cssVar('text-secondary'),
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        ...style,
      }}
    >
      {children}
    </div>
  );
});

type ChartReferenceLineProps = BaseProps & {
  /** The line's position, 0–1 of the plot's extent. */
  at: number;
  orientation?: 'horizontal' | 'vertical';
  /** The label shown at the line's end. */
  label?: string;
  /** The line's role, which decides its colour and dash. */
  kind?: 'threshold' | 'benchmark' | 'average';
};

/**
 * ChartReferenceLine — a horizontal or vertical line of significance.
 *
 * A threshold, a benchmark or an average. Dashed by construction so it is never mistaken
 * for a data series, and labelled so its meaning is stated rather than inferred from a hue.
 */
export const ChartReferenceLine = forwardRef<HTMLDivElement, ChartReferenceLineProps>(function ChartReferenceLine(
  { at, orientation = 'horizontal', label, kind = 'threshold', className, style, theme = 'light' },
  ref,
) {
  const color: SemanticToken = kind === 'benchmark' ? 'text-muted' : kind === 'average' ? 'info' : 'warning';
  return (
    <div
      ref={ref}
      role="img"
      aria-label={label ?? `${kind} reference line`}
      className={['fc-chart-reference-line', className].filter(Boolean).join(' ')}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', ...style }}
    >
      <span
        style={
          orientation === 'horizontal'
            ? { position: 'absolute', left: 0, right: 0, top: `${at * 100}%`, borderTop: `1px dashed ${cssVar(color)}` }
            : { position: 'absolute', top: 0, bottom: 0, left: `${at * 100}%`, borderLeft: `1px dashed ${cssVar(color)}` }
        }
      />
      {label ? (
        <span
          style={{
            position: 'absolute',
            ...(orientation === 'horizontal' ? { left: 0, top: `calc(${at * 100}% - 14px)` } : { top: 0, left: `calc(${at * 100}% + 4px)` }),
            fontFamily: 'var(--fc-font-sans)',
            fontSize: 'var(--fc-type-label-sm-size)',
            fontWeight: 'var(--fc-font-weight-semibold)',
            color: cssVar(color),
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
      ) : null}
    </div>
  );
});

type ChartReferenceAreaProps = BaseProps & {
  /** The band's start, 0–1. */
  from: number;
  /** The band's end, 0–1. */
  to: number;
  orientation?: 'horizontal' | 'vertical';
  label?: string;
  kind?: 'liquidity' | 'range' | 'risk';
};

/**
 * ChartReferenceArea — a shaded band of significance.
 *
 * A liquidity band, a range or a risk zone. The fill is the semantic role at low alpha (the
 * `*-subtle` tokens), so the band reads as a region rather than a solid block that would
 * hide the data behind it.
 */
export const ChartReferenceArea = forwardRef<HTMLDivElement, ChartReferenceAreaProps>(function ChartReferenceArea(
  { from, to, orientation = 'horizontal', label, kind = 'range', className, style, theme = 'light' },
  ref,
) {
  const fill: SemanticToken = kind === 'liquidity' ? 'info-subtle' : kind === 'risk' ? 'negative-subtle' : 'warning-subtle';
  const border: SemanticToken = kind === 'liquidity' ? 'info' : kind === 'risk' ? 'negative' : 'warning';
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return (
    <div
      ref={ref}
      role="img"
      aria-label={label ?? `${kind} band`}
      className={['fc-chart-reference-area', className].filter(Boolean).join(' ')}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', ...style }}
    >
      <span
        style={
          orientation === 'horizontal'
            ? { position: 'absolute', left: 0, right: 0, top: `${lo * 100}%`, height: `${(hi - lo) * 100}%`, background: cssVar(fill), borderTop: `1px solid ${cssVar(border)}`, borderBottom: `1px solid ${cssVar(border)}` }
            : { position: 'absolute', top: 0, bottom: 0, left: `${lo * 100}%`, width: `${(hi - lo) * 100}%`, background: cssVar(fill), borderLeft: `1px solid ${cssVar(border)}`, borderRight: `1px solid ${cssVar(border)}` }
        }
      />
    </div>
  );
});

type ChartSeriesIndicatorProps = BaseProps & {
  /** The series' name. */
  label: string;
  kind: SeriesKind;
  /** The latest value, shown beside the label. */
  value?: ReactNode;
  /** The direction, which adds a non-colour cue. */
  direction?: 'up' | 'down' | 'flat';
};

/**
 * ChartSeriesIndicator — a legend entry that also shows the live value.
 *
 * The direction cue is the arrow, not the colour: an indicator that turns green says
 * nothing to a colour-blind user, and `↑` says everything.
 */
export const ChartSeriesIndicator = forwardRef<HTMLDivElement, ChartSeriesIndicatorProps>(function ChartSeriesIndicator(
  { label, kind, value, direction, className, style, theme = 'light' },
  ref,
) {
  const color = seriesColor(kind);
  const cue = direction === 'up' ? nonColorCues.up : direction === 'down' ? nonColorCues.down : direction === 'flat' ? nonColorCues.flat : '';
  return (
    <div
      ref={ref}
      className={['fc-chart-series-indicator', className].filter(Boolean).join(' ')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--fc-space-2)', ...style }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'block',
          width: 12,
          height: 0,
          borderTop: `${SERIES_STYLE[kind].width}px ${SERIES_STYLE[kind].dash ? 'dashed' : 'solid'} ${color}`,
          opacity: SERIES_STYLE[kind].opacity,
        }}
      />
      <span style={{ fontFamily: 'var(--fc-font-sans)', fontSize: 'var(--fc-type-label-sm-size)', color: cssVar('text-secondary') }}>{label}</span>
      {cue ? <span aria-hidden="true" style={{ fontFamily: 'var(--fc-font-mono)', fontSize: 'var(--fc-type-label-sm-size)', color: cssVar('text-muted') }}>{cue}</span> : null}
      {value !== undefined ? (
        <span className="fc-data-sm fc-tabular" style={{ color: cssVar('text-primary') }}>{value}</span>
      ) : null}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Sparkline — the one visualization that lives inline in a cell or a stat block.
// ---------------------------------------------------------------------------
export { Sparkline, type SparklineSize } from './sparkline';

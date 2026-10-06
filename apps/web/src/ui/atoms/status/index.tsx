/**
 * atoms/status — Badge, Tag, StatusDot, Spinner, Skeleton, Progress.
 *
 * Every atom here carries a NON-COLOUR cue alongside its colour. The plan is explicit that
 * meaning may never rest on colour alone: a positive badge carries a `+` or a word, a status
 * dot carries a label, a spinner announces itself. The colour is reinforcement, not the
 * message.
 *
 * The tone union is controlled — `neutral | brand | positive | negative | warning | info` —
 * so a caller cannot pass an arbitrary colour string and drift the palette.
 */
import { forwardRef, type CSSProperties, type ReactNode } from 'react';
import { cssVar, type SemanticToken } from '@/ui/foundations/color';
import { nonColorCues } from '@/ui/foundations/accessibility';
import { Icon, type IconComponent } from '@/ui/atoms/visual';

/** The controlled tone union. */
export type Tone = 'neutral' | 'brand' | 'positive' | 'negative' | 'warning' | 'info';

/** The semantic role each tone resolves to, for text and for the subtle surface. */
const TONE_TEXT: Record<Tone, SemanticToken> = {
  neutral: 'text-secondary',
  brand: 'brand-critical',
  positive: 'positive-critical',
  negative: 'negative-critical',
  warning: 'warning-critical',
  info: 'info-critical',
};
const TONE_SURFACE: Record<Tone, SemanticToken> = {
  neutral: 'surface-secondary',
  brand: 'brand-subtle',
  positive: 'positive-subtle',
  negative: 'negative-subtle',
  warning: 'warning-subtle',
  info: 'info-subtle',
};
const TONE_BORDER: Record<Tone, SemanticToken> = {
  neutral: 'border-default',
  brand: 'brand-border',
  positive: 'border-default',
  negative: 'border-default',
  warning: 'border-default',
  info: 'border-default',
};

const cx = (...parts: (string | undefined | false)[]): string => parts.filter(Boolean).join(' ');

type BadgeProps = {
  children?: ReactNode;
  tone?: Tone;
  /** `sm` for inline metadata, `md` for a standalone chip. */
  size?: 'sm' | 'md';
  /**
   * An icon rendered before the label. Supplying one is how a badge carries its non-colour
   * cue — a `+` for positive, a `!` for warning.
   */
  icon?: IconComponent;
  /** A leading glyph string. An alternative to `icon` when no component is at hand. */
  glyph?: string;
  className?: string;
  style?: CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * Badge — a small status or category chip.
 *
 * `radius-full` is correct here: the plan names "small metadata badge" as a full-radius case.
 * The tone colours the text and the surface; the icon or glyph carries the meaning for anyone
 * who cannot distinguish the colour.
 */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { children, tone = 'neutral', size = 'sm', icon, glyph, className, style, theme = 'light' },
  ref,
) {
  const pad = size === 'sm' ? '2px 8px' : '4px 10px';
  return (
    <span
      ref={ref}
      className={cx('fc-badge', `fc-badge-${tone}`, className)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--fc-space-1)',
        padding: pad,
        borderRadius: 'var(--fc-radius-full)',
        background: cssVar(TONE_SURFACE[tone]),
        border: `1px solid ${cssVar(TONE_BORDER[tone])}`,
        color: cssVar(TONE_TEXT[tone]),
        fontSize: 'var(--fc-type-label-sm-size)',
        lineHeight: 'var(--fc-type-label-sm-line)',
        fontWeight: 'var(--fc-type-label-sm-weight)',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {icon ? <Icon as={icon} size={12} /> : null}
      {glyph ? <span aria-hidden="true">{glyph}</span> : null}
      {children}
    </span>
  );
});

type TagProps = {
  children?: ReactNode;
  tone?: Tone;
  /** Removes the tag when clicked. Supply to make it dismissible. */
  onRemove?: () => void;
  /** Accessible name for the remove control. */
  removeLabel?: string;
  className?: string;
  style?: CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * Tag — a removable label, as on a filter or a watchlist entry.
 *
 * `radius-sm`, not full: a tag is a rectangular label, and the plan warns against making
 * every control pill-shaped. The remove control is a real `<button>` so it is keyboard
 * reachable and carries an accessible name.
 */
export const Tag = forwardRef<HTMLSpanElement, TagProps>(function Tag(
  { children, tone = 'neutral', onRemove, removeLabel = 'Remove', className, style, theme = 'light' },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cx('fc-tag', `fc-tag-${tone}`, className)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--fc-space-1)',
        padding: '3px 4px 3px 8px',
        borderRadius: 'var(--fc-radius-sm)',
        background: cssVar(TONE_SURFACE[tone]),
        border: `1px solid ${cssVar(TONE_BORDER[tone])}`,
        color: cssVar(TONE_TEXT[tone]),
        fontSize: 'var(--fc-type-label-sm-size)',
        lineHeight: 'var(--fc-type-label-sm-line)',
        fontWeight: 'var(--fc-type-label-sm-weight)',
        ...style,
      }}
    >
      <span>{children}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          title={removeLabel}
          className="fc-focus-ring"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 16,
            height: 16,
            padding: 0,
            border: 0,
            borderRadius: 'var(--fc-radius-full)',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 'var(--fc-font-size-11)',
            lineHeight: 1,
          }}
        >
          <span aria-hidden="true">{'×'}</span>
        </button>
      ) : null}
    </span>
  );
});

type StatusDotProps = {
  /**
   * The state. `live` pulses; `stale` and `error` are static. The plan reserves vivid colours
   * for live and urgent states, which is why `live` is the only animated one.
   */
  state: 'idle' | 'live' | 'stale' | 'error' | 'pending';
  /**
   * The human-readable label. REQUIRED: a dot alone is colour-only meaning, which the plan
   * forbids. When supplied it renders as visually-hidden text next to the dot.
   */
  label: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
  theme?: 'light' | 'dark';
};

/** The colour role per state. `live` uses the vivid set — it is the live-tick case. */
const DOT_ROLE: Record<StatusDotProps['state'], SemanticToken> = {
  idle: 'text-muted',
  live: 'positive-live',
  stale: 'warning',
  error: 'negative-live',
  pending: 'info',
};

/**
 * StatusDot — a state indicator.
 *
 * The label is mandatory and renders as visually-hidden text, so the dot is never the only
 * carrier of meaning. `live` pulses at the realtime duration; every other state is static,
 * because a stale feed that animates is a lie.
 */
export const StatusDot = forwardRef<HTMLSpanElement, StatusDotProps>(function StatusDot(
  { state, label, size = 8, className, style, theme = 'light' },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cx('fc-status-dot', `fc-status-dot-${state}`, className)}
      role="status"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--fc-space-2)', ...style }}
    >
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          flex: '0 0 auto',
          borderRadius: 'var(--fc-radius-full)',
          background: cssVar(DOT_ROLE[state]),
          animation: state === 'live' ? 'fc-dot-pulse var(--fc-realtime-flash) var(--fc-ease-standard) infinite alternate' : 'none',
        }}
      />
      <span className="fc-sr-only">{label}</span>
    </span>
  );
});

type SpinnerProps = {
  /** Accessible name. Required — a spinner with no label is a meaningless animation. */
  label?: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * Spinner — a busy indicator.
 *
 * The label renders as visually-hidden text, so a screen reader hears "Loading" rather than
 * silence. The rotation runs at the `base` duration and is removed entirely under
 * `prefers-reduced-motion` (see `motion.css`).
 */
export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  { label = 'Loading', size = 16, className, style, theme = 'light' },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cx('fc-spinner', className)}
      role="status"
      style={{ display: 'inline-flex', alignItems: 'center', ...style }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'block',
          width: size,
          height: size,
          borderRadius: 'var(--fc-radius-full)',
          border: `2px solid ${cssVar('border-default')}`,
          borderTopColor: cssVar('brand-primary'),
          animation: 'fc-spin var(--fc-motion-base) linear infinite',
        }}
      />
      <span className="fc-sr-only">{label}</span>
    </span>
  );
});

type SkeletonProps = {
  /** The shape to suggest. `text` is a line, `block` a rectangle, `circle` an avatar. */
  variant?: 'text' | 'block' | 'circle';
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * Skeleton — a placeholder for content that has not arrived.
 *
 * The pulse runs at the `slow` duration and is removed under reduced motion. The placeholder
 * is `aria-hidden` — a screen reader is told the region is busy by the caller's
 * `aria-busy`/live region, not by a meaningless grey box.
 */
export const Skeleton = forwardRef<HTMLSpanElement, SkeletonProps>(function Skeleton(
  { variant = 'text', width, height, className, style, theme = 'light' },
  ref,
) {
  const dims: CSSProperties =
    variant === 'text'
      ? { width: width ?? '100%', height: height ?? 12, borderRadius: 'var(--fc-radius-xs)' }
      : variant === 'circle'
        ? { width: width ?? 32, height: height ?? 32, borderRadius: 'var(--fc-radius-full)' }
        : { width: width ?? '100%', height: height ?? 48, borderRadius: 'var(--fc-radius-md)' };
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={cx('fc-skeleton', className)}
      style={{
        display: 'block',
        background: cssVar('surface-secondary'),
        animation: 'fc-skeleton-pulse var(--fc-motion-slow) var(--fc-ease-standard) infinite alternate',
        ...dims,
        ...style,
      }}
    />
  );
});

type ProgressProps = {
  /**
   * The completion, 0–100. Omit and supply `indeterminate` for an unknown duration.
   */
  value?: number;
  indeterminate?: boolean;
  /** Accessible name. Required — a bar with no label is a coloured rectangle. */
  label: string;
  /** Shows the numeric value next to the bar. */
  showValue?: boolean;
  tone?: Tone;
  size?: 'sm' | 'md';
  className?: string;
  style?: CSSProperties;
  theme?: 'light' | 'dark';
};

/** The fill colour per tone. */
const PROGRESS_FILL: Record<Tone, SemanticToken> = {
  neutral: 'brand-primary',
  brand: 'brand-primary',
  positive: 'positive',
  negative: 'negative',
  warning: 'warning',
  info: 'info',
};

/**
 * Progress — a determinate or indeterminate completion bar.
 *
 * Real ARIA semantics: `role="progressbar"` with `aria-valuenow`/`aria-valuemin`/
 * `aria-valuemax` when determinate, and no value attributes when indeterminate. The numeric
 * value is rendered in Geist Mono with tabular figures so it does not jitter as it advances.
 */
export const Progress = forwardRef<HTMLDivElement, ProgressProps>(function Progress(
  { value, indeterminate, label, showValue, tone = 'brand', size = 'md', className, style, theme = 'light' },
  ref,
) {
  const clamped = indeterminate ? undefined : Math.min(100, Math.max(0, value ?? 0));
  const track = size === 'sm' ? 4 : 8;
  return (
    <div
      ref={ref}
      className={cx('fc-progress', className)}
      role="progressbar"
      aria-label={label}
      aria-valuenow={clamped}
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : 100}
      style={{ display: 'flex', alignItems: 'center', gap: 'var(--fc-space-2)', ...style }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'relative',
          flex: 1,
          height: track,
          borderRadius: 'var(--fc-radius-full)',
          background: cssVar('surface-secondary'),
          border: `1px solid ${cssVar('border-subtle')}`,
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            display: 'block',
            height: '100%',
            width: indeterminate ? '40%' : `${clamped}%`,
            borderRadius: 'var(--fc-radius-full)',
            background: cssVar(PROGRESS_FILL[tone]),
            transition: 'width var(--fc-motion-base) var(--fc-ease-standard)',
            animation: indeterminate ? 'fc-progress-slide var(--fc-motion-panel) var(--fc-ease-standard) infinite alternate' : 'none',
          }}
        />
      </span>
      {showValue && !indeterminate ? (
        <span
          className="fc-data-xs fc-tabular"
          style={{ color: cssVar('text-secondary'), minWidth: '3.5em', textAlign: 'right' }}
        >
          {Math.round(clamped ?? 0)}%
        </span>
      ) : null}
    </div>
  );
});

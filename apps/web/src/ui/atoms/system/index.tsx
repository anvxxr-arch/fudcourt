/**
 * atoms/system — Timestamp, Duration, Latency, HealthStatus, ExecutionStatus.
 *
 * `ExecutionStatus` uses the CANONICAL lifecycle vocabulary from
 * `src/lib/executor-lifecycle.ts` (mirrored by `apps/executor/internal/execution/lifecycle.go`).
 * No second enum is minted here — a duplicate would be exactly the conflict the plan's stop
 * conditions name. The atom maps each canonical state to a label, a tone and an icon; it
 * knows nothing about exchanges, providers or how a state was reached.
 *
 * Presentation only. No atom here fetches API health, reads a venue, or subscribes to
 * anything.
 */
import { forwardRef } from 'react';
import { cssVar } from '@/ui/foundations/color';
import { focusRingClass, srOnlyClass } from '@/ui/foundations/accessibility';
import { DataValue } from '@/ui/atoms/typography';
import { Badge, StatusDot, type Tone } from '@/ui/atoms/status';
import { Icon, type IconComponent } from '@/ui/atoms/visual';

type BaseProps = {
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * The canonical execution lifecycle (PRD §57). Imported from the one source of truth rather
 * than re-declared, so a state added to the engine cannot silently fail to render.
 */
import type { ExecutionStatus as CanonicalExecutionStatus } from '@/lib/executor-lifecycle';
import type { ChildOrderStatus as CanonicalChildOrderStatus } from '@/lib/executor-request-defs';

/** Every canonical state, with its human label and tone. */
const EXECUTION_STATUS: Record<CanonicalExecutionStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  CALCULATED: { label: 'Calculated', tone: 'info' },
  VALIDATED: { label: 'Validated', tone: 'info' },
  READY: { label: 'Ready', tone: 'info' },
  RUNNING: { label: 'Running', tone: 'brand' },
  PARTIALLY_FILLED: { label: 'Partially filled', tone: 'warning' },
  FILLED: { label: 'Filled', tone: 'positive' },
  PAUSED: { label: 'Paused', tone: 'warning' },
  CANCEL_REQUESTED: { label: 'Cancel requested', tone: 'warning' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  FAILED: { label: 'Failed', tone: 'negative' },
  RISK_STOPPED: { label: 'Risk stopped', tone: 'negative' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  RECONCILING: { label: 'Reconciling', tone: 'info' },
  STOPPED: { label: 'Stopped', tone: 'neutral' },
};

const CHILD_STATUS: Record<CanonicalChildOrderStatus, { label: string; tone: Tone }> = {
  PLANNED: { label: 'Planned', tone: 'neutral' },
  SUBMITTING: { label: 'Submitting', tone: 'info' },
  OPEN: { label: 'Open', tone: 'brand' },
  PARTIAL: { label: 'Partial', tone: 'warning' },
  FILLED: { label: 'Filled', tone: 'positive' },
  CANCELLING: { label: 'Cancelling', tone: 'warning' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  REJECTED: { label: 'Rejected', tone: 'negative' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  UNKNOWN: { label: 'Unknown', tone: 'warning' },
};

type TimestampProps = BaseProps & {
  /** Unix milliseconds, or an ISO string, or a Date. */
  value: number | string | Date | null | undefined;
  /** `time` HH:MM:SS, `date` YYYY-MM-DD, `datetime` both, `relative` "3m ago". */
  mode?: 'time' | 'date' | 'datetime' | 'relative';
  /** The reference "now" for `relative`. Injectable so a test is deterministic. */
  now?: number;
  size?: 'sm' | 'md';
};

/** Format a timestamp in the requested mode. An absent value is the em dash. */
function formatTimestamp(value: TimestampProps['value'], mode: NonNullable<TimestampProps['mode']>, now: number): string {
  if (value === null || value === undefined) return '—';
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  if (mode === 'time') return d.toLocaleTimeString('en-US', { hour12: false });
  if (mode === 'date') return d.toISOString().slice(0, 10);
  if (mode === 'datetime') return `${d.toISOString().slice(0, 10)} ${d.toLocaleTimeString('en-US', { hour12: false })}`;
  const delta = now - ms;
  if (delta < 0) return 'in the future';
  const secs = Math.floor(delta / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Timestamp — a point in time.
 *
 * Rendered in the mono family with tabular figures, because a column of timestamps that
 * reflows as the seconds change is unreadable. `relative` is for "how long ago" copy; the
 * absolute value is always in the `title`.
 */
export const Timestamp = forwardRef<HTMLSpanElement, TimestampProps>(function Timestamp(
  { value, mode = 'datetime', now = Date.now(), size = 'md', className, style, theme = 'light' },
  ref,
) {
  const text = formatTimestamp(value, mode, now);
  const absolute = formatTimestamp(value, 'datetime', now);
  return (
    <span ref={ref} className={className} style={style}>
      <DataValue size={size === 'sm' ? 'xs' : 'sm'} tone={text === '—' ? 'muted' : 'default'} title={absolute === '—' ? undefined : absolute}>
        {text}
      </DataValue>
    </span>
  );
});

type DurationProps = BaseProps & {
  /** The duration in milliseconds. */
  ms: number | null | undefined;
  /** `compact` is `2h 14m`, `long` is `2 hours 14 minutes`, `clock` is `02:14:33`. */
  mode?: 'compact' | 'long' | 'clock';
  size?: 'sm' | 'md';
};

/** Format a duration. An absent or negative duration is the em dash. */
function formatDuration(ms: number | null | undefined, mode: NonNullable<DurationProps['mode']>): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (mode === 'clock') {
    const pad = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }
  if (mode === 'long') {
    const parts: string[] = [];
    if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
    if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
    if (s || parts.length === 0) parts.push(`${s} second${s === 1 ? '' : 's'}`);
    return parts.join(' ');
  }
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

/** Duration — an elapsed span. */
export const Duration = forwardRef<HTMLSpanElement, DurationProps>(function Duration(
  { ms, mode = 'compact', size = 'md', className, style, theme = 'light' },
  ref,
) {
  const text = formatDuration(ms, mode);
  return (
    <span ref={ref} className={className} style={style}>
      <DataValue size={size === 'sm' ? 'xs' : 'sm'} tone={text === '—' ? 'muted' : 'default'}>{text}</DataValue>
    </span>
  );
});

type LatencyProps = BaseProps & {
  /** The latency in milliseconds. */
  ms: number | null | undefined;
  /** The threshold above which the latency reads as degraded. Default 500ms. */
  warnAbove?: number;
  /** The threshold above which it reads as critical. Default 2000ms. */
  criticalAbove?: number;
  size?: 'sm' | 'md';
};

/** The band a latency falls in. */
export function latencyBand(ms: number | null | undefined, warnAbove = 500, criticalAbove = 2000): 'good' | 'degraded' | 'critical' | 'absent' {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'absent';
  if (ms >= criticalAbove) return 'critical';
  if (ms >= warnAbove) return 'degraded';
  return 'good';
}

/**
 * Latency — a round-trip time, with its band in words.
 *
 * The band is a WORD beside the figure, not a colour: "degraded" and "critical" demand
 * different responses and a hue is not a reliable way to tell them apart.
 */
export const Latency = forwardRef<HTMLSpanElement, LatencyProps>(function Latency(
  { ms, warnAbove = 500, criticalAbove = 2000, size = 'md', className, style, theme = 'light' },
  ref,
) {
  const band = latencyBand(ms, warnAbove, criticalAbove);
  const tone: Tone = band === 'critical' ? 'negative' : band === 'degraded' ? 'warning' : band === 'good' ? 'positive' : 'neutral';
  const label = band === 'critical' ? 'Critical' : band === 'degraded' ? 'Degraded' : band === 'good' ? 'Good' : 'Unknown';
  const text = band === 'absent' ? '—' : `${Math.round(ms as number)}ms`;
  return (
    <span
      ref={ref}
      className={['fc-latency', className].filter(Boolean).join(' ')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--fc-space-2)', ...style }}
      title={band === 'absent' ? undefined : `Latency ${label.toLowerCase()}`}
    >
      <DataValue size={size === 'sm' ? 'xs' : 'sm'} tone={band === 'absent' ? 'muted' : 'default'}>{text}</DataValue>
      <Badge tone={tone} size="sm">{label}</Badge>
    </span>
  );
});

/** The health vocabulary. */
export type HealthState = 'healthy' | 'degraded' | 'down' | 'unknown';

/** The label and tone per health state. */
const HEALTH: Record<HealthState, { label: string; tone: Tone; dot: 'live' | 'stale' | 'error' | 'idle' }> = {
  healthy: { label: 'Healthy', tone: 'positive', dot: 'live' },
  degraded: { label: 'Degraded', tone: 'warning', dot: 'stale' },
  down: { label: 'Down', tone: 'negative', dot: 'error' },
  unknown: { label: 'Unknown', tone: 'neutral', dot: 'idle' },
};

type HealthStatusProps = BaseProps & {
  state: HealthState;
  /** The component being reported on, e.g. `Ticker feed`. */
  subject?: string;
  label?: string;
};

/**
 * HealthStatus — a component's health, in words.
 *
 * The dot is decoration; the word is the message. `subject` puts the component in the
 * accessible name so a screen reader hears "Ticker feed: degraded" rather than a bare
 * "degraded" with no antecedent.
 */
export const HealthStatus = forwardRef<HTMLSpanElement, HealthStatusProps>(function HealthStatus(
  { state, subject, label, className, style, theme = 'light' },
  ref,
) {
  const h = HEALTH[state];
  return (
    <span
      ref={ref}
      className={['fc-health', className].filter(Boolean).join(' ')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--fc-space-2)', ...style }}
      title={subject ? `${subject}: ${h.label.toLowerCase()}` : undefined}
    >
      <StatusDot state={h.dot} label={subject ? `${subject}: ${label ?? h.label}` : (label ?? h.label)} />
      <span style={{ fontFamily: 'var(--fc-font-sans)', fontSize: 'var(--fc-type-label-sm-size)', fontWeight: 600, color: cssVar('text-secondary') }}>
        {subject ? <span style={{ color: cssVar('text-muted'), fontWeight: 400 }}>{subject}: </span> : null}
        {label ?? h.label}
      </span>
    </span>
  );
});

type ExecutionStatusProps = BaseProps & {
  /** A canonical execution lifecycle state. */
  status: CanonicalExecutionStatus;
  /** Overrides the default label. */
  label?: string;
  /** Shows a status dot beside the badge. */
  withDot?: boolean;
};

/** The dot state per execution status. */
const STATUS_DOT: Record<CanonicalExecutionStatus, 'live' | 'stale' | 'error' | 'idle' | 'pending'> = {
  DRAFT: 'idle',
  CALCULATED: 'pending',
  VALIDATED: 'pending',
  READY: 'pending',
  RUNNING: 'live',
  PARTIALLY_FILLED: 'live',
  FILLED: 'live',
  PAUSED: 'stale',
  CANCEL_REQUESTED: 'stale',
  CANCELLED: 'idle',
  FAILED: 'error',
  RISK_STOPPED: 'error',
  EXPIRED: 'idle',
  RECONCILING: 'pending',
  STOPPED: 'idle',
};

/**
 * ExecutionStatus — the presentation of a canonical execution state.
 *
 * It maps the state to a label and a tone and knows nothing else: no exchange, no provider,
 * no transition rules (those live in `executor-lifecycle.ts`). An unknown state renders the
 * `UNKNOWN` treatment rather than throwing, because a forward-compatible engine must not
 * crash a dashboard.
 */
export const ExecutionStatus = forwardRef<HTMLSpanElement, ExecutionStatusProps>(function ExecutionStatus(
  { status, label, withDot, className, style, theme = 'light' },
  ref,
) {
  const s = EXECUTION_STATUS[status] ?? { label: 'Unknown', tone: 'neutral' as Tone };
  const text = label ?? s.label;
  return (
    <span
      ref={ref}
      className={['fc-execution-status', className].filter(Boolean).join(' ')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--fc-space-2)', ...style }}
    >
      {withDot ? <StatusDot state={STATUS_DOT[status] ?? 'idle'} label={text} /> : null}
      <Badge tone={s.tone} size="sm">{text}</Badge>
    </span>
  );
});

type ChildOrderStatusProps = BaseProps & {
  status: CanonicalChildOrderStatus;
  label?: string;
};

/** ChildOrderStatus — the presentation of a canonical child-order state. */
export const ChildOrderStatus = forwardRef<HTMLSpanElement, ChildOrderStatusProps>(function ChildOrderStatus(
  { status, label, className, style, theme = 'light' },
  ref,
) {
  const s = CHILD_STATUS[status] ?? { label: 'Unknown', tone: 'neutral' as Tone };
  return (
    <span ref={ref} className={className} style={style}>
      <Badge tone={s.tone} size="sm">{label ?? s.label}</Badge>
    </span>
  );
});

/** Re-exported so a consumer can enumerate the vocabulary without a second import. */
export { EXECUTION_STATUS, CHILD_STATUS };

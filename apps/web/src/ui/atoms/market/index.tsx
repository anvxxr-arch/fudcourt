/**
 * atoms/market — AssetSymbol, AssetPair, Trend, Timeframe, Confidence, MarketStatus.
 *
 * NO FETCHING. None of these atoms calls a provider, reads a registry or resolves a symbol
 * to a logo. They render the data they are handed. A Molecule that knows where market data
 * lives composes them; the atoms stay environment-independent.
 *
 * `Trend` encodes direction with more than colour — an arrow AND a sign, per the plan's
 * "colour-only financial meaning" review focus. `MarketStatus` exposes a human-readable
 * label, not just a colour.
 */
import { forwardRef, type ReactNode } from 'react';
import { cssVar, type SemanticToken } from '@/ui/foundations/color';
import { nonColorCues } from '@/ui/foundations/accessibility';
import { Icon, type IconComponent } from '@/ui/atoms/visual';
import { DataValue } from '@/ui/atoms/typography';
import { Badge, type Tone } from '@/ui/atoms/status';
import { formatPercentage } from '@/ui/atoms/financial/format';

type BaseProps = {
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

type AssetSymbolProps = BaseProps & {
  /** The ticker, e.g. `BTC`. */
  symbol: string;
  /** The full name, e.g. `Bitcoin`. Rendered as the accessible name. */
  name?: string;
  /** An optional logo. Supplied by the caller — never fetched here. */
  icon?: IconComponent;
  size?: 'sm' | 'md' | 'lg';
};

/**
 * AssetSymbol — a ticker with its name.
 *
 * The ticker is the visible text; the name is the accessible name when supplied, so a screen
 * reader hears "Bitcoin" rather than a three-letter code that may be ambiguous in context.
 */
export const AssetSymbol = forwardRef<HTMLSpanElement, AssetSymbolProps>(function AssetSymbol(
  { symbol, name, icon, size = 'md', className, style, theme = 'light' },
  ref,
) {
  const fs = size === 'sm' ? 'var(--fc-type-label-md-size)' : size === 'lg' ? 'var(--fc-type-body-lg-size)' : 'var(--fc-type-body-md-size)';
  return (
    <span
      ref={ref}
      className={['fc-asset-symbol', className].filter(Boolean).join(' ')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--fc-space-2)', minWidth: 0, ...style }}
      title={name ?? symbol}
    >
      {icon ? <Icon as={icon} size={size === 'sm' ? 14 : 16} /> : null}
      <span style={{ fontFamily: 'var(--fc-font-sans)', fontSize: fs, fontWeight: 'var(--fc-type-label-md-weight)', color: cssVar('text-primary'), whiteSpace: 'nowrap' }}>{symbol}</span>
      {name ? <span style={{ fontFamily: 'var(--fc-font-sans)', fontSize: 'var(--fc-type-body-sm-size)', color: cssVar('text-muted'), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span> : null}
    </span>
  );
});

type AssetPairProps = BaseProps & {
  /** The base asset, e.g. `BTC`. */
  base: string;
  /** The quote asset, e.g. `USDT`. */
  quote: string;
  /** The venue or market label, e.g. `Binance`. */
  venue?: string;
  size?: 'sm' | 'md' | 'lg';
};

/**
 * AssetPair — a trading pair, formatted canonically.
 *
 * `BASE/QUOTE` with the separator in the muted tone, so the two assets are visually distinct
 * without relying on weight alone. The venue is a trailing badge when supplied.
 */
export const AssetPair = forwardRef<HTMLSpanElement, AssetPairProps>(function AssetPair(
  { base, quote, venue, size = 'md', className, style, theme = 'light' },
  ref,
) {
  const fs = size === 'sm' ? 'var(--fc-type-label-md-size)' : size === 'lg' ? 'var(--fc-type-body-lg-size)' : 'var(--fc-type-body-md-size)';
  return (
    <span
      ref={ref}
      className={['fc-asset-pair', className].filter(Boolean).join(' ')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--fc-space-2)', minWidth: 0, ...style }}
      title={`${base}/${quote}${venue ? ` · ${venue}` : ''}`}
    >
      <span style={{ fontFamily: 'var(--fc-font-mono)', fontSize: fs, fontWeight: 'var(--fc-type-label-md-weight)', color: cssVar('text-primary'), whiteSpace: 'nowrap' }}>
        {base}
        <span style={{ color: cssVar('text-muted'), fontWeight: 400 }}>{' / '}</span>
        {quote}
      </span>
      {venue ? <Badge tone="neutral" size="sm">{venue}</Badge> : null}
    </span>
  );
});

type TrendProps = BaseProps & {
  /** The direction. */
  direction: 'up' | 'down' | 'flat';
  /** The magnitude, rendered as a signed percentage. */
  value?: number | null;
  precision?: number;
  size?: 'sm' | 'md' | 'lg';
};

/**
 * Trend — a direction and magnitude.
 *
 * The arrow is the non-colour cue and is always present; the value is optional so a caller
 * can show a bare direction. The tone follows the direction but never carries it alone.
 */
export const Trend = forwardRef<HTMLSpanElement, TrendProps>(function Trend(
  { direction, value = null, precision, size = 'md', className, style, theme = 'light' },
  ref,
) {
  const cue = direction === 'up' ? nonColorCues.up : direction === 'down' ? nonColorCues.down : nonColorCues.flat;
  const tone: Tone = direction === 'up' ? 'positive' : direction === 'down' ? 'negative' : 'neutral';
  const role: SemanticToken = tone === 'positive' ? 'positive-critical' : tone === 'negative' ? 'negative-critical' : 'text-muted';
  const fs = size === 'sm' ? 'var(--fc-type-data-sm-size)' : size === 'lg' ? 'var(--fc-type-data-lg-size)' : 'var(--fc-type-data-md-size)';
  const text = value === null ? null : formatPercentage(value, { precision, signed: true });
  return (
    <span
      ref={ref}
      className={['fc-trend', `fc-trend-${direction}`, className].filter(Boolean).join(' ')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--fc-space-1)', ...style }}
      title={`Trend ${direction}${text ? ` ${text}` : ''}`}
    >
      <span aria-hidden="true" style={{ fontFamily: 'var(--fc-font-mono)', fontSize: fs, color: cssVar(role), lineHeight: 1 }}>{cue}</span>
      {text ? (
        <DataValue size={size === 'sm' ? 'sm' : size === 'lg' ? 'lg' : 'md'} tone={tone === 'neutral' ? 'muted' : tone}>
          {text}
        </DataValue>
      ) : null}
      <span className="fc-sr-only">{`Trend ${direction}`}</span>
    </span>
  );
});

/** The timeframe vocabulary. A single representation, not a selection group. */
export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

type TimeframeProps = BaseProps & {
  /** The timeframe label. Free-form so a venue-specific interval still renders. */
  value: string;
  size?: 'sm' | 'md';
};

/**
 * Timeframe — a single interval label.
 *
 * A representation primitive, not a selection group: the plan puts the group in Section 02.
 * Rendered in the mono family because an interval is a technical value.
 */
export const Timeframe = forwardRef<HTMLSpanElement, TimeframeProps>(function Timeframe(
  { value, size = 'md', className, style, theme = 'light' },
  ref,
) {
  return (
    <span
      ref={ref}
      className={['fc-timeframe', className].filter(Boolean).join(' ')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 'var(--fc-radius-sm)',
        background: cssVar('surface-secondary'),
        border: `1px solid ${cssVar('border-subtle')}`,
        fontFamily: 'var(--fc-font-mono)',
        fontSize: size === 'sm' ? 'var(--fc-type-data-xs-size)' : 'var(--fc-type-data-sm-size)',
        fontWeight: 500,
        fontVariantNumeric: 'tabular-nums',
        color: cssVar('text-secondary'),
        ...style,
      }}
    >
      {value}
    </span>
  );
});

type ConfidenceProps = BaseProps & {
  /** 0–100. Values outside the range are clamped. */
  value: number;
  /** Shows the numeric value beside the bar. */
  showValue?: boolean;
};

/** The confidence band a value falls in. */
export function confidenceBand(value: number): 'low' | 'medium' | 'high' {
  if (!Number.isFinite(value)) return 'low';
  if (value >= 70) return 'high';
  if (value >= 40) return 'medium';
  return 'low';
}

/**
 * Confidence — a 0–100 confidence figure with its band.
 *
 * The band is a WORD, not just a colour: `Low`, `Medium` or `High` renders beside the bar so
 * the meaning survives a colour-blind reader and a forced-colors palette.
 */
export const Confidence = forwardRef<HTMLSpanElement, ConfidenceProps>(function Confidence(
  { value, showValue = true, className, style, theme = 'light' },
  ref,
) {
  const clamped = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  const band = confidenceBand(clamped);
  const tone: Tone = band === 'high' ? 'positive' : band === 'medium' ? 'warning' : 'negative';
  const fill: SemanticToken = band === 'high' ? 'positive' : band === 'medium' ? 'warning' : 'negative';
  return (
    <span
      ref={ref}
      className={['fc-confidence', className].filter(Boolean).join(' ')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--fc-space-2)', ...style }}
      title={`Confidence ${band} (${Math.round(clamped)}%)`}
    >
      <span aria-hidden="true" style={{ position: 'relative', display: 'block', width: 48, height: 4, borderRadius: 'var(--fc-radius-full)', background: cssVar('surface-secondary'), border: `1px solid ${cssVar('border-subtle')}`, overflow: 'hidden' }}>
        <span style={{ display: 'block', width: `${clamped}%`, height: '100%', background: cssVar(fill) }} />
      </span>
      <Badge tone={tone} size="sm">
        {band === 'high' ? 'High' : band === 'medium' ? 'Medium' : 'Low'}
      </Badge>
      {showValue ? (
        <DataValue size="xs" tone="muted">{`${Math.round(clamped)}%`}</DataValue>
      ) : null}
    </span>
  );
});

/** The market-status vocabulary. */
export type MarketState = 'open' | 'closed' | 'delayed' | 'stale' | 'halted' | 'pre' | 'post';

/** The human-readable label and tone per state. */
const MARKET_STATUS: Record<MarketState, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'positive' },
  closed: { label: 'Closed', tone: 'neutral' },
  delayed: { label: 'Delayed', tone: 'warning' },
  stale: { label: 'Stale', tone: 'warning' },
  halted: { label: 'Halted', tone: 'negative' },
  pre: { label: 'Pre-market', tone: 'info' },
  post: { label: 'After hours', tone: 'info' },
};

type MarketStatusProps = BaseProps & {
  state: MarketState;
  /** Overrides the default label. */
  label?: string;
};

/**
 * MarketStatus — a venue's trading state, in words.
 *
 * The label is the contract: a colour alone cannot tell a user whether a market is delayed
 * or halted, and those two states demand different decisions.
 */
export const MarketStatus = forwardRef<HTMLSpanElement, MarketStatusProps>(function MarketStatus(
  { state, label, className, style, theme = 'light' },
  ref,
) {
  const s = MARKET_STATUS[state];
  return (
    <span ref={ref} className={['fc-market-status', className].filter(Boolean).join(' ')} style={style}>
      <Badge tone={s.tone} size="sm">{label ?? s.label}</Badge>
    </span>
  );
});

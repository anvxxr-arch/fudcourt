/**
 * atoms/financial — Price, Currency, Quantity, Percentage, Delta, PnL, Ratio, Yield, APR,
 * APY, MarketCap, Volume, DataNumber.
 *
 * Every one of these renders in Geist Mono with tabular figures. That is the plan's answer to
 * "financial numerics must not shift width unpredictably when digits update" — a proportional
 * font reflows a price column on every tick.
 *
 * Directional state carries a NON-COLOUR CUE. `Delta` renders `↑ +2.41%`, not a green number.
 * The colour is reinforcement; the arrow and the sign are the message.
 */
import { forwardRef, type ReactNode } from 'react';
import { cssVar, type SemanticToken } from '@/ui/foundations/color';
import { nonColorCues } from '@/ui/foundations/accessibility';
import { DataValue, type Tone } from '@/ui/atoms/typography';
import {
  DIRECTION_CUE,
  formatCurrency,
  formatDelta,
  formatLargeNumber,
  formatMarketCap,
  formatPercentage,
  formatPnL,
  formatPrice,
  formatQuantity,
  formatRatio,
  formatVolume,
  formatYield,
} from './format';

/** A semantic state a financial value can carry. */
export type FinancialState = 'default' | 'positive' | 'negative' | 'stale' | 'loading';

/** The tone each state resolves to. */
const STATE_TONE: Record<FinancialState, Tone> = {
  default: 'default',
  positive: 'positive',
  negative: 'negative',
  stale: 'muted',
  loading: 'muted',
};

/** A data-scale size. */
export type DataSize = 'display' | 'lg' | 'md' | 'sm' | 'xs';

/** Props shared by every financial display atom. */
interface FinancialProps {
  size?: DataSize;
  state?: FinancialState;
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
  /** Renders the value struck through with a stale marker. */
  staleLabel?: string;
}

/**
 * Price — a market price.
 *
 * `flash` is the plan's "short live-flash state": the value carries a class that runs the
 * realtime flash keyframe once. The subscription that produces ticks is OUT OF SCOPE — this
 * atom only renders the state it is handed.
 */
export const Price = forwardRef<HTMLSpanElement, FinancialProps & { value: number | null | undefined; precision?: number; adaptive?: boolean; flash?: 'up' | 'down' | null }>(
  function Price({ value, precision, adaptive = true, flash = null, size = 'md', state = 'default', className, style, theme = 'light', staleLabel }, ref) {
    const text = formatPrice(value, { precision, adaptive });
    const flashClass = flash === 'up' ? 'fc-flash-positive' : flash === 'down' ? 'fc-flash-negative' : undefined;
    return (
      <DataValue
        ref={ref}
        size={size}
        tone={STATE_TONE[state]}
        className={[flashClass, className].filter(Boolean).join(' ')}
        style={style}
        theme={theme}
        title={staleLabel}
      >
        {state === 'stale' && staleLabel ? `${text} ${staleLabel}` : text}
      </DataValue>
    );
  },
);

/** Currency — a monetary amount with its ISO code. */
export const Currency = forwardRef<HTMLSpanElement, FinancialProps & { value: number | null | undefined; code?: string; precision?: number }>(
  function Currency({ value, code, precision, size = 'md', state = 'default', className, style, theme = 'light' }, ref) {
    return (
      <DataValue ref={ref} size={size} tone={STATE_TONE[state]} className={className} style={style} theme={theme}>
        {formatCurrency(value, { code, precision })}
      </DataValue>
    );
  },
);

/** Quantity — an asset amount or position size. */
export const Quantity = forwardRef<HTMLSpanElement, FinancialProps & { value: number | null | undefined; precision?: number; unit?: string }>(
  function Quantity({ value, precision, unit, size = 'md', state = 'default', className, style, theme = 'light' }, ref) {
    const body = formatQuantity(value, { precision });
    return (
      <DataValue ref={ref} size={size} tone={STATE_TONE[state]} className={className} style={style} theme={theme}>
        {body === '—' || !unit ? body : `${body} ${unit}`}
      </DataValue>
    );
  },
);

/** Percentage — a rate or share. `signed` adds `+` to positives. */
export const Percentage = forwardRef<HTMLSpanElement, FinancialProps & { value: number | null | undefined; precision?: number; signed?: boolean }>(
  function Percentage({ value, precision, signed, size = 'md', state = 'default', className, style, theme = 'light' }, ref) {
    return (
      <DataValue ref={ref} size={size} tone={STATE_TONE[state]} className={className} style={style} theme={theme}>
        {formatPercentage(value, { precision, signed })}
      </DataValue>
    );
  },
);

/**
 * Delta — a change, with its direction made explicit.
 *
 * Renders `↑ +2.41%` by default. The arrow and the sign are the non-colour cue; the tone is
 * reinforcement. `showCue={false}` drops the arrow for a caller that supplies its own.
 */
export const Delta = forwardRef<HTMLSpanElement, FinancialProps & { value: number | null | undefined; precision?: number; showCue?: boolean }>(
  function Delta({ value, precision, showCue = true, size = 'md', state = 'default', className, style, theme = 'light' }, ref) {
    const { text, direction } = formatDelta(value, { precision, signed: true });
    const cue = DIRECTION_CUE[direction];
    const tone: Tone = state !== 'default' ? STATE_TONE[state] : direction === 'up' ? 'positive' : direction === 'down' ? 'negative' : 'muted';
    return (
      <DataValue ref={ref} size={size} tone={tone} className={className} style={style} theme={theme}>
        {showCue && cue ? `${cue} ${text}` : text}
      </DataValue>
    );
  },
);

/** PnL — a profit or loss, always signed. */
export const PnL = forwardRef<HTMLSpanElement, FinancialProps & { value: number | null | undefined; code?: string; precision?: number; showCue?: boolean }>(
  function PnL({ value, code, precision, showCue = true, size = 'md', state = 'default', className, style, theme = 'light' }, ref) {
    const body = formatPnL(value, { code, precision });
    const n = value ?? null;
    const direction = n === null || !Number.isFinite(n) ? 'absent' : n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
    const cue = DIRECTION_CUE[direction];
    const tone: Tone = state !== 'default' ? STATE_TONE[state] : direction === 'up' ? 'positive' : direction === 'down' ? 'negative' : 'default';
    return (
      <DataValue ref={ref} size={size} tone={tone} className={className} style={style} theme={theme}>
        {showCue && cue ? `${cue} ${body}` : body}
      </DataValue>
    );
  },
);

/** Ratio — leverage, a multiple, a coverage figure. */
export const Ratio = forwardRef<HTMLSpanElement, FinancialProps & { value: number | null | undefined; precision?: number }>(
  function Ratio({ value, precision, size = 'md', state = 'default', className, style, theme = 'light' }, ref) {
    return (
      <DataValue ref={ref} size={size} tone={STATE_TONE[state]} className={className} style={style} theme={theme}>
        {formatRatio(value, { precision })}
      </DataValue>
    );
  },
);

/** Yield — a yield or rate. */
export const Yield = forwardRef<HTMLSpanElement, FinancialProps & { value: number | null | undefined; precision?: number }>(
  function Yield({ value, precision, size = 'md', state = 'default', className, style, theme = 'light' }, ref) {
    return (
      <DataValue ref={ref} size={size} tone={STATE_TONE[state]} className={className} style={style} theme={theme}>
        {formatYield(value, { precision })}
      </DataValue>
    );
  },
);

/** APR — annual percentage rate. */
export const APR = forwardRef<HTMLSpanElement, FinancialProps & { value: number | null | undefined; precision?: number }>(
  function APR({ value, precision, size = 'md', state = 'default', className, style, theme = 'light' }, ref) {
    return (
      <DataValue ref={ref} size={size} tone={STATE_TONE[state]} className={className} style={style} theme={theme}>
        {formatPercentage(value, { precision, signed: false })}
      </DataValue>
    );
  },
);

/** APY — annual percentage yield. */
export const APY = forwardRef<HTMLSpanElement, FinancialProps & { value: number | null | undefined; precision?: number }>(
  function APY({ value, precision, size = 'md', state = 'default', className, style, theme = 'light' }, ref) {
    return (
      <DataValue ref={ref} size={size} tone={STATE_TONE[state]} className={className} style={style} theme={theme}>
        {formatPercentage(value, { precision, signed: false })}
      </DataValue>
    );
  },
);

/** MarketCap — compact by default. */
export const MarketCap = forwardRef<HTMLSpanElement, FinancialProps & { value: number | null | undefined; compact?: boolean }>(
  function MarketCap({ value, compact = true, size = 'md', state = 'default', className, style, theme = 'light' }, ref) {
    return (
      <DataValue ref={ref} size={size} tone={STATE_TONE[state]} className={className} style={style} theme={theme}>
        {formatMarketCap(value, { compact })}
      </DataValue>
    );
  },
);

/** Volume — compact by default. */
export const Volume = forwardRef<HTMLSpanElement, FinancialProps & { value: number | null | undefined; compact?: boolean }>(
  function Volume({ value, compact = true, size = 'md', state = 'default', className, style, theme = 'light' }, ref) {
    return (
      <DataValue ref={ref} size={size} tone={STATE_TONE[state]} className={className} style={style} theme={theme}>
        {formatVolume(value, { compact })}
      </DataValue>
    );
  },
);

/**
 * DataNumber — an arbitrary financial numeric, formatted by the caller.
 *
 * The escape hatch for a value none of the specialised atoms covers, so a caller never has
 * to hand-roll a mono+tabular span and drift the family. Still Geist Mono, still tabular.
 */
export const DataNumber = forwardRef<HTMLSpanElement, FinancialProps & { children: ReactNode; as?: 'span' | 'div' | 'td' }>(
  function DataNumber({ children, size = 'md', state = 'default', className, style, theme = 'light', as = 'span' }, ref) {
    return (
      <DataValue ref={ref} size={size} tone={STATE_TONE[state]} className={className} style={style} theme={theme} as={as}>
        {children}
      </DataValue>
    );
  },
);

/** Re-export the formatting core so a consumer has one import for both layers. */
export {
  formatCurrency,
  formatDelta,
  formatLargeNumber,
  formatMarketCap,
  formatPercentage,
  formatPnL,
  formatPrice,
  formatQuantity,
  formatRatio,
  formatVolume,
  formatYield,
} from './format';

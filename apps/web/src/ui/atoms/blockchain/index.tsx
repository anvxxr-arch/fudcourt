/**
 * atoms/blockchain — WalletAddress, TransactionHash, BlockNumber, GasValue.
 *
 * Geist Mono and tabular, because these are the values whose width must not shift as a
 * character changes and whose characters must not be confused (a `0` and an `O` in a
 * proportional font are a real hazard in a hex string).
 *
 * TRUNCATION IS PRESENTATION-ONLY. The full value is always available — as the `title`, as
 * the accessible content, and as the clipboard target on `copy`. The underlying value is
 * never mutated, never re-cased, never stripped of its prefix.
 *
 * NO RPC, NO EXPLORER API. These atoms render a string they are handed.
 */
import { forwardRef } from 'react';
import { cssVar } from '@/ui/foundations/color';
import { focusRingClass, srOnlyClass } from '@/ui/foundations/accessibility';
import { DataValue } from '@/ui/atoms/typography';
import { Button } from '@/ui/atoms/actions';

type BaseProps = {
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
  size?: 'sm' | 'md' | 'lg';
};

/** The data-scale size key each visual size maps to. */
const DATA_SIZE = { sm: 'sm', md: 'md', lg: 'lg' } as const;

/**
 * Truncate a hex-ish value for display, keeping the head and the tail.
 *
 * A value shorter than the budget is returned whole — truncating `0xabc` to `0xabc…def`
 * would be inventing characters. The ellipsis is a single `…`, not `...`, so the width is
 * predictable.
 */
function truncate(value: string, head: number, tail: number): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

/** The shared shell: a mono value, its full text on hover, and a copy control. */
function HashShell({
  display,
  full,
  copy,
  size,
  className,
  style,
  theme,
  tone,
}: {
  display: string;
  full: string;
  copy?: boolean;
  size: 'sm' | 'md' | 'lg';
  className?: string;
  style?: React.CSSProperties;
  theme: 'light' | 'dark';
  tone: 'default' | 'muted';
}) {
  return (
    <span
      className={['fc-hash', className].filter(Boolean).join(' ')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--fc-space-2)', minWidth: 0, ...style }}
      title={full}
    >
      {/* The visually-hidden full value is what a screen reader announces; the visible
          truncation is decoration. */}
      <span className={srOnlyClass}>{full}</span>
      <DataValue size={DATA_SIZE[size]} tone={tone} aria-hidden="true">{display}</DataValue>
      {copy ? (
        <Button
          variant="ghost"
          size="xs"
          aria-label={`Copy ${full}`}
          onClick={() => void navigator.clipboard?.writeText(full)}
          className={focusRingClass}
          style={{ minHeight: 20, padding: '0 6px', fontSize: 'var(--fc-type-data-xs-size)' }}
        >
          Copy
        </Button>
      ) : null}
    </span>
  );
}

type WalletAddressProps = BaseProps & {
  /** The full address. Rendered in full to the accessibility tree and the clipboard. */
  address: string;
  /** Characters to keep at each end. Default 6/4. */
  truncateTo?: [number, number];
  /** Shows a copy control. */
  copy?: boolean;
};

/**
 * WalletAddress — a chain address, safely truncated.
 *
 * An empty address renders the em dash rather than an empty box: an absent address is a
 * state the caller must be able to show, and `0x…` would be a fabricated one.
 */
export const WalletAddress = forwardRef<HTMLSpanElement, WalletAddressProps>(function WalletAddress(
  { address, truncateTo = [6, 4], copy, size = 'md', className, style, theme = 'light' },
  ref,
) {
  if (!address) {
    return (
      <span ref={ref} className={className} style={style}>
        <DataValue size={DATA_SIZE[size]} tone="muted">—</DataValue>
      </span>
    );
  }
  const [head, tail] = truncateTo;
  return (
    <span ref={ref} style={{ display: 'inline-flex', minWidth: 0 }}>
      <HashShell display={truncate(address, head, tail)} full={address} copy={copy} size={size} className={className} style={style} theme={theme} tone="default" />
    </span>
  );
});

type TransactionHashProps = BaseProps & {
  /** The full transaction hash. */
  hash: string;
  truncateTo?: [number, number];
  copy?: boolean;
};

/** TransactionHash — a tx hash, safely truncated. Same contract as `WalletAddress`. */
export const TransactionHash = forwardRef<HTMLSpanElement, TransactionHashProps>(function TransactionHash(
  { hash, truncateTo = [8, 6], copy, size = 'md', className, style, theme = 'light' },
  ref,
) {
  if (!hash) {
    return (
      <span ref={ref} className={className} style={style}>
        <DataValue size={DATA_SIZE[size]} tone="muted">—</DataValue>
      </span>
    );
  }
  const [head, tail] = truncateTo;
  return (
    <span ref={ref} style={{ display: 'inline-flex', minWidth: 0 }}>
      <HashShell display={truncate(hash, head, tail)} full={hash} copy={copy} size={size} className={className} style={style} theme={theme} tone="default" />
    </span>
  );
});

type BlockNumberProps = BaseProps & {
  /** The block height. */
  block: number | null | undefined;
  /** Groups thousands. Default true. */
  grouped?: boolean;
};

/**
 * BlockNumber — a block height.
 *
 * Grouped by default (`21,450,332`) because an ungrouped seven-digit height is hard to read
 * and the grouping costs nothing at this width. Tabular, so a live block counter does not
 * jitter.
 */
export const BlockNumber = forwardRef<HTMLSpanElement, BlockNumberProps>(function BlockNumber(
  { block, grouped = true, size = 'md', className, style, theme = 'light' },
  ref,
) {
  const n = block === null || block === undefined || !Number.isFinite(block) ? null : block;
  const text = n === null ? '—' : n.toLocaleString('en-US', { useGrouping: grouped, maximumFractionDigits: 0 });
  return (
    <span ref={ref} className={className} style={style}>
      <DataValue size={DATA_SIZE[size]} tone={n === null ? 'muted' : 'default'}>{text}</DataValue>
    </span>
  );
});

type GasValueProps = BaseProps & {
  /** The gas price. */
  value: number | null | undefined;
  /** The unit, e.g. `gwei`. Default `gwei`. */
  unit?: string;
  precision?: number;
};

/**
 * GasValue — a gas price with its unit.
 *
 * The unit is muted and set beside the figure rather than appended into the same string, so
 * a caller can drop it for a tight column without reformatting the number.
 */
export const GasValue = forwardRef<HTMLSpanElement, GasValueProps>(function GasValue(
  { value, unit = 'gwei', precision = 2, size = 'md', className, style, theme = 'light' },
  ref,
) {
  const n = value === null || value === undefined || !Number.isFinite(value) ? null : value;
  return (
    <span
      ref={ref}
      className={['fc-gas', className].filter(Boolean).join(' ')}
      style={{ display: 'inline-flex', alignItems: 'baseline', gap: 'var(--fc-space-1)', ...style }}
      title={n === null ? undefined : `${n} ${unit}`}
    >
      <DataValue size={DATA_SIZE[size]} tone={n === null ? 'muted' : 'default'}>
        {n === null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: precision, maximumFractionDigits: precision })}
      </DataValue>
      {n === null ? null : (
        <span style={{ fontFamily: 'var(--fc-font-sans)', fontSize: 'var(--fc-type-label-sm-size)', color: cssVar('text-muted') }}>{unit}</span>
      )}
    </span>
  );
});

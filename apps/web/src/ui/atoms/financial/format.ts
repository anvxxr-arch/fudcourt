/**
 * atoms/financial/format.ts — the canonical financial formatting layer.
 *
 * ONE module. Every financial display atom formats through here, so a price rendered
 * `331.74` in one table and `331.740000` in another is impossible by construction.
 *
 * The rules that make this correctness-critical rather than cosmetic:
 *
 *   1. NEGATIVE ZERO IS NORMALIZED. `-0` prints as `0`, never `-0`. A position that is
 *      exactly flat must not read as a loss.
 *   2. NULL/UNDEFINED/NaN/Infinity ARE ABSENT, NEVER ZERO. The project's standing rule
 *      (`src/lib/num.ts`): an absent metric is `—`, never a fabricated `0`.
 *   3. PRECISION IS EXPLICIT. A caller passes the digits it wants; the module never guesses
 *      from magnitude unless asked to (`adaptive`).
 *   4. SIGN DISPLAY IS EXPLICIT. `+` on a positive delta is a choice, not a default, because
 *      a price is not a delta.
 *
 * Pure functions, no React, no DOM — importable from a server component and unit-testable
 * without a renderer.
 */

/** Shown for a value the upstream did not report. */
export const DASH = '—';

/** A locale strategy. `en-US` is the deterministic default; `local` follows the runtime. */
export type LocaleStrategy = 'en-US' | 'local';

/** Resolve a locale strategy to a BCP-47 tag. */
function localeOf(strategy: LocaleStrategy): string | undefined {
  return strategy === 'local' ? undefined : 'en-US';
}

/**
 * Normalize a value for formatting.
 *
 * `null`, `undefined`, `NaN`, `Infinity` and `-Infinity` all become `null` — absent. `-0`
 * becomes `0`. Everything else is returned as a finite number.
 */
function normalize(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  // `-0` and `0` are the same number; `Object.is` distinguishes them and the sign is the
  // only thing that would survive into the output.
  if (Object.is(value, -0)) return 0;
  return value;
}

/** Options shared by every formatter. */
export interface FormatOptions {
  /** Fraction digits. Required unless the formatter derives them. */
  precision?: number;
  /** Group thousands. Default true. */
  grouped?: boolean;
  /** Locale strategy. Default `en-US`. */
  locale?: LocaleStrategy;
  /** What to render for an absent value. Default `—`. */
  empty?: string;
}

/** Apply the shared options and render. */
function render(value: number | null, options: FormatOptions, digits: number): string {
  const n = normalize(value);
  if (n === null) return options.empty ?? DASH;
  return n.toLocaleString(localeOf(options.locale ?? 'en-US'), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: options.grouped ?? true,
  });
}

/**
 * A price.
 *
 * `adaptive` picks precision from magnitude — 2dp at/above 1, 4dp at/above 0.01, 8dp below
 * — which is the shape a market quote needs (BTC at 67,432.18, a micro-cap at 0.00001234).
 * An explicit `precision` always wins.
 */
export function formatPrice(value: number | null | undefined, options: FormatOptions & { adaptive?: boolean } = {}): string {
  const n = normalize(value);
  // Zero is a real measurement, not a sub-cent price: it renders at the base 2dp rather
  // than at the 8dp the adaptive rule would give a tiny magnitude.
  const digits = options.precision ?? (options.adaptive === false || n === 0 ? 2 : adaptiveDigits(n));
  return render(value, options, digits);
}

/** The adaptive digit count for a magnitude. */
function adaptiveDigits(abs: number): number {
  const a = Math.abs(abs);
  if (a >= 1) return 2;
  if (a >= 0.01) return 4;
  return 8;
}

/**
 * A currency amount.
 *
 * `code` is the ISO code rendered as a suffix (`$` is a symbol, not a code, and is passed as
 * `prefix` by the caller that wants it). The code is never localized — `USD` is `USD` in
 * every locale, and a translated currency code is a wrong currency code.
 */
export function formatCurrency(value: number | null | undefined, options: FormatOptions & { code?: string } = {}): string {
  const digits = options.precision ?? 2;
  const body = render(value, options, digits);
  if (body === (options.empty ?? DASH) || !options.code) return body;
  return `${body} ${options.code}`;
}

/** A quantity — an asset amount, a position size, a fill. */
export function formatQuantity(value: number | null | undefined, options: FormatOptions = {}): string {
  return render(value, options, options.precision ?? 4);
}

/**
 * A percentage.
 *
 * `signed` adds `+` to a positive value — correct for a change, wrong for a static rate.
 * `withSign` appends the `%` glyph; pass false when the caller owns the unit.
 */
export function formatPercentage(
  value: number | null | undefined,
  options: FormatOptions & { signed?: boolean; withSign?: boolean } = {},
): string {
  const n = normalize(value);
  if (n === null) return options.empty ?? DASH;
  const digits = options.precision ?? 2;
  const body = n.toLocaleString(localeOf(options.locale ?? 'en-US'), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: options.grouped ?? true,
    signDisplay: options.signed ? 'exceptZero' : 'auto',
  });
  return options.withSign === false ? body : `${body}%`;
}

/**
 * A ratio — leverage, a coverage figure, a multiple.
 *
 * Rendered with a trailing `×` so `5` reads as `5×` and cannot be mistaken for a count.
 */
export function formatRatio(value: number | null | undefined, options: FormatOptions = {}): string {
  const body = render(value, options, options.precision ?? 2);
  return body === (options.empty ?? DASH) ? body : `${body}×`;
}

/** APR — the annual percentage rate, as a plain signed percentage. */
export function formatAPR(value: number | null | undefined, options: FormatOptions = {}): string {
  return formatPercentage(value, { ...options, signed: false, withSign: true });
}

/** A yield or rate — APR/APY before the display atoms specialise them. */
export function formatYield(value: number | null | undefined, options: FormatOptions = {}): string {
  return formatPercentage(value, { ...options, signed: false, withSign: true });
}

/**
 * A market cap or volume — a large number, optionally compact.
 *
 * `compact` renders `1.23B` / `45.0B` / `789.0M` / `12.3K` / `1.0K`. The thresholds are
 * the conventional financial ones; a `K` at 1,000 rather than 1,024 is the finance
 * convention, not a bug. One fractional digit minimum and two maximum: 1-2 significant
 * decimals, so a billion reads `1.23B` and never `1.234B`, and a hundred million reads
 * `789.0M` rather than `789M` (the trailing `.0` keeps a column's decimal points aligned).
 */
export function formatLargeNumber(
  value: number | null | undefined,
  options: FormatOptions & { compact?: boolean } = {},
): string {
  const n = normalize(value);
  if (n === null) return options.empty ?? DASH;
  if (!options.compact) return render(n, options, options.precision ?? 0);
  const abs = Math.abs(n);
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [scale, suffix] of units) {
    if (abs >= scale) {
      const scaled = n / scale;
      // One fractional digit minimum, two maximum: 1.23B keeps both it has, 45.0B pads to
      // one, 789.0M pads to one, 12.3K fits, 1.0K pads. The minimum is what keeps a column
      // of compact figures aligned on the decimal point; the maximum is what stops a
      // sub-unit value from printing digits nobody asked for.
      return `${scaled.toLocaleString(localeOf(options.locale ?? 'en-US'), {
        minimumFractionDigits: 1,
        maximumFractionDigits: 2,
        useGrouping: options.grouped ?? true,
      })}${suffix}`;
    }
  }
  return n.toLocaleString(localeOf(options.locale ?? 'en-US'), { maximumFractionDigits: 2, useGrouping: options.grouped ?? true });
}

/** A market cap. Compact by default — a raw 1,234,567,890,123 is unreadable in a table. */
export function formatMarketCap(value: number | null | undefined, options: FormatOptions & { compact?: boolean } = {}): string {
  return formatLargeNumber(value, { compact: true, ...options });
}

/** A volume. Compact by default, and `0` is a real measurement here, not an absent one. */
export function formatVolume(value: number | null | undefined, options: FormatOptions & { compact?: boolean } = {}): string {
  return formatLargeNumber(value, { compact: true, ...options });
}

/**
 * A signed delta — the change in a value, with its direction.
 *
 * Returns the formatted text AND the direction, because the plan forbids colour-only
 * meaning: a caller renders `↑ +2.41%` or `↓ −1.08%`, never a bare coloured number.
 */
export function formatDelta(
  value: number | null | undefined,
  options: FormatOptions & { signed?: boolean; withSign?: boolean } = {},
): { text: string; direction: 'up' | 'down' | 'flat' | 'absent' } {
  const n = normalize(value);
  if (n === null) return { text: options.empty ?? DASH, direction: 'absent' };
  const direction = n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
  const text = formatPercentage(n, { ...options, signed: options.signed ?? true, withSign: options.withSign });
  return { text, direction };
}

/** The non-colour cue for a direction, per the accessibility foundation. */
export const DIRECTION_CUE = { up: '↑', down: '↓', flat: '→', absent: '' } as const;

/**
 * A PnL figure — a profit or loss in currency terms.
 *
 * Always signed, because an unsigned PnL is ambiguous: `1,204.55` could be a gain or a loss
 * and the reader must not have to infer it from a colour.
 */
export function formatPnL(
  value: number | null | undefined,
  options: FormatOptions & { code?: string } = {},
): string {
  const n = normalize(value);
  if (n === null) return options.empty ?? DASH;
  const digits = options.precision ?? 2;
  const body = n.toLocaleString(localeOf(options.locale ?? 'en-US'), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: options.grouped ?? true,
    signDisplay: 'exceptZero',
  });
  return options.code ? `${body} ${options.code}` : body;
}

/**
 * Parse a user-typed financial value.
 *
 * The rules the plan requires tested:
 *   - empty / whitespace-only → `null` (absent, never `0`),
 *   - leading/trailing whitespace is stripped,
 *   - thousands separators are accepted and removed,
 *   - a non-finite result (`NaN`, `Infinity`) → `null`,
 *   - `-0` normalizes to `0`.
 */
export function parseFinancialInput(text: string): number | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  // Strip grouping separators and spaces, but keep a single leading sign and one dot.
  const cleaned = trimmed.replace(/[\s,]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '+' || cleaned === '.') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Object.is(value, -0) ? 0 : value;
}

/**
 * Clamp a value to a precision by rounding, without stringifying.
 *
 * `roundTo(1.005, 2)` is `1.01` in the caller's intent even though binary floating point
 * makes `1.005` slightly less than itself; the epsilon correction is what makes a displayed
 * `1.01` and a stored `1.01` agree.
 */
export function roundTo(value: number, precision: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = Math.pow(10, precision);
  return Math.round((value + Number.EPSILON * Math.sign(value)) * factor) / factor;
}

/**
 * Format a duration in milliseconds.
 *
 * `compact` is `2h 14m`, `long` is `2 hours 14 minutes`, `clock` is `02:14:33`. An absent
 * or negative duration is the em dash — a negative elapsed time is a clock bug, not a value
 * to print.
 */
export function formatDuration(ms: number | null | undefined, mode: 'compact' | 'long' | 'clock' = 'compact'): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return DASH;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (mode === 'clock') {
    const pad = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }
  if (mode === 'long') {
    const parts: string[] = [];
    if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
    if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
    if (sec || parts.length === 0) parts.push(`${sec} second${sec === 1 ? '' : 's'}`);
    return parts.join(' ');
  }
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec || parts.length === 0) parts.push(`${sec}s`);
  return parts.join(' ');
}

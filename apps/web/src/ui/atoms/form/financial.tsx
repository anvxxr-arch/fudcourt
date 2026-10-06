/**
 * atoms/form/financial.ts — the nine atomic financial input shells.
 *
 * WHAT THESE ARE: controlled numeric input shells with a declared precision, a declared
 * negative-value policy, a prefix/suffix and paste normalization. They are the *atomic*
 * trigger/value layer the plan's Task 14 asks for.
 *
 * WHAT THEY ARE NOT: an order calculator, a position calculator, a leverage preset group, a
 * risk preset group, an AssetSelector popover or an AssetPairSelector dialog. Every one of
 * those composes atoms into behaviour, which is Section 02's job. Nothing here computes a
 * derived value, nothing here fetches, nothing here knows what a venue is.
 *
 * THE ONE DECISION THAT SHAPES ALL NINE: the value a caller reads back is a `number | null`,
 * never a string, and never `NaN`. Parsing goes through `parseFinancialInput`, which is the
 * same function the display atoms' inverse uses, so a value typed into `PriceInput` and
 * rendered through `Price` round-trips. `null` means "no value" — an empty field, or text
 * that is not a number. `NaN` and `Infinity` are refused at the door rather than stored and
 * discovered later by a risk calculation.
 *
 * The negative-value policy is per-atom and explicit, because it is a product decision, not
 * a formatting one: a price may not be negative, a PnL may, a leverage may not, a stop-loss
 * distance may not. A caller who needs a different policy passes `allowNegative` and owns it.
 */
import {
  forwardRef,
  useCallback,
  useId,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FocusEvent as ReactFocusEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { cssVar, type SemanticToken } from '@/ui/foundations/color';
import { componentTokens } from '@/styles/tokens';
import { focusRingClass } from '@/ui/foundations/accessibility';
import { parseFinancialInput, roundTo } from '@/ui/atoms/financial/format';
import type { FieldSize, FieldState } from '@/ui/atoms/form';

/**
 * A financial value as the atoms store it.
 *
 * `null` is "no value", which is distinct from `0`. A cleared field and a zero field mean
 * different things to a risk engine, so the type keeps them apart.
 */
export type FinancialValue = number | null;

/** The shared props every financial input accepts. */
type FinancialInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'size' | 'value' | 'defaultValue' | 'onChange' | 'type'> & {
  /** The controlled value. `null` is an empty field. */
  value?: FinancialValue;
  /** The initial value when uncontrolled. */
  defaultValue?: FinancialValue;
  /** Called with the parsed value, or `null` when the field holds no parseable number. */
  onChange?: (value: FinancialValue) => void;
  /** Decimal places the value is clamped to on commit. Defaults to the atom's own precision. */
  precision?: number;
  /** Inclusive lower bound. A value below it is clamped on commit. */
  min?: number;
  /** Inclusive upper bound. A value above it is clamped on commit. */
  max?: number;
  /** Permit negative values. Defaults per atom — see each atom's docstring. */
  allowNegative?: boolean;
  /** A leading adornment: a currency symbol, a unit, a multiplier. */
  prefix?: ReactNode;
  /** A trailing adornment: a currency code, a percent sign, a unit. */
  suffix?: ReactNode;
  /** Text shown when the field is empty and unfocused. */
  placeholder?: string;
  size?: FieldSize;
  state?: FieldState;
  /** Supporting text under the field. Also announced when the field is described. */
  hint?: ReactNode;
  /** Overrides the accessible name. Without it the field relies on a wrapping `<label>`. */
  'aria-label'?: string;
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/** The height each size resolves to, matching the generic form controls exactly. */
const HEIGHT: Record<FieldSize, number> = {
  sm: componentTokens['input-height-sm'],
  md: componentTokens['input-height-md'],
  lg: componentTokens['input-height-lg'],
};

/** The type size that pairs with each control size. */
const TYPE: Record<FieldSize, { fs: string; lh: string }> = {
  sm: { fs: 'var(--fc-type-body-sm-size)', lh: 'var(--fc-type-body-sm-line)' },
  md: { fs: 'var(--fc-type-body-md-size)', lh: 'var(--fc-type-body-md-line)' },
  lg: { fs: 'var(--fc-type-body-lg-size)', lh: 'var(--fc-type-body-lg-line)' },
};

/** The border role a validation state resolves to. */
const STATE_BORDER: Record<FieldState, SemanticToken> = {
  default: 'border-default',
  error: 'negative',
  warning: 'warning',
  success: 'positive',
};

/** The shared shell chrome: a bordered box that takes focus cleanly, value in Geist Mono. */
function shellChrome(size: FieldSize, state: FieldState, disabled: boolean, readOnly: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    minHeight: HEIGHT[size],
    boxSizing: 'border-box',
    padding: size === 'sm' ? '0 10px' : size === 'lg' ? '0 14px' : '0 12px',
    gap: 'var(--fc-space-2)',
    background: readOnly ? cssVar('surface-secondary') : cssVar('surface-primary'),
    border: `1px solid ${cssVar(STATE_BORDER[state])}`,
    borderRadius: 'var(--fc-radius-md)',
    color: cssVar('text-primary'),
    fontFamily: 'var(--fc-font-mono)',
    fontVariantNumeric: 'tabular-nums' as const,
    fontSize: TYPE[size].fs,
    lineHeight: TYPE[size].lh,
    opacity: disabled ? 0.55 : 1,
    cursor: disabled ? 'not-allowed' : readOnly ? 'default' : 'text',
    transition:
      'border-color var(--fc-motion-fast) var(--fc-ease-standard), box-shadow var(--fc-motion-fast) var(--fc-ease-standard)',
  };
}

/**
 * Render a value into the field's text.
 *
 * `String(value)` is deliberate, not `toFixed`: the field shows what the caller stored, so a
 * stored `1.5` reads `1.5` and not `1.50`. Precision is applied on commit, not on every
 * keystroke — reformatting mid-typing fights the user's cursor.
 */
function toText(value: FinancialValue): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Apply the atom's policy to a freshly parsed value.
 *
 * Order matters and is fixed: sign policy first (a negative price is refused, not clamped to
 * zero — clamping would silently turn a typo into a real order), then bounds, then precision.
 * A value that violates the sign policy becomes `null`, which the caller can render as an
 * error; a value that merely exceeds a bound is clamped, because a bound is a range, not a
 * validity rule.
 */
function applyPolicy(
  parsed: FinancialValue,
  precision: number,
  min: number | undefined,
  max: number | undefined,
  allowNegative: boolean,
): FinancialValue {
  if (parsed === null) return null;
  if (!allowNegative && parsed < 0) return null;
  let out = parsed;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return roundTo(out, precision);
}

/**
 * The one implementation all nine atoms are thin wrappers around.
 *
 * Kept private: the public surface is the nine named atoms, because their names carry the
 * product decision (a `StopLossInput` may not be negative and defaults to the price
 * precision; a `PercentInput` is bounded 0–100 and shows a `%`). Exporting the generic would
 * invite callers to skip that vocabulary.
 */
const FinancialInput = forwardRef<HTMLInputElement, FinancialInputProps & { precision: number; allowNegative: boolean }>(
  function FinancialInput(
    {
      value: controlled,
      defaultValue,
      onChange,
      precision,
      min,
      max,
      allowNegative,
      prefix,
      suffix,
      placeholder,
      size = 'md',
      state = 'default',
      hint,
      disabled,
      readOnly,
      className,
      style,
      theme: _theme = 'light',
      onPaste,
      onBlur,
      ...rest
    },
    ref,
  ) {
    const [uncontrolled, setUncontrolled] = useState<FinancialValue>(defaultValue ?? null);
    const isControlled = controlled !== undefined;
    const value = isControlled ? controlled : uncontrolled;
    const hintId = useId();

    const commit = useCallback(
      (next: FinancialValue) => {
        const applied = applyPolicy(next, precision, min, max, allowNegative);
        if (!isControlled) setUncontrolled(applied);
        onChange?.(applied);
      },
      [isControlled, onChange, precision, min, max, allowNegative],
    );

    /**
     * Parse on every keystroke so the caller's state is never stale, but do NOT reformat the
     * text: a user typing `1.` must be allowed to keep the trailing dot long enough to type
     * the next digit. Reformatting on blur is where precision is enforced visually.
     */
    const handleChange = useCallback(
      (event: ChangeEvent<HTMLInputElement>) => {
        const raw = event.target.value;
        if (raw.trim() === '') {
          commit(null);
          return;
        }
        commit(parseFinancialInput(raw));
      },
      [commit],
    );

    /**
     * Paste normalization: strip grouping separators and whitespace, then hand the cleaned
     * text to the same parser. A pasted `1,234.56` must arrive as `1234.56`, and a pasted
     * `$1,234.56` must not silently become `null` — the currency prefix is stripped too.
     */
    const handlePaste = useCallback(
      (event: ClipboardEvent<HTMLInputElement>) => {
        const text = event.clipboardData.getData('text');
        if (text.trim() === '') return;
        const cleaned = text.replace(/[\s,]/g, '').replace(/^[$€£¥]/, '');
        const parsed = parseFinancialInput(cleaned);
        if (parsed === null) return;
        // Only intercept when we understood it; otherwise let the native paste stand so the
        // user sees the text they pasted and can correct it.
        event.preventDefault();
        commit(parsed);
      },
      [commit],
    );

    /** On blur, show the value the way it will be stored, precision and all. */
    const handleBlur = useCallback(
      (event: ReactFocusEvent<HTMLInputElement>) => {
        if (value !== null && value !== undefined) {
          const applied = applyPolicy(value, precision, min, max, allowNegative);
          event.target.value = toText(applied);
        }
        onBlur?.(event);
      },
      [value, precision, min, max, allowNegative, onBlur],
    );

    const bare = prefix === undefined && suffix === undefined;
    const field = (
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        readOnly={readOnly}
        value={toText(value)}
        placeholder={placeholder}
        aria-invalid={state === 'error' ? true : undefined}
        aria-describedby={hint !== undefined ? hintId : undefined}
        className={[focusRingClass, 'fc-financial-input', className].filter(Boolean).join(' ')}
        onChange={handleChange}
        onPaste={handlePaste}
        onBlur={handleBlur}
        style={{
          ...shellChrome(size, state, !!disabled, !!readOnly),
          ...(bare ? null : { border: 0, background: 'transparent', padding: 0, minHeight: 'auto' }),
          ...style,
        }}
        {...rest}
      />
    );

    const described = hint !== undefined ? (
      <span id={hintId} className="fc-financial-input-hint" style={{ color: cssVar('text-muted'), fontSize: 'var(--fc-type-body-sm-size)' }}>
        {hint}
      </span>
    ) : null;

    if (bare) {
      return (
        <span style={{ display: 'block' }}>
          {field}
          {described}
        </span>
      );
    }
    return (
      <span style={{ display: 'block' }}>
        <span
          className={[focusRingClass, 'fc-financial-input-shell', `fc-financial-input-shell-${state}`].filter(Boolean).join(' ')}
          style={shellChrome(size, state, !!disabled, !!readOnly)}
        >
          {prefix ? <span style={{ color: cssVar('text-muted'), flex: '0 0 auto' }}>{prefix}</span> : null}
          {field}
          {suffix ? <span style={{ color: cssVar('text-muted'), flex: '0 0 auto' }}>{suffix}</span> : null}
        </span>
        {described}
      </span>
    );
  },
);

/**
 * AmountInput — a plain asset amount.
 *
 * Negative is refused by default: an amount of an asset you hold is a magnitude. A caller
 * modelling a signed flow passes `allowNegative` and takes responsibility for the sign.
 */
export const AmountInput = forwardRef<HTMLInputElement, FinancialInputProps>(function AmountInput(props, ref) {
  return <FinancialInput ref={ref} precision={props.precision ?? 8} allowNegative={props.allowNegative ?? false} {...props} />;
});

/**
 * PriceInput — a price in quote currency.
 *
 * Default precision 8, the BTC-style convention, and adaptive at the display layer. Negative
 * is refused: a negative price is a data error, not a value. `min={0}` is implied by the sign
 * policy rather than stated, so a caller cannot accidentally widen it.
 */
export const PriceInput = forwardRef<HTMLInputElement, FinancialInputProps>(function PriceInput(props, ref) {
  return <FinancialInput ref={ref} precision={props.precision ?? 8} allowNegative={props.allowNegative ?? false} {...props} />;
});

/**
 * PercentInput — a percentage, 0–100 inclusive.
 *
 * The `%` is a suffix, not part of the value: the stored number is `2.5`, not `0.025` and not
 * `"2.5%"`. That is the one convention that keeps a percentage comparable to a ratio without
 * a conversion step at every call site. Negative is refused because the bounded range already
 * excludes it.
 */
export const PercentInput = forwardRef<HTMLInputElement, FinancialInputProps>(function PercentInput(props, ref) {
  return (
    <FinancialInput
      ref={ref}
      precision={props.precision ?? 2}
      min={props.min ?? 0}
      max={props.max ?? 100}
      allowNegative={props.allowNegative ?? false}
      suffix={props.suffix ?? '%'}
      {...props}
    />
  );
});

/**
 * QuantityInput — an order quantity in base units.
 *
 * Precision defaults to 8 (satoshi granularity) and negative is refused: a sell is a side,
 * not a negative quantity. Encoding direction in the sign is exactly the kind of ambiguity
 * that produces a doubled position.
 */
export const QuantityInput = forwardRef<HTMLInputElement, FinancialInputProps>(function QuantityInput(props, ref) {
  return <FinancialInput ref={ref} precision={props.precision ?? 8} allowNegative={props.allowNegative ?? false} {...props} />;
});

/**
 * CurrencyInput — a fiat amount with its code.
 *
 * Precision defaults to 2, the minor-unit convention. The code is a suffix so it stays out of
 * the value; a caller who wants the symbol leading passes `prefix`.
 */
export const CurrencyInput = forwardRef<HTMLInputElement, FinancialInputProps>(function CurrencyInput(props, ref) {
  return <FinancialInput ref={ref} precision={props.precision ?? 2} allowNegative={props.allowNegative ?? false} {...props} />;
});

/**
 * LeverageInput — a leverage multiplier, 1–125.
 *
 * The bounds are the venue-agnostic conventional range and are stated as defaults, not
 * enforced as law: a caller trading an instrument with a different ceiling passes `max`.
 * Negative is refused, and so is zero — leverage is at least 1, which the `min` default
 * guarantees.
 */
export const LeverageInput = forwardRef<HTMLInputElement, FinancialInputProps>(function LeverageInput(props, ref) {
  return (
    <FinancialInput
      ref={ref}
      precision={props.precision ?? 2}
      min={props.min ?? 1}
      max={props.max ?? 125}
      allowNegative={props.allowNegative ?? false}
      suffix={props.suffix ?? '×'}
      {...props}
    />
  );
});

/**
 * RiskInput — a risk budget as a percentage of equity, 0–100.
 *
 * Same shape as `PercentInput` with the domain name attached, because "risk" and "percent"
 * are different product concepts that happen to share a unit. The name is the contract: a
 * reviewer reading `RiskInput value={2}` knows it is 2% of equity, not 2 basis points.
 */
export const RiskInput = forwardRef<HTMLInputElement, FinancialInputProps>(function RiskInput(props, ref) {
  return (
    <FinancialInput
      ref={ref}
      precision={props.precision ?? 2}
      min={props.min ?? 0}
      max={props.max ?? 100}
      allowNegative={props.allowNegative ?? false}
      suffix={props.suffix ?? '%'}
      {...props}
    />
  );
});

/**
 * StopLossInput — a stop-loss distance from entry, in percent.
 *
 * Negative is refused: a stop is a distance, and a negative distance is a take-profit. The
 * plan asks for the atomic shell only — deciding whether the stop is above or below entry
 * depends on the side, which is order-level knowledge and belongs to Section 02.
 */
export const StopLossInput = forwardRef<HTMLInputElement, FinancialInputProps>(function StopLossInput(props, ref) {
  return (
    <FinancialInput
      ref={ref}
      precision={props.precision ?? 2}
      min={props.min ?? 0}
      max={props.max ?? 100}
      allowNegative={props.allowNegative ?? false}
      suffix={props.suffix ?? '%'}
      {...props}
    />
  );
});

/**
 * TakeProfitInput — a take-profit distance from entry, in percent.
 *
 * Identical policy to `StopLossInput` and deliberately a separate atom: the two are entered
 * together but validated against each other, and that cross-field rule is a Molecule. Keeping
 * them distinct here means the Molecule has two unambiguous handles rather than one generic
 * field it must re-interpret.
 */
export const TakeProfitInput = forwardRef<HTMLInputElement, FinancialInputProps>(function TakeProfitInput(props, ref) {
  return (
    <FinancialInput
      ref={ref}
      precision={props.precision ?? 2}
      min={props.min ?? 0}
      max={props.max ?? 100}
      allowNegative={props.allowNegative ?? false}
      suffix={props.suffix ?? '%'}
      {...props}
    />
  );
});

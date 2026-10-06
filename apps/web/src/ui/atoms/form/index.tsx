/**
 * atoms/form — Input, Textarea, Checkbox, Radio, Switch, Slider, SelectTrigger.
 *
 * Sizes sm 32 / md 40 / lg 48, `md` default. The state model the plan requires:
 * default, hover, focus, filled, disabled, read-only, error, warning, success, loading.
 *
 * What is deliberately NOT here: the full select popover, the combobox search experience,
 * filter composition and form sections. `SelectTrigger` is the closed control only — the
 * popover it opens is a Molecule, and Section 02 owns it.
 *
 * Every control is a real native element, so keyboard behaviour, form submission and
 * `aria-invalid` are the platform's and are already correct.
 */
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cssVar, type SemanticToken } from '@/ui/foundations/color';
import { componentTokens } from '@/styles/tokens';
import { focusRingClass } from '@/ui/foundations/accessibility';

/** The controlled size union. */
export type FieldSize = 'sm' | 'md' | 'lg';

/** The controlled validation-state union. */
export type FieldState = 'default' | 'error' | 'warning' | 'success';

/** A size resolved to its height. */
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

/** The shared control chrome: a bordered box that takes focus cleanly. */
function controlChrome(size: FieldSize, state: FieldState, disabled: boolean, readOnly: boolean): React.CSSProperties {
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
    fontFamily: 'var(--fc-font-sans)',
    fontSize: TYPE[size].fs,
    lineHeight: TYPE[size].lh,
    opacity: disabled ? 0.55 : 1,
    cursor: disabled ? 'not-allowed' : readOnly ? 'default' : 'text',
    transition: 'border-color var(--fc-motion-fast) var(--fc-ease-standard), box-shadow var(--fc-motion-fast) var(--fc-ease-standard)',
  };
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'size'> & {
  size?: FieldSize;
  state?: FieldState;
  /** A leading adornment (a currency symbol, a unit). */
  prefix?: ReactNode;
  /** A trailing adornment. */
  suffix?: ReactNode;
  /** Renders the value in Geist Mono with tabular figures — for numeric input. */
  numeric?: boolean;
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * Input — a single-line text field.
 *
 * `numeric` switches the value to the data family, which is what keeps a typed price from
 * reflowing as digits arrive. `aria-invalid` is set from `state`, so a screen reader hears
 * the validation result rather than inferring it from a red border.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', state = 'default', prefix, suffix, numeric, className, style, theme = 'light', disabled, readOnly, ...rest },
  ref,
) {
  const bare = prefix === undefined && suffix === undefined;
  const field = (
    <input
      ref={ref}
      disabled={disabled}
      readOnly={readOnly}
      aria-invalid={state === 'error' ? true : undefined}
      className={[focusRingClass, 'fc-input', className].filter(Boolean).join(' ')}
      style={{
        ...controlChrome(size, state, !!disabled, !!readOnly),
        ...(numeric ? { fontFamily: 'var(--fc-font-mono)', fontVariantNumeric: 'tabular-nums' as const } : null),
        ...(bare ? null : { border: 0, background: 'transparent', padding: 0, minHeight: 'auto' }),
        ...style,
      }}
      {...rest}
    />
  );
  if (bare) return field;
  return (
    <span
      className={[focusRingClass, 'fc-input-shell', `fc-input-shell-${state}`, className].filter(Boolean).join(' ')}
      style={{ ...controlChrome(size, state, !!disabled, !!readOnly), ...style }}
    >
      {prefix ? <span style={{ color: cssVar('text-muted'), flex: '0 0 auto' }}>{prefix}</span> : null}
      {field}
      {suffix ? <span style={{ color: cssVar('text-muted'), flex: '0 0 auto' }}>{suffix}</span> : null}
    </span>
  );
});

type TextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> & {
  size?: FieldSize;
  state?: FieldState;
  /** Rows. Defaults to 3. */
  rows?: number;
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * Textarea — a multi-line text field.
 *
 * `resize: vertical` only: a horizontally resizable textarea breaks its container's layout,
 * and the plan's workspace grid is resizable-region compatible rather than
 * user-resizable-per-field.
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { size = 'md', state = 'default', rows = 3, className, style, theme = 'light', disabled, readOnly, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      disabled={disabled}
      readOnly={readOnly}
      aria-invalid={state === 'error' ? true : undefined}
      className={[focusRingClass, 'fc-textarea', className].filter(Boolean).join(' ')}
      style={{
        ...controlChrome(size, state, !!disabled, !!readOnly),
        padding: size === 'sm' ? '8px 10px' : '10px 12px',
        resize: 'vertical',
        fontFamily: 'inherit',
        ...style,
      }}
      {...rest}
    />
  );
});

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'type'> & {
  /** The visible label. Also the accessible name. */
  label: ReactNode;
  /** Supporting text under the label. */
  hint?: ReactNode;
  state?: FieldState;
  size?: FieldSize;
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * Checkbox — a boolean control with its label.
 *
 * The native input is visually hidden but still focusable and still the thing that receives
 * the click (the label wraps it), so keyboard and pointer behaviour are the platform's. The
 * box is drawn by the sibling `<span>`, which is why the input needs `position: absolute`
 * rather than `display: none`.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, hint, state = 'default', size = 'md', className, style, theme = 'light', disabled, ...rest },
  ref,
) {
  const box = size === 'sm' ? 14 : size === 'lg' ? 20 : 16;
  return (
    <label
      className={['fc-checkbox', disabled ? 'fc-disabled' : '', className].filter(Boolean).join(' ')}
      style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 'var(--fc-space-2)', cursor: disabled ? 'not-allowed' : 'pointer', ...style }}
    >
      <span style={{ position: 'relative', display: 'inline-flex', flex: '0 0 auto', width: box, height: box, marginTop: 2 }}>
        <input
          ref={ref}
          type="checkbox"
          disabled={disabled}
          aria-invalid={state === 'error' ? true : undefined}
          className={focusRingClass}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', margin: 0, opacity: 0, cursor: disabled ? 'not-allowed' : 'pointer' }}
          {...rest}
        />
        <span
          aria-hidden="true"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: box,
            height: box,
            boxSizing: 'border-box',
            borderRadius: 'var(--fc-radius-xs)',
            border: `1px solid ${cssVar(STATE_BORDER[state])}`,
            background: cssVar('surface-primary'),
            color: cssVar('brand-foreground'),
            fontSize: box - 4,
            lineHeight: 'var(--fc-line-height-none)',
          }}
        >
          {/* The tick is drawn with a CSS border rather than a glyph so it inherits the
              control's colour and needs no icon dependency. */}
          <span style={{ width: box - 8, height: box - 8, background: 'currentColor', clipPath: 'inset(0 0 0 0)' }} className="fc-checkbox-tick" />
        </span>
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontFamily: 'var(--fc-font-sans)', fontSize: TYPE[size].fs, lineHeight: TYPE[size].lh, color: cssVar('text-primary') }}>{label}</span>
        {hint ? <span style={{ fontFamily: 'var(--fc-font-sans)', fontSize: 'var(--fc-type-body-sm-size)', lineHeight: 'var(--fc-type-body-sm-line)', color: cssVar('text-muted') }}>{hint}</span> : null}
      </span>
    </label>
  );
});

type RadioProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'type'> & {
  label: ReactNode;
  hint?: ReactNode;
  state?: FieldState;
  size?: FieldSize;
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * Radio — one option in a single-choice group.
 *
 * Same shape as `Checkbox`: the native input carries the semantics, the sibling draws the
 * dot. The group's mutual exclusion is the shared `name` the caller supplies — the atom does
 * not own group state.
 */
export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { label, hint, state = 'default', size = 'md', className, style, theme = 'light', disabled, ...rest },
  ref,
) {
  const box = size === 'sm' ? 14 : size === 'lg' ? 20 : 16;
  return (
    <label
      className={['fc-radio', disabled ? 'fc-disabled' : '', className].filter(Boolean).join(' ')}
      style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 'var(--fc-space-2)', cursor: disabled ? 'not-allowed' : 'pointer', ...style }}
    >
      <span style={{ position: 'relative', display: 'inline-flex', flex: '0 0 auto', width: box, height: box, marginTop: 2 }}>
        <input
          ref={ref}
          type="radio"
          disabled={disabled}
          aria-invalid={state === 'error' ? true : undefined}
          className={focusRingClass}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', margin: 0, opacity: 0, cursor: disabled ? 'not-allowed' : 'pointer' }}
          {...rest}
        />
        <span
          aria-hidden="true"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: box,
            height: box,
            boxSizing: 'border-box',
            borderRadius: 'var(--fc-radius-full)',
            border: `1px solid ${cssVar(STATE_BORDER[state])}`,
            background: cssVar('surface-primary'),
          }}
        >
          <span className="fc-radio-dot" style={{ width: box - 8, height: box - 8, borderRadius: 'var(--fc-radius-full)', background: cssVar('brand-primary') }} />
        </span>
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontFamily: 'var(--fc-font-sans)', fontSize: TYPE[size].fs, lineHeight: TYPE[size].lh, color: cssVar('text-primary') }}>{label}</span>
        {hint ? <span style={{ fontFamily: 'var(--fc-font-sans)', fontSize: 'var(--fc-type-body-sm-size)', lineHeight: 'var(--fc-type-body-sm-line)', color: cssVar('text-muted') }}>{hint}</span> : null}
      </span>
    </label>
  );
});

type SwitchProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'type'> & {
  /** The visible label. Also the accessible name. */
  label: ReactNode;
  size?: FieldSize;
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * Switch — an on/off toggle.
 *
 * A native checkbox under the hood, so it is keyboard reachable and announces its state.
 * The track is `radius-full` (the plan's status-dot case extended to a toggle) and the knob
 * travels at the `fast` duration — a switch that slides slowly feels broken.
 */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { label, size = 'md', className, style, theme = 'light', disabled, ...rest },
  ref,
) {
  const w = size === 'sm' ? 28 : size === 'lg' ? 44 : 36;
  const h = size === 'sm' ? 16 : size === 'lg' ? 24 : 20;
  const knob = h - 4;
  return (
    <label
      className={['fc-switch', disabled ? 'fc-disabled' : '', className].filter(Boolean).join(' ')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--fc-space-2)', cursor: disabled ? 'not-allowed' : 'pointer', ...style }}
    >
      <span style={{ position: 'relative', display: 'inline-flex', flex: '0 0 auto', width: w, height: h }}>
        <input
          ref={ref}
          type="checkbox"
          role="switch"
          disabled={disabled}
          className={focusRingClass}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', margin: 0, opacity: 0, cursor: disabled ? 'not-allowed' : 'pointer' }}
          {...rest}
        />
        <span
          aria-hidden="true"
          className="fc-switch-track"
          style={{
            display: 'block',
            width: w,
            height: h,
            boxSizing: 'border-box',
            borderRadius: 'var(--fc-radius-full)',
            border: `1px solid ${cssVar('border-strong')}`,
            background: cssVar('surface-secondary'),
            transition: 'background-color var(--fc-motion-fast) var(--fc-ease-standard), border-color var(--fc-motion-fast) var(--fc-ease-standard)',
          }}
        />
        <span
          aria-hidden="true"
          className="fc-switch-knob"
          style={{
            position: 'absolute',
            top: 2,
            left: 2,
            width: knob,
            height: knob,
            borderRadius: 'var(--fc-radius-full)',
            background: cssVar('text-muted'),
            transition: 'transform var(--fc-motion-fast) var(--fc-ease-standard), background-color var(--fc-motion-fast) var(--fc-ease-standard)',
          }}
        />
      </span>
      <span style={{ fontFamily: 'var(--fc-font-sans)', fontSize: TYPE[size].fs, lineHeight: TYPE[size].lh, color: cssVar('text-primary') }}>{label}</span>
    </label>
  );
});

type SliderProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'type'> & {
  /** Accessible name. */
  label: string;
  /** Shows the current value in Geist Mono beside the track. */
  showValue?: boolean;
  /** Formats the displayed value. */
  format?: (v: number) => string;
  size?: FieldSize;
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * Slider — a range control.
 *
 * A native `<input type="range">`, so arrow keys, Home/End and the value announcement are
 * the platform's. The displayed value is tabular so it does not jitter as it moves.
 */
export const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
  { label, showValue, format, size = 'md', className, style, theme = 'light', disabled, value, ...rest },
  ref,
) {
  const shown = format && value !== undefined ? format(Number(value)) : String(value ?? '');
  return (
    <span className={['fc-slider', className].filter(Boolean).join(' ')} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--fc-space-3)', width: '100%', ...style }}>
      <input
        ref={ref}
        type="range"
        aria-label={label}
        disabled={disabled}
        value={value}
        className={focusRingClass}
        style={{ flex: 1, minWidth: 0, accentColor: cssVar('brand-primary'), height: HEIGHT[size] / 2, cursor: disabled ? 'not-allowed' : 'pointer' }}
        {...rest}
      />
      {showValue ? (
        <span className="fc-data-sm fc-tabular" style={{ color: cssVar('text-secondary'), minWidth: '4em', textAlign: 'right' }}>
          {shown}
        </span>
      ) : null}
    </span>
  );
});

type SelectTriggerProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> & {
  /** The selected value's display text. */
  value: ReactNode;
  /** Shown when nothing is selected. */
  placeholder?: string;
  size?: FieldSize;
  state?: FieldState;
  /** Opens the popover. The popover itself is a Molecule and is NOT implemented here. */
  onOpen?: () => void;
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * SelectTrigger — the closed state of a select.
 *
 * A real `<button>` with `aria-haspopup="listbox"` and `aria-expanded`, so a screen reader
 * knows a list is coming and a keyboard user can reach it. The listbox it opens is out of
 * scope for this phase — this atom is the trigger only, which is what lets a Molecule own
 * the popover without reimplementing the control's chrome.
 */
export const SelectTrigger = forwardRef<HTMLButtonElement, SelectTriggerProps>(function SelectTrigger(
  { value, placeholder = 'Select…', size = 'md', state = 'default', onOpen, className, style, theme = 'light', disabled, ...rest },
  ref,
) {
  const empty = value === undefined || value === null || value === '';
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      aria-haspopup="listbox"
      aria-expanded={false}
      onClick={onOpen}
      className={[focusRingClass, 'fc-select-trigger', className].filter(Boolean).join(' ')}
      style={{
        ...controlChrome(size, state, !!disabled, false),
        justifyContent: 'space-between',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'var(--fc-font-sans)',
        ...style,
      }}
      {...rest}
    >
      <span style={{ color: empty ? cssVar('text-muted') : cssVar('text-primary'), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {empty ? placeholder : value}
      </span>
      <span aria-hidden="true" style={{ flex: '0 0 auto', color: cssVar('text-muted'), fontSize: 'var(--fc-font-size-10)', lineHeight: 'var(--fc-line-height-none)' }}>
        ▼
      </span>
    </button>
  );
});

// ---------------------------------------------------------------------------
// Financial input atoms (Task 14)
// ---------------------------------------------------------------------------
// Declared in a sibling module so the generic form controls above stay free of the
// financial parsing core; re-exported here so `@/ui/atoms/form` remains the one entry
// point for every field-shaped atom.
export {
  AmountInput,
  PriceInput,
  PercentInput,
  QuantityInput,
  CurrencyInput,
  LeverageInput,
  RiskInput,
  StopLossInput,
  TakeProfitInput,
} from './financial';
export type { FinancialValue } from './financial';

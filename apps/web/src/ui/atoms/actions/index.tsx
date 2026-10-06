/**
 * atoms/actions — Button, IconButton, Link, CopyButton.
 *
 * Button variants (plan §12): primary, secondary, ghost, outline, destructive, success,
 * warning, info, buy, sell, link. Sizes xs 28 / sm 32 / md 40 / lg 48 / xl 56, `md` default.
 *
 * The two rules that shape this file:
 *
 *   1. LOADING PRESERVES WIDTH. A button that changes width when it starts loading moves
 *      everything next to it — the plan calls this out explicitly. The label stays mounted
 *      and invisible; only the spinner is added.
 *   2. BUY ≠ SUCCESS, SELL ≠ DESTRUCTIVE. A buy button is a brand-coloured action that
 *      happens to increase a position; a sell is one that decreases it. Neither is a generic
 *      status colour, and `intensity` (`muted` | `vivid`) picks which market colour it uses.
 */
import { forwardRef, useCallback, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cssVar, type SemanticToken } from '@/ui/foundations/color';
import { componentTokens } from '@/styles/tokens';
import { focusRingClass, srOnlyClass } from '@/ui/foundations/accessibility';
import { Icon, type IconComponent } from '@/ui/atoms/visual';

/** The controlled variant union. */
export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'outline'
  | 'destructive'
  | 'success'
  | 'warning'
  | 'info'
  | 'buy'
  | 'sell'
  | 'link';

/** The controlled size union. */
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/** For `buy`/`sell`: which market colour carries the action. */
export type Intensity = 'muted' | 'vivid';

/** A size resolved to its height, horizontal padding and type treatment. */
const SIZE: Record<ButtonSize, { h: number; px: number; fs: string; lh: string; fw: number }> = {
  xs: { h: componentTokens['button-height-xs'], px: 10, fs: 'var(--fc-type-label-sm-size)', lh: 'var(--fc-type-label-sm-line)', fw: 600 },
  sm: { h: componentTokens['button-height-sm'], px: 12, fs: 'var(--fc-type-label-sm-size)', lh: 'var(--fc-type-label-sm-line)', fw: 600 },
  md: { h: componentTokens['button-height-md'], px: 16, fs: 'var(--fc-type-label-md-size)', lh: 'var(--fc-type-label-md-line)', fw: 600 },
  lg: { h: componentTokens['button-height-lg'], px: 20, fs: 'var(--fc-type-label-lg-size)', lh: 'var(--fc-type-label-lg-line)', fw: 600 },
  xl: { h: componentTokens['button-height-xl'], px: 24, fs: 'var(--fc-type-body-lg-size)', lh: 'var(--fc-type-body-lg-line)', fw: 600 },
};

/** The colour roles a variant resolves to. */
interface VariantPaint {
  bg: SemanticToken;
  fg: SemanticToken;
  border: SemanticToken | 'transparent';
  hoverBg: SemanticToken;
}

const VARIANT: Record<ButtonVariant, VariantPaint> = {
  primary: { bg: 'brand-primary', fg: 'brand-foreground', border: 'transparent', hoverBg: 'brand-hover' },
  secondary: { bg: 'surface-secondary', fg: 'text-primary', border: 'border-default', hoverBg: 'surface-raised' },
  ghost: { bg: 'surface-primary', fg: 'text-secondary', border: 'transparent', hoverBg: 'surface-secondary' },
  outline: { bg: 'surface-primary', fg: 'text-primary', border: 'border-strong', hoverBg: 'surface-secondary' },
  destructive: { bg: 'negative', fg: 'text-inverse', border: 'transparent', hoverBg: 'negative-strong' },
  success: { bg: 'positive', fg: 'text-inverse', border: 'transparent', hoverBg: 'positive-strong' },
  warning: { bg: 'warning', fg: 'text-inverse', border: 'transparent', hoverBg: 'warning-strong' },
  info: { bg: 'info', fg: 'text-inverse', border: 'transparent', hoverBg: 'info-strong' },
  // buy/sell are NOT success/destructive. They are the two market directions, and the
  // intensity picks muted (portfolio/research) or vivid (live/execution).
  buy: { bg: 'positive', fg: 'text-inverse', border: 'transparent', hoverBg: 'positive-strong' },
  sell: { bg: 'negative', fg: 'text-inverse', border: 'transparent', hoverBg: 'negative-strong' },
  link: { bg: 'surface-primary', fg: 'brand-critical', border: 'transparent', hoverBg: 'surface-primary' },
};

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** For `buy`/`sell` only. Ignored by every other variant. */
  intensity?: Intensity;
  /** Shows a spinner and blocks activation. The label stays mounted so the width holds. */
  loading?: boolean;
  /** A leading icon. */
  icon?: IconComponent;
  /** A trailing icon. */
  iconRight?: IconComponent;
  /** Required when the button has no visible text. */
  'aria-label'?: string;
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * Button — the one action control.
 *
 * A real `<button>`, so Enter/Space activation, focus and disabled semantics are the
 * browser's and are already correct. `type="button"` by default: a button inside a form that
 * submits by accident is a bug the caller should opt out of, not into.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    variant = 'primary',
    size = 'md',
    intensity = 'muted',
    loading = false,
    icon: IconLeft,
    iconRight: IconRight,
    className,
    style,
    theme = 'light',
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  const s = SIZE[size];
  const paint = VARIANT[variant];
  // `buy`/`sell` honour the intensity: vivid is reserved for live/execution surfaces.
  const bgRole: SemanticToken =
    (variant === 'buy' || variant === 'sell') && intensity === 'vivid'
      ? variant === 'buy'
        ? 'positive-live'
        : 'negative-live'
      : paint.bg;
  const isLink = variant === 'link';
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={[focusRingClass, 'fc-button', `fc-button-${variant}`, className].filter(Boolean).join(' ')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--fc-space-2)',
        minHeight: s.h,
        padding: isLink ? 0 : `0 ${s.px}px`,
        borderRadius: isLink ? 'var(--fc-radius-xs)' : 'var(--fc-radius-md)',
        border: `1px solid ${paint.border === 'transparent' ? 'transparent' : cssVar(paint.border)}`,
        background: isLink ? 'transparent' : cssVar(bgRole),
        color: cssVar(paint.fg),
        fontFamily: 'var(--fc-font-sans)',
        fontSize: s.fs,
        lineHeight: s.lh,
        fontWeight: s.fw,
        textDecoration: isLink ? 'underline' : 'none',
        textUnderlineOffset: 3,
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        opacity: disabled && !loading ? 0.55 : 1,
        transition: 'background-color var(--fc-motion-fast) var(--fc-ease-standard), border-color var(--fc-motion-fast) var(--fc-ease-standard), color var(--fc-motion-fast) var(--fc-ease-standard)',
        ...style,
      }}
      onMouseEnter={isLink ? undefined : rest.onMouseEnter}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden="true"
          style={{
            display: 'block',
            width: 14,
            height: 14,
            flex: '0 0 auto',
            borderRadius: 'var(--fc-radius-full)',
            border: '2px solid currentColor',
            borderTopColor: 'transparent',
            animation: 'fc-spin var(--fc-motion-base) linear infinite',
          }}
        />
      ) : IconLeft ? (
        <Icon as={IconLeft} size={size === 'xs' || size === 'sm' ? 14 : 16} />
      ) : null}
      {/* The label stays mounted while loading so the button's width does not change. */}
      <span style={loading ? { visibility: 'hidden' } : undefined}>{children}</span>
      {IconRight && !loading ? <Icon as={IconRight} size={size === 'xs' || size === 'sm' ? 14 : 16} /> : null}
    </button>
  );
});

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> & {
  /** The glyph. */
  icon: IconComponent;
  /**
   * Accessible name. REQUIRED — an icon-only control with no name is unreachable, and the
   * plan lists "icon-only action requires accessible name" as a test.
   */
  'aria-label': string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * IconButton — a square action carrying only a glyph.
 *
 * The accessible name is required by the type, not by convention. The button is square at
 * the size's height, `radius-md` (not full — the plan warns against pill-shaped everything).
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Glyph, variant = 'ghost', size = 'md', loading = false, className, style, theme = 'light', disabled, type = 'button', ...rest },
  ref,
) {
  const s = SIZE[size];
  const paint = VARIANT[variant];
  const px = size === 'xs' ? 12 : size === 'sm' ? 14 : 16;
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={[focusRingClass, 'fc-icon-button', `fc-icon-button-${variant}`, className].filter(Boolean).join(' ')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: s.h,
        height: s.h,
        flex: '0 0 auto',
        padding: 0,
        borderRadius: 'var(--fc-radius-md)',
        border: `1px solid ${paint.border === 'transparent' ? 'transparent' : cssVar(paint.border)}`,
        background: cssVar(paint.bg),
        color: cssVar(paint.fg),
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        opacity: disabled && !loading ? 0.55 : 1,
        transition: 'background-color var(--fc-motion-fast) var(--fc-ease-standard), color var(--fc-motion-fast) var(--fc-ease-standard)',
        ...style,
      }}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden="true"
          style={{
            display: 'block',
            width: px,
            height: px,
            borderRadius: 'var(--fc-radius-full)',
            border: '2px solid currentColor',
            borderTopColor: 'transparent',
            animation: 'fc-spin var(--fc-motion-base) linear infinite',
          }}
        />
      ) : (
        <Icon as={Glyph} size={px} />
      )}
    </button>
  );
});

type LinkProps = {
  children?: ReactNode;
  href: string;
  /** Opens in a new tab. When set, the accessible name says so. */
  external?: boolean;
  variant?: 'default' | 'muted' | 'brand';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * Link — a navigation anchor.
 *
 * A real `<a>`, so middle-click, cmd-click and "copy link" all work. `external` adds
 * `rel="noopener noreferrer"` — without it a `target="_blank"` link hands the opened page a
 * `window.opener` handle, which is the well-known reverse-tabnabbing shape.
 */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { children, href, external, variant = 'brand', size = 'md', className, style, theme = 'light' },
  ref,
) {
  const tone: SemanticToken = variant === 'muted' ? 'text-muted' : variant === 'brand' ? 'brand-critical' : 'text-primary';
  const fs = size === 'sm' ? 'var(--fc-type-label-sm-size)' : size === 'lg' ? 'var(--fc-type-body-lg-size)' : 'var(--fc-type-body-md-size)';
  return (
    <a
      ref={ref}
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      className={[focusRingClass, 'fc-link', className].filter(Boolean).join(' ')}
      style={{
        color: cssVar(tone),
        fontFamily: 'var(--fc-font-sans)',
        fontSize: fs,
        lineHeight: 'var(--fc-type-body-md-line)',
        textDecoration: 'underline',
        textUnderlineOffset: 3,
        textDecorationColor: cssVar('border-strong'),
        borderRadius: 'var(--fc-radius-xs)',
        ...style,
      }}
    >
      {children}
      {external ? <span className={srOnlyClass}> (opens in a new tab)</span> : null}
    </a>
  );
});

type CopyButtonProps = {
  /** The value to copy. The button never mutates it. */
  value: string;
  /** Accessible name for the control. */
  label?: string;
  /** Announced after a successful copy. */
  copiedLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  style?: React.CSSProperties;
  theme?: 'light' | 'dark';
};

/**
 * CopyButton — copies a value to the clipboard and confirms it.
 *
 * The confirmation is a live region, not a colour swap: a user who cannot distinguish the
 * colour change still hears "Copied". The value is passed to the clipboard verbatim — the
 * button never reformats it, so what lands on the clipboard is exactly what was handed in.
 */
export const CopyButton = forwardRef<HTMLButtonElement, CopyButtonProps>(function CopyButton(
  { value, label = 'Copy', copiedLabel = 'Copied', variant = 'ghost', size = 'sm', className, style, theme = 'light' },
  ref,
) {
  return (
    <CopyButtonInner
      ref={ref}
      value={value}
      label={label}
      copiedLabel={copiedLabel}
      variant={variant}
      size={size}
      className={className}
      style={style}
      theme={theme}
    />
  );
});

// The stateful half, split out so `CopyButton`'s public signature stays a plain props type
// and the ref still lands on the underlying `<button>`.
const CopyButtonInner = forwardRef<HTMLButtonElement, CopyButtonProps & { label: string; copiedLabel: string }>(
  function CopyButtonInner({ value, label, copiedLabel, variant, size, className, style, theme }, ref) {
    const [copied, setState] = useState(false);
    const onCopy = useCallback(() => {
      void navigator.clipboard?.writeText(value);
      setState(true);
      window.setTimeout(() => setState(false), 1600);
    }, [value]);
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--fc-space-2)' }}>
        <Button ref={ref} variant={variant} size={size} onClick={onCopy} className={className} style={style} theme={theme}
          aria-label={label}>
          {copied ? copiedLabel : label}
        </Button>
        <span role="status" aria-live="polite" className={srOnlyClass}>
          {copied ? copiedLabel : ''}
        </span>
      </span>
    );
  },
);

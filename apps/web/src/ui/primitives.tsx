import { useEffect, useId, useRef } from 'react';
import { themeColor, fontFamily, fontSize, fontWeight, motion, radius, space, target, zIndex } from '@/styles/tokens';

type ButtonProps = {
  onClick: () => void;
  children: React.ReactNode;
  variant?: 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  /** Override the default `button` type — `submit` when this button commits a form. */
  type?: 'button' | 'submit' | 'reset';
  /** Marks the control busy for assistive tech while an async action is in flight. */
  busy?: boolean;
};

export function Button({ onClick, children, variant = 'primary', size = 'md', disabled, type = 'button', busy }: ButtonProps) {
  const colors = {
    primary: { bg: themeColor.blue, fg: themeColor.labelOnAccent },
    danger: { bg: themeColor.red, fg: themeColor.labelOnAccent },
    ghost: { bg: themeColor.bgSecondary, fg: themeColor.labelPrimary },
  };
  const sizes = {
    sm: `${space[8]}px ${space[12]}px`,
    md: `${space[8]}px ${space[16]}px`,
    lg: `${space[12]}px ${space[16]}px`,
  };
  const c = colors[variant];

  return (
    // `type="button"` is the DEFAULT on purpose. A bare `<button>` inside a
    // <form> is `type="submit"`, so a control the caller only meant as a click
    // target (a modal's close, a "generate" action beside a field) would submit
    // and reload the page — the one failure mode a caller cannot see in review.
    // Declaring `button` here keeps today's rendering for every call site
    // OUTSIDE a form (identical) and fixes the ones inside one.
    <button type={type} aria-busy={busy || undefined} className="fc-focusable" onClick={onClick} disabled={disabled} style={{
      background: c.bg, color: c.fg, border: 'none',
      padding: sizes[size], borderRadius: radius[8],
      fontWeight: variant === 'primary' ? fontWeight.bold : fontWeight.regular,
      cursor: disabled ? 'not-allowed' : 'pointer', minHeight: target.min, transition: 'background ' + motion.normal + ' ' + motion.ease,
      fontSize: size === 'sm' ? fontSize[11] : size === 'lg' ? fontSize[15] : fontSize[12],
      opacity: disabled ? 0.5 : 1,
    }}>
      {children}
    </button>
  );
}

type InputProps = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  autoComplete?: string;
  spellCheck?: boolean;
  /** Ties the control to its `<Label htmlFor>`; set by `<Field>`. */
  id?: string;
  /** Names the control with no visible label (a filter box). */
  'aria-label'?: string;
};

export function Input({ value, onChange, placeholder, type = 'text', style, disabled, autoComplete, spellCheck, id, 'aria-label': ariaLabel }: InputProps) {
  return (
    <input className="fc-focusable" id={id} aria-label={ariaLabel} type={type} value={value} placeholder={placeholder} disabled={disabled} autoComplete={autoComplete} spellCheck={spellCheck} onChange={e => onChange(e.target.value)}
      style={{
        width: '100%', background: themeColor.bgBase, color: themeColor.labelPrimary,
        border: `1px solid ${themeColor.separator}`, borderRadius: radius[8],
        padding: `${space[8]}px ${space[8]}px`, fontSize: fontSize[12], boxSizing: 'border-box', opacity: disabled ? 0.5 : 1, ...style,
      }} />
  );
}

type SelectProps<T extends string> = {
  value: T;
  onChange: (v: T) => void;
  options: readonly (T | { value: T; label: string })[];
  style?: React.CSSProperties;
  disabled?: boolean;
  /** Ties the control to its `<Label htmlFor>`; set by `<Field>`. */
  id?: string;
  /** Names the control with no visible label (a filter select). */
  'aria-label'?: string;
};

export function Select<T extends string>({ value, onChange, options, style, disabled, id, 'aria-label': ariaLabel }: SelectProps<T>) {
  return (
    <select className="fc-focusable" id={id} aria-label={ariaLabel} value={value} disabled={disabled} onChange={e => onChange(e.target.value as T)}
      style={{
        background: themeColor.bgBase, color: themeColor.labelPrimary, border: `1px solid ${themeColor.separator}`,
        borderRadius: radius[8], padding: `${space[8]}px ${space[8]}px`, fontSize: fontSize[12], boxSizing: 'border-box', opacity: disabled ? 0.5 : 1,
  // A native <select>'s intrinsic width is its WIDEST <option>, so a long
  // option list ('Ticker · Name', 'Chain · Network') makes the control wider
  // than the card holding it — measured 522px in a 316px box. `maxWidth: 100%`
  // bounds it to its parent; `minWidth: 0` is what lets it actually shrink
  // there as a flex item, since the default `min-width: auto` refuses to go
  // below min-content.
  maxWidth: '100%',
  minWidth: 0,
        ...style,
      }}>
      {options.map(o => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        return <option key={opt.value} value={opt.value}>{opt.label}</option>;
      })}
    </select>
  );
}

type ModalProps = {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
};

/**
 * The modal dialog, wired to the accessibility contract it was missing.
 *
 * WHAT WAS WRONG (measured on the served build): the modal rendered a fixed
 * overlay with an `<h2>` and a `✕` button but carried
 * NO `role="dialog"`, NO `aria-modal`, and NO programmatic association between
 * the dialog and its title. A screen reader therefore read the panel as
 * anonymous content and could walk straight back INTO the page behind it — the
 * two failure modes `aria-modal` + a focus move exist to prevent. `Escape` did
 * nothing, and closing left focus on `<body>` instead of the control that
 * opened it.
 *
 * WHAT THIS DOES. The panel is a labelled `dialog`; on open it moves focus to
 * itself (with a visible ring, via `fc-focus-ring`) so a keyboard user's next
 * Tab stays inside it; `Escape` and the `✕` both close it; on close, focus
 * returns to whatever was focused when it opened. The overlay's own click-to-
 * dismiss is kept, but only when the click lands on the overlay itself (not on
 * the panel's children) — a click inside the panel must not close it.
 *
 * Full focus-trap semantics (bounding Tab at the last element) are deliberately
 * NOT implemented: the dialog is a short confirm/entry form with a single
 * focusable close control plus its fields, and a half-built trap is worse than
 * none. What ships is the honest core: the dialog is announced, Escape works,
 * and focus is placed and restored.
 */
export function Modal({ title, onClose, children, width = 480 }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // The element that had focus before the dialog opened, restored on close.
  const restoreRef = useRef<Element | null>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement;
    panelRef.current?.focus();
    return () => {
      const prev = restoreRef.current;
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: themeColor.scrim, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: zIndex.modal, transition: 'opacity ' + motion.deliberate + ' ' + motion.ease }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="fc-focus-ring"
        style={{ background: themeColor.bgElevated, border: `1px solid ${themeColor.separator}`, borderRadius: radius[16], padding: space[24], width, maxWidth: '90vw', fontFamily: fontFamily.mono, transition: 'transform ' + motion.slow + ' ' + motion.ease }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: space[16] }}>
          <h2 id={titleId} style={{ margin: 0, color: themeColor.blue, fontSize: fontSize[17] }}>{title}</h2>
          <button type="button" aria-label="Close dialog" className="fc-focusable" onClick={onClose} style={{ background: 'transparent', color: themeColor.labelTertiary, border: 'none', fontSize: fontSize[20], cursor: 'pointer' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * A form label. Pass `htmlFor` that matches the control's `id` so a screen
 * reader announces the field's name — `<Field>` does this automatically. Use it
 * bare only over a control that names itself (a preset row, a colour swatch
 * group); there a `<fieldset><legend>` is the honest wrapper and a bare
 * `<label>` with no target is a label in name only.
 */
export function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return <label htmlFor={htmlFor} style={{ fontSize: fontSize[11], color: themeColor.labelTertiary, display: 'block', marginBottom: space[4] }}>{children}</label>;
}

export { Card } from '@/ui/card';

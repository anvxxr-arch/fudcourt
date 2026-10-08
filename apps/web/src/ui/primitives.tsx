import { themeColor, fontFamily, fontSize, fontWeight, motion, radius, space, target, zIndex } from '@/styles/tokens';

type ButtonProps = {
  onClick: () => void;
  children: React.ReactNode;
  variant?: 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
};

export function Button({ onClick, children, variant = 'primary', size = 'md', disabled }: ButtonProps) {
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
    <button className="fc-focusable" onClick={onClick} disabled={disabled} style={{
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
};

export function Input({ value, onChange, placeholder, type = 'text', style, disabled, autoComplete, spellCheck }: InputProps) {
  return (
    <input className="fc-focusable" type={type} value={value} placeholder={placeholder} disabled={disabled} autoComplete={autoComplete} spellCheck={spellCheck} onChange={e => onChange(e.target.value)}
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
};

export function Select<T extends string>({ value, onChange, options, style, disabled }: SelectProps<T>) {
  return (
    <select className="fc-focusable" value={value} disabled={disabled} onChange={e => onChange(e.target.value as T)}
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

export function Modal({ title, onClose, children, width = 480 }: ModalProps) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: themeColor.scrim, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: zIndex.modal, transition: 'opacity ' + motion.deliberate + ' ' + motion.ease }}>
      <div style={{ background: themeColor.bgElevated, border: `1px solid ${themeColor.separator}`, borderRadius: radius[16], padding: space[24], width, maxWidth: '90vw', fontFamily: fontFamily.mono, transition: 'transform ' + motion.slow + ' ' + motion.ease }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: space[16] }}>
          <h2 style={{ margin: 0, color: themeColor.blue, fontSize: fontSize[17] }}>{title}</h2>
          <button className="fc-focusable" onClick={onClose} style={{ background: 'transparent', color: themeColor.labelTertiary, border: 'none', fontSize: fontSize[20], cursor: 'pointer' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return <label style={{ fontSize: fontSize[11], color: themeColor.labelTertiary, display: 'block', marginBottom: space[4] }}>{children}</label>;
}

export { Card } from '@/ui/card';

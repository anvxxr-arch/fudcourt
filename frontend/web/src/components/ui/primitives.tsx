import { color, fontFamily, fontSize, fontWeight, radius, space, zIndex } from '@/styles/tokens';

type ButtonProps = {
  onClick: () => void;
  children: React.ReactNode;
  variant?: 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
};

export function Button({ onClick, children, variant = 'primary', size = 'md', disabled }: ButtonProps) {
  const colors = {
    primary: { bg: color.accent, fg: color.textOnAccent },
    danger: { bg: color.negative, fg: color.textInverse },
    ghost: { bg: color.surface, fg: color.text },
  };
  const sizes = {
    sm: `${space[6]}px ${space[12]}px`,
    md: `${space[8]}px ${space[16]}px`,
    lg: `${space[10]}px ${space[18]}px`,
  };
  const c = colors[variant];

  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: c.bg, color: c.fg, border: 'none',
      padding: sizes[size], borderRadius: radius[6],
      fontWeight: variant === 'primary' ? fontWeight.bold : fontWeight.regular,
      cursor: disabled ? 'not-allowed' : 'pointer',
      fontSize: size === 'sm' ? fontSize[11] : size === 'lg' ? fontSize[14] : fontSize[12],
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
};

export function Input({ value, onChange, placeholder, type = 'text', style }: InputProps) {
  return (
    <input type={type} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)}
      style={{
        width: '100%', background: color.bg, color: color.text,
        border: `1px solid ${color.border}`, borderRadius: radius[6],
        padding: `${space[6]}px ${space[8]}px`, fontSize: fontSize[12], boxSizing: 'border-box', ...style,
      }} />
  );
}

type SelectProps = {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  style?: React.CSSProperties;
};

export function Select({ value, onChange, options, style }: SelectProps) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{
        background: color.bg, color: color.text, border: `1px solid ${color.border}`,
        borderRadius: radius[6], padding: `${space[6]}px ${space[8]}px`, fontSize: fontSize[12], boxSizing: 'border-box', ...style,
      }}>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
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
    <div style={{ position: 'fixed', inset: 0, background: color.overlay, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: zIndex.modal }}>
      <div style={{ background: color.surface, border: `1px solid ${color.border}`, borderRadius: radius[14], padding: space[24], width, maxWidth: '90vw', fontFamily: fontFamily.mono }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: space[16] }}>
          <h2 style={{ margin: 0, color: color.accent, fontSize: fontSize[18] }}>{title}</h2>
          <button onClick={onClose} style={{ background: 'transparent', color: color.textMuted, border: 'none', fontSize: fontSize[20], cursor: 'pointer' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return <label style={{ fontSize: fontSize[10], color: color.textMuted, display: 'block', marginBottom: space[4] }}>{children}</label>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: color.surface, border: `1px solid ${color.border}`, borderRadius: radius[12], padding: space[14], marginBottom: space[10], ...style }}>
      {children}
    </div>
  );
}

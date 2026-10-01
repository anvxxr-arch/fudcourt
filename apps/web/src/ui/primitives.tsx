import { C } from '@/styles/shared';

type ButtonProps = {
  onClick: () => void;
  children: React.ReactNode;
  variant?: 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
};

export function Button({ onClick, children, variant = 'primary', size = 'md', disabled }: ButtonProps) {
  const colors = {
    primary: { bg: C.accent, fg: '#04140f' },
    danger: { bg: C.red, fg: '#fff' },
    ghost: { bg: C.card, fg: C.white },
  };
  const sizes = { sm: '6px 12px', md: '8px 16px', lg: '10px 18px' };
  const c = colors[variant];

  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: c.bg, color: c.fg, border: 'none',
      padding: sizes[size], borderRadius: 6,
      fontWeight: variant === 'primary' ? 700 : 400,
      cursor: disabled ? 'not-allowed' : 'pointer',
      fontSize: size === 'sm' ? 11 : size === 'lg' ? 14 : 12,
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
        width: '100%', background: C.bg, color: C.white,
        border: `1px solid ${C.border}`, borderRadius: 6,
        padding: '6px 8px', fontSize: 12, boxSizing: 'border-box', ...style,
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
        background: C.bg, color: C.white, border: `1px solid ${C.border}`,
        borderRadius: 6, padding: '6px 8px', fontSize: 12, boxSizing: 'border-box', ...style,
      }}>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

type TextAreaProps = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minHeight?: number;
};

export function TextArea({ value, onChange, placeholder, minHeight = 50 }: TextAreaProps) {
  return (
    <textarea value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)}
      style={{
        width: '100%', background: C.bg, color: C.white,
        border: `1px solid ${C.border}`, borderRadius: 6,
        padding: '6px 8px', fontSize: 12, minHeight, resize: 'vertical', boxSizing: 'border-box',
      }} />
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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 24, width, maxWidth: '90vw', fontFamily: 'ui-monospace, monospace' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, color: C.accent, fontSize: 18 }}>{title}</h2>
          <button onClick={onClose} style={{ background: 'transparent', color: C.dim, border: 'none', fontSize: 20, cursor: 'pointer' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return <label style={{ fontSize: 10, color: C.dim, display: 'block', marginBottom: 4 }}>{children}</label>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 10, ...style }}>
      {children}
    </div>
  );
}

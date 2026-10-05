import { color, fontSize, space } from '@/styles/tokens';

type EmptyStateProps = { children: React.ReactNode; style?: React.CSSProperties };

export function EmptyState({ children, style }: EmptyStateProps) {
  return (
    <div style={{ color: color.textMuted, fontSize: fontSize[12], padding: `${space[20]}px 0`, textAlign: 'center', ...style }}>
      {children}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <p style={{ color: color.textMuted, fontSize: fontSize[12] }}>{label}</p>;
}

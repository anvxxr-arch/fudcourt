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

/**
 * The house placeholder for an absent value. Same concept as the executor's `DASH`
 * constant (`features/executor/shapers.ts`), which stays where it is: `DASH` is the
 * `'—'` that shapers substitute while shaping data, this is the JSX element a board
 * renders in a cell. Both are `—` so a missing field never reads as a zero.
 */
export function Dash({ children }: { children?: React.ReactNode }) {
  return <span style={{ color: color.textMuted }}>{children ?? '—'}</span>;
}

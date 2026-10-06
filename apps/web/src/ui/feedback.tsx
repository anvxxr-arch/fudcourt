import { alpha, themeColor, fontSize, radius, space } from '@/styles/tokens';

type EmptyStateProps = { children: React.ReactNode; style?: React.CSSProperties };

export function EmptyState({ children, style }: EmptyStateProps) {
  return (
    <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[12], padding: `${space[20]}px 0`, textAlign: 'center', ...style }}>
      {children}
    </div>
  );
}

export function Loading({ label, what }: { label?: string; what?: string }) {
  const text = label ?? (what ? `Loading ${what}…` : 'Loading…');
  return <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>{text}</p>;
}

/** The module's error panel: a red tint banner with the title and optional detail. */
export function ErrorState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div style={{ background: alpha(themeColor.red, 0.08), border: `1px solid ${alpha(themeColor.red, 0.4)}`, borderRadius: radius[8], padding: `${space[12]}px ${space[12]}px`, color: themeColor.labelPrimary }}>
      <strong style={{ color: themeColor.labelPrimary }}>{title}</strong>
      {detail ? <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[12], color: themeColor.labelTertiary }}>{detail}</p> : null}
    </div>
  );
}

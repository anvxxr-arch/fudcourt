import { color, fontFamily, fontSize, fontWeight, letterSpacing, radius, space } from '@/styles/tokens';

/**
 * Route-segment chrome for the app router's boundary slots (`loading.tsx`,
 * `error.tsx`, `not-found.tsx`). These render OUTSIDE every feature surface, so
 * they cannot reuse a feature's in-page error/empty states — a route that never
 * reached the feature still needs the same visual language. One centred panel,
 * one accent title, one muted hint, one optional action.
 */
type PanelProps = {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  style?: React.CSSProperties;
};
export function PagePanel({ title, children, action, style }: PanelProps) {
  return (
    <main
      style={{
        background: color.bgBase,
        minHeight: '50vh',
        color: color.labelPrimary,
        fontFamily: fontFamily.mono,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: space[20],
        ...style,
      }}
    >
      <div
        style={{
          background: color.bgSecondary,
          border: `1px solid ${color.separator}`,
          borderRadius: radius[12],
          padding: space[24],
          maxWidth: 420,
          width: '100%',
          textAlign: 'center',
        }}
      >
        <div style={{ color: color.blue, fontSize: fontSize[17], fontWeight: fontWeight.bold, letterSpacing: letterSpacing.wider }}>
          {title}
        </div>
        <div style={{ color: color.labelTertiary, fontSize: fontSize[12], marginTop: space[8] }}>{children}</div>
        {action != null && <div style={{ marginTop: space[16] }}>{action}</div>}
      </div>
    </main>
  );
}

/** The panel's action link: an accent chip pointing at an internal route. */
export function PagePanelLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      className="fc-focusable"
      href={href}
      style={{
        display: 'inline-block',
        color: color.blue,
        background: color.bgBase,
        border: `1px solid ${color.separator}`,
        borderRadius: radius[8],
        padding: `${space[8]}px ${space[16]}px`,
        fontSize: fontSize[12],
        fontWeight: fontWeight.semibold,
        textDecoration: 'none',
      }}
    >
      {children}
    </a>
  );
}

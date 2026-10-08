import type { CSSProperties, ReactNode } from 'react';
import { themeColor, fontSize, fontWeight, letterSpacing, radius, space } from '@/styles/tokens';

/**
 * The one card atom for the data modules: a titled section panel. The title
 * slot owns the section `<h2>` so cards never flatten into the page `<h1>`
 * PageHeader provides. Both the economy and trade module kits used a
 * byte-identical private copy of this exact shape.
 */
export function Card({ title, subtitle, right, children, style }: { title?: string; subtitle?: string; right?: ReactNode; children: ReactNode; style?: CSSProperties }) {
  return (
    <section
      className="fc-fade-in"
      style={{
        background: themeColor.bgSecondary,
        border: `1px solid ${themeColor.separator}`,
        borderRadius: radius[8],
        padding: `${space[12]}px ${space[16]}px`,
        ...style,
      }}
    >
      {(title || right) && (
        <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: space[8], marginBottom: space[8] }}>
          <div style={{ minWidth: 0, flex: '1 1 auto' }}>
            {title && <h2 style={{ margin: 0, fontSize: fontSize[13], fontWeight: fontWeight.semibold, color: themeColor.labelPrimary, letterSpacing: letterSpacing.xs }}>{title}</h2>}
            {subtitle && <p style={{ margin: `${space[4]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary }}>{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

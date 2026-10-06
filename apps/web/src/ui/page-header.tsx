import Link from 'next/link';
import { themeColor, fontSize, fontWeight, lineHeight, radius, space } from '@/styles/tokens';

/**
 * The one page-chrome atom: the page `<h1>`, a one-line description, and the
 * module's entry nav. Adopted by both the economy and trade module headers,
 * which had byte-identical private copies; the only difference between them
 * was `maxWidth` (760 economy, 820 trade), so the canonical default is 760 and
 * a caller that measured a wider line passes `maxWidth`.
 *
 * Heading rule: this atom owns the page `<h1>`. Cards own their own `<h2>`
 * section titles; nothing here flattens that hierarchy.
 */
type PageHeaderProps = {
  title: string;
  description: string;
  nav: readonly { href: string; label: string }[];
  /** Measured default: the description's max line length. */
  maxWidth?: number;
};

export function PageHeader({ title, description, nav, maxWidth = 760 }: PageHeaderProps) {
  return (
    <header style={{ marginBottom: space[20] }}>
      <h1 style={{ margin: 0, fontSize: fontSize[22], fontWeight: fontWeight.bold, color: themeColor.labelPrimary }}>{title}</h1>
      <p style={{ margin: `${space[8]}px 0 ${space[12]}px`, fontSize: fontSize[12], color: themeColor.labelTertiary, lineHeight: lineHeight.normal, maxWidth }}>{description}</p>
      <nav style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
        {nav.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            style={{
              padding: `${space[4]}px ${space[8]}px`,
              border: `1px solid ${themeColor.separator}`,
              borderRadius: radius[8],
              color: themeColor.labelPrimary,
              fontSize: fontSize[11],
              textDecoration: 'none',
            }}
          >
            {n.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

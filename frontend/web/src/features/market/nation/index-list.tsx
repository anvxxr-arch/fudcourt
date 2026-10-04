import Link from 'next/link';
import { color, fontSize, fontWeight, letterSpacing, lineHeight, radius, space } from '@/styles/tokens';
import { NATIONS, nationFlag, nationPath, type NationSpec } from '@/features/market/nation/client';

/**
 * The country index: every economy this family serves, grouped by the same
 * regions the worldwide board uses, each linking to its profile page.
 *
 * It exists because a detail route with no entry point is a page nobody can
 * reach — and because `sitemap.xml` enumerating 125 URLs is only useful if a
 * crawler can also walk them from a real page. The list is built from
 * `NATIONS` itself, so the index and the profiles can never disagree about which
 * countries exist.
 */

const REGIONS = ['Americas', 'Europe', 'Asia-Pacific', 'Africa & Middle East'] as const;

function Grid({ nations }: { nations: readonly NationSpec[] }) {
  return (
    <ul
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
        gap: space[6],
      }}
    >
      {nations.map((n) => (
        <li key={n.code}>
          <Link
            href={nationPath(n)}
            title={`${n.name} — ${n.income}, ${n.currency}`}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: space[6],
              padding: `${space[6]}px ${space[8]}px`,
              border: `1px solid ${color.border}`,
              borderRadius: radius[6],
              color: color.text,
              fontSize: fontSize[12],
              textDecoration: 'none',
            }}
          >
            <span aria-hidden>{nationFlag(n.iso2)}</span>
            <span style={{ flex: 1 }}>{n.name}</span>
            <span style={{ color: color.textMuted, fontSize: fontSize[10] }}>{n.currency}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function NationIndex() {
  return (
    <main style={{ maxWidth: 1080, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
      <nav style={{ fontSize: fontSize[11], color: color.textMuted, marginBottom: space[12] }}>
        <Link href="/" style={{ color: color.textMuted }}>
          FUDCOURT
        </Link>
        {' / economy / nation'}
      </nav>
      <h1 style={{ fontSize: fontSize[32], fontWeight: fontWeight.heavy, margin: 0, color: color.text }}>Economy by nation</h1>
      <p style={{ color: color.textMuted, fontSize: fontSize[12], lineHeight: lineHeight.normal, maxWidth: 720 }}>
        {NATIONS.length} economies, each with its structural profile (World Bank, annual), its government-finance
        actuals (IMF Fiscal Monitor), its policy rate (BIS) and its currency against the dollar. Pick a country.
      </p>
      {REGIONS.map((region) => {
        const inRegion = NATIONS.filter((n) => n.region === region);
        if (inRegion.length === 0) return null;
        return (
          <section key={region} style={{ marginTop: space[24] }}>
            <h2
              style={{
                fontSize: fontSize[11],
                fontWeight: fontWeight.semibold,
                letterSpacing: letterSpacing.wider,
                color: color.textMuted,
                margin: `0 0 ${space[8]}px`,
              }}
            >
              {region.toUpperCase()} · {inRegion.length}
            </h2>
            <Grid nations={inRegion} />
          </section>
        );
      })}
    </main>
  );
}

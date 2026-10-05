'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { buildTrail, type Crumb } from '@/ui/site-nav';
import { alpha, color, fontFamily, fontSize, space } from '@/styles/tokens';

/**
 * The breadcrumb trail for the current pathname, plus its `BreadcrumbList`
 * structured data.
 *
 * The trail comes from `buildTrail` (unit-tested), and the visible list and the
 * JSON-LD are built from the SAME array — the usual failure of hand-written
 * breadcrumbs is that the trail a crawler reads and the links a reader clicks
 * disagree, and a second hand-kept list is how that starts.
 *
 * Renders NOTHING on a one-crumb path (`/`): "Home" by itself is not a trail.
 *
 * `origin` is the absolute origin the structured data needs — `BreadcrumbList`
 * items must be absolute URLs. It is passed in rather than hard-coded here
 * because the layout already owns the canonical origin (`metadataBase`); a
 * component that guessed it would be a second, drift-prone copy of that fact.
 * Without it the trail still renders; only the JSON-LD is skipped.
 *
 * A client component only because reading the pathname requires it; Next renders
 * it into the initial HTML, so both the trail and the JSON-LD are in the markup
 * a crawler receives.
 *
 * It lives in `components/layout/`, NOT `components/ui/`: it reads
 * `platform/routing`, and the structure gate (DR-018) keeps `components/ui/*` a
 * leaf that may import nothing but styles. The trail rule itself is not chrome,
 * so it sits in the platform module where it can be unit-tested.
 */
export function Breadcrumb({ labels, origin }: { labels?: Readonly<Record<string, string>>; origin?: string }) {
  const pathname = usePathname();
  const trail = buildTrail(pathname ?? '/', labels);
  if (trail.length < 2) return null;

  return (
    <nav aria-label="Breadcrumb" style={{ padding: `${space[8]}px ${space[20]}px`, fontFamily: fontFamily.mono }}>
      <ol
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: space[8],
          listStyle: 'none',
          margin: 0,
          padding: 0,
          fontSize: fontSize[11],
          color: color.labelTertiary,
        }}
      >
        {trail.map((crumb, i) => {
          const isCurrent = i === trail.length - 1;
          return (
            <li key={crumb.href} style={{ display: 'flex', alignItems: 'center', gap: space[8] }}>
              {/* The separator is decoration; the <ol> already carries the order.
                  It is a tint of the muted text, NOT `color.separator`: separator is a
                  hairline value, and a hairline read as text is invisible. */}
              {i > 0 && <span aria-hidden="true" style={{ color: alpha(color.labelTertiary, 0.7) }}>/</span>}
              {isCurrent ? (
                <span aria-current="page" style={{ color: color.labelPrimary }}>
                  {crumb.label}
                </span>
              ) : (
                <Link href={crumb.href} style={{ color: color.labelTertiary, textDecoration: 'none' }}>
                  {crumb.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
      {origin && <BreadcrumbJsonLd trail={trail} origin={origin} />}
    </nav>
  );
}

/**
 * `BreadcrumbList` structured data for one trail.
 *
 * Split out so a server component that already knows its trail (a page that must
 * not read the pathname on the client) can emit the same structured data from the
 * same `Crumb[]` — never from a second, hand-kept list.
 */
export function BreadcrumbJsonLd({ trail, origin }: { trail: readonly Crumb[]; origin: string }) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((crumb, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: crumb.label,
      item: new URL(crumb.href, origin).toString(),
    })),
  };
  // `<` is escaped so a label can never close the script element early.
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_SECTIONS, TERMINAL, activeSection } from '@/platform/routing/site-nav';
import { alpha, color, fontFamily, fontSize, fontWeight, letterSpacing, radius, space } from '@/styles/tokens';

/**
 * The site's primary navigation bar — the one chrome element every page shares.
 *
 * It renders `NAV_SECTIONS` from `@/platform/routing/site-nav`, so the bar can
 * never list a destination the site does not have: the section list is the same
 * one `tests/nav-tests.ts` checks against the crawl registry, and the rule that
 * decides which link is lit is unit-tested offline rather than eyeballed in a
 * browser.
 *
 * A client component only because reading the pathname requires it. It is not a
 * data fetch: Next renders it into the initial HTML, so the bar is present
 * before hydration, and the markup is stable (the pathname the server renders
 * and the one the client reads are the same for these routes).
 *
 * The active link carries `aria-current="page"`. The accent fill alone is a
 * colour-only signal, and a screen reader cannot see it.
 */
export function Navbar() {
  const pathname = usePathname();
  const active = activeSection(pathname ?? '/');

  return (
    <header style={{ background: color.bg, borderBottom: `1px solid ${color.border}`, fontFamily: fontFamily.mono }}>
      <nav
        aria-label="Primary"
        style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: space[8], padding: `${space[10]}px ${space[20]}px` }}
      >
        <Link
          href="/"
          title="FUDCOURT — home"
          style={{
            color: color.accent,
            fontSize: fontSize[13],
            fontWeight: fontWeight.bold,
            letterSpacing: letterSpacing.wider,
            textDecoration: 'none',
            marginRight: space[8],
          }}
        >
          FUDCOURT
        </Link>

        {NAV_SECTIONS.map((section) => {
          const isActive = section.key === active;
          return (
            <Link
              key={section.key}
              href={section.href}
              title={section.blurb}
              aria-current={isActive ? 'page' : undefined}
              style={{
                color: isActive ? color.textOnAccent : color.text,
                background: isActive ? color.accent : 'transparent',
                border: `1px solid ${isActive ? color.accent : color.border}`,
                borderRadius: radius[6],
                padding: `${space[4]}px ${space[10]}px`,
                fontSize: fontSize[11],
                textDecoration: 'none',
              }}
            >
              {section.label}
            </Link>
          );
        })}

        {/* The terminal is gated, so it is offered as the bar's one action rather
            than as a section. The middleware sends an anonymous visitor to
            /login with ?next=/team, so the link is honest for every reader. */}
        <Link
          href={TERMINAL.href}
          title={TERMINAL.blurb}
          style={{
            marginLeft: 'auto',
            color: color.accent,
            background: alpha(color.accent, 0.08),
            border: `1px solid ${alpha(color.accent, 0.35)}`,
            borderRadius: radius[6],
            padding: `${space[4]}px ${space[10]}px`,
            fontSize: fontSize[11],
            fontWeight: fontWeight.semibold,
            textDecoration: 'none',
          }}
        >
          {TERMINAL.label}
        </Link>
      </nav>
    </header>
  );
}

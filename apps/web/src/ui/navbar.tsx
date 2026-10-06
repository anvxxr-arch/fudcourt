'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_SECTIONS, TERMINAL, activeSection } from '@/ui/site-nav';
import { ThemeToggle } from '@/ui/theme-toggle';
import { alpha, themeColor, fontFamily, fontSize, fontWeight, letterSpacing, motion, radius, space } from '@/styles/tokens';

/**
 * The site's primary navigation bar — the one chrome element every page shares.
 *
 * It renders `NAV_SECTIONS` from `@/ui/site-nav`, so the bar can
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
 * The active link carries `aria-current="page"`. The blue fill alone is a
 * colour-only signal, and a screen reader cannot see it.
 */
export function Navbar() {
  const pathname = usePathname();
  const active = activeSection(pathname ?? '/');

  return (
    <header style={{ background: themeColor.bgBase, borderBottom: `1px solid ${themeColor.separator}`, fontFamily: fontFamily.mono }}>
      <nav
        aria-label="Primary"
        style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: space[8], padding: `${space[8]}px ${space[20]}px` }}
      >
        <Link
          className="fc-focusable"
          href="/"
          title="FUDCOURT — home"
          style={{
            color: themeColor.labelPrimary,
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
              className="fc-focusable"
              key={section.key}
              href={section.href}
              title={section.blurb}
              aria-current={isActive ? 'page' : undefined}
              style={{
                color: isActive ? themeColor.labelOnAccent : themeColor.labelPrimary,
                background: isActive ? themeColor.blue : 'transparent',
                border: `1px solid ${isActive ? themeColor.blue : themeColor.separator}`,
                borderRadius: radius[8],
                padding: `${space[4]}px ${space[8]}px`,
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
            /login with ?next=/team, so the link is honest for every reader.
            `marginLeft: auto` lives on this WRAPPER, not on the link, so the link and the
            theme toggle form one right-hand cluster instead of two separated islands. */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: space[8] }}>
          <Link
            className="fc-focusable"
            href={TERMINAL.href}
            title={TERMINAL.blurb}
            style={{
              color: themeColor.blue,
              background: themeColor.bgSecondary,
              border: `1px solid ${alpha(themeColor.blue, 0.35)}`,
              borderRadius: radius[8],
              padding: `${space[4]}px ${space[8]}px`,
              fontSize: fontSize[11],
              fontWeight: fontWeight.semibold,
              textDecoration: 'none',
              transition: 'background ' + motion.normal + ' ' + motion.ease,
            }}
          >
            {TERMINAL.label}
          </Link>
          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}

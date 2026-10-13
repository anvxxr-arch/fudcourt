'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useContext } from 'react';
import { NAV_SECTIONS, TERMINAL, activeSection, type MegaMenuSection } from '@/ui/site-nav';
import { ThemeToggle } from '@/ui/theme-toggle';
import { alpha, themeColor, fontFamily, fontSize, fontWeight, letterSpacing, motion, radius, space, zIndex } from '@/styles/tokens';
import { useT, useLocale } from '@/lib/i18n/t';
import { LOCALES, LOCALE_COOKIE, type Locale } from '@/lib/i18n';


/**
 * The site's primary navigation bar — the one chrome element every page shares.
 *
 * It renders `NAV_SECTIONS` from `@/ui/site-nav`, so the bar can
 * never list a destination the site does not have: the section list is the same
 * one `tests/nav-tests.ts` checks against the crawl registry, and the rule that
 * decides which link is lit is unit-tested offline rather than browser-eyeballed.
 *
 * A client component only because reading the pathname requires it. It is not a
 * data fetch: Next renders it into the initial HTML, so the bar is present
 * before hydration, and the markup is stable (the pathname the server renders
 * and the one the client reads are the same for these routes).
 *
 * The active link carries `aria-current="page"`. The blue fill alone is a
 * colour-only signal, and a screen reader cannot see it.
 *
 * The MEGA MENU: on pointer/focus over a section that has registered children
 * (server-computed from PUBLIC_ROUTES — see ui/mega-menu.ts), a panel opens
 * listing them. Keyboard gets the same affordance via focus-within; the panel
 * is `position: absolute` so opening it never shifts the page (a hover panel
 * that reflows the bar is the CLS bug the strip comment below already fixed
 * once).
 */
export function Navbar({ mega }: { mega?: MegaMenuSection[] }) {
  const pathname = usePathname();
  const active = activeSection(pathname ?? '/');
  const t = useT();
  // NAV_SECTIONS keys are stable; the DictKey cast is the seam between the nav
  // model (free strings) and the dictionary (typed keys).
  const tNav = (key: string) => t(`nav.${key}` as Parameters<typeof t>[0]);

  return (
    <header style={{ background: themeColor.bgBase, borderBottom: `1px solid ${themeColor.separator}`, fontFamily: fontFamily.mono }}>
      {/*
        Mobile-first chrome: the section strip is the ONLY part that scrolls.

        The bar used to wrap, which at a phone width meant three ragged rows
        (measured at 390px: 10 items, 3 rows, 129px tall — the header alone spent
        a sixth of the viewport, and the rows were ragged because every pill is
        sized to its own label). The sections now share one `overflowX: auto`
        line, with the logo pinned left and the Terminal/toggle cluster pinned
        right, so the two controls a reader reaches for are never scrolled away.
      */}
      <nav
        aria-label={t('nav.primary')}
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
            // WCAG 2.5.8: the wordmark is a standalone target and measured 79x20,
            // under the 24px floor. The padding lifts its border box to 24px and
            // the matching negative margin hands the bar its original 20px
            // cross-size back, so the header does not grow by 4px. This one is an
            // inline style and so cannot use the `td > a::after` overlay the
            // table cells get — it needs no overlay, because unlike them it is
            // ours to style directly.
            //
            // 3px, not 2px: the first attempt used 2px and produced a box of
            // 23.9px. `getBoundingClientRect()` ROUNDS, so it reported "24" and
            // looked correct; the residual survey re-listed it as below the floor
            // because `height >= 24` was false. A rounded measurement is not a
            // passing measurement -- read the raw rect, and leave headroom.
            paddingTop: 3,
            paddingBottom: 3,
            marginTop: -3,
            marginBottom: -3,
            marginRight: space[8],
            flexShrink: 0,
          }}
        >
          FUDCOURT
        </Link>

        {/* The section strip: the one scrollable region. Its `flex-basis` is what
            makes the bar mobile-first WITHOUT a media query — `1 1 160px` keeps
            the bar on one line while the strip can still hold 160px, and once
            the viewport can no longer give it that much the strip wraps to a
            full-width second line. Pinning the strip to `1 1 auto` instead let it
            be squeezed to 54px at a 320px viewport (measured), which is a scroll
            window one pill wide. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: space[8], flex: '1 1 160px', minWidth: 0, overflowX: 'auto' }}>
          {NAV_SECTIONS.map((section) => {
            const isActive = section.key === active;
            const panel = mega?.find((m) => m.key === section.key && m.entries.length > 0);
            return (
              <div key={section.key} style={{ position: 'relative', flexShrink: 0 }} className="fc-mega-host">
                <Link
                  className="fc-focusable"
                  href={section.href}
                  title={section.blurb}
                  aria-current={isActive ? 'page' : undefined}
                  aria-haspopup={panel ? 'true' : undefined}
                  style={{
                    display: 'inline-block',
                    color: isActive ? themeColor.labelOnAccent : themeColor.labelPrimary,
                    background: isActive ? themeColor.blue : 'transparent',
                    border: `1px solid ${isActive ? themeColor.blue : themeColor.separator}`,
                    borderRadius: radius[8],
                    padding: `${space[4]}px ${space[8]}px`,
                    fontSize: fontSize[11],
                    textDecoration: 'none',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {tNav(section.key)}
                </Link>
                {panel && (
                  <div
                    className="fc-mega-panel"
                    role="group"
                    aria-label={section.label}
                    style={{
                      position: 'absolute', top: '100%', left: 0, zIndex: zIndex.tooltip,
                      minWidth: 260, maxWidth: 340,
                      background: themeColor.bgBase,
                      border: `1px solid ${themeColor.separator}`,
                      borderRadius: radius[8],
                      padding: space[8],
                      boxShadow: `0 8px 24px ${alpha(themeColor.bgBase, 0.35)}`,
                    }}
                  >
                    <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginBottom: space[4] }}>{section.blurb}</div>
                    {panel.entries.map((e) => (
                      <Link key={e.href} href={e.href} className="fc-focusable"
                        style={{ display: 'block', color: themeColor.labelPrimary, fontSize: fontSize[11], textDecoration: 'none', padding: `${space[4]}px ${space[4]}px`, borderRadius: radius[8] }}>
                        {e.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* The terminal is gated, so it is offered as the bar's one action rather
            than as a section. The middleware sends an anonymous visitor to
            /login with ?next=/team, so the link is honest for every reader.
            `marginLeft: auto` lives on this WRAPPER, not on the link, so the link and the
            theme toggle form one right-hand cluster instead of two separated islands. */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: space[8], flexShrink: 0 }}>
          <LocaleSwitcher />
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

/**
 * The locale switcher: a native select (free keyboard + mobile behavior). Its
 * change writes the `fc-locale` cookie and updates the shared locale state owned
 * by `<LocaleProvider>` — every `useT()` surface re-renders in place, no server
 * round trip, no router.refresh. The root layout is synchronous (it cannot read
 * the cookie server-side without marking the whole tree dynamic), so the locale
 * is client state: the first paint is always en, and the inline script in the
 * root layout rewrites `document.documentElement.lang` before hydration so the
 * served attribute and the visible chrome agree for a returning visitor.
 */
function LocaleSwitcher() {
  const [current, setLocale] = useLocale();
  const t = useT();
  return (
    <select
      className="fc-focusable"
      aria-label={t('lang.label')}
      value={current}
      onChange={(e) => setLocale(e.target.value as Locale)}
      style={{
        background: themeColor.bgSecondary,
        color: themeColor.labelPrimary,
        border: `1px solid ${themeColor.separator}`,
        borderRadius: radius[8],
        padding: `${space[4]}px ${space[8]}px`,
        fontSize: fontSize[11],
        cursor: 'pointer',
      }}
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {l === 'en' ? 'EN' : l === 'id' ? 'ID' : '中文'}
        </option>
      ))}
    </select>
  );
}

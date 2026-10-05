/**
 * The site's primary navigation model: the top-level sections, and the two pure
 * functions the chrome needs — which section a pathname sits in, and the
 * breadcrumb trail for a pathname.
 *
 * Why this is a plain module and not part of the components: both rules are easy
 * to get subtly wrong (a `/market` prefix that also claims `/marketplace`; a
 * trail that repeats or drops a segment) and both are invisible until someone
 * clicks the wrong link. Kept free of JSX and of `next/navigation`, they are
 * unit-tested offline in `tests/nav-tests.ts`; `navbar.tsx` and
 * `breadcrumb.tsx` are thin renderers over them.
 *
 * This is also the single place the section list is written down, so the navbar
 * and the crawl registry cannot disagree about what the site's top level is —
 * `tests/nav-tests.ts` asserts every section href is a registered public route.
 */

export interface NavSection {
  /** Stable key. Also the identifier `activeSection` returns. */
  key: string;
  href: string;
  label: string;
  /** One line, rendered as the link's `title`. */
  blurb: string;
}

/**
 * The top-level sections, in nav order.
 *
 * Every href here is a real route: `/` is the landing page, `/market` and
 * `/economy` are the two hubs, and the remaining four are standalone boards.
 * The treasury terminal is deliberately NOT a section — it is gated, so it lives
 * as the navbar's action link rather than as a destination every visitor is
 * offered.
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  { key: 'home', href: '/', label: 'Home', blurb: 'What FUDCOURT is, and what the market is doing right now.' },
  { key: 'market', href: '/market', label: 'Market', blurb: 'Crypto, forex, commodity, stock and on-chain DEX boards.' },
  { key: 'trade', href: '/trade', label: 'Trade', blurb: 'Spot, margin, perpetual, futures, options and swap across CEX and DEX venues.' },
  { key: 'economy', href: '/economy', label: 'Economy', blurb: 'Global macro: growth, inflation, labour, money and policy.' },
  { key: 'signals', href: '/signals', label: 'Signals', blurb: 'Curated trading signals with entry levels and confidence.' },
  { key: 'scoreboard', href: '/scoreboard', label: 'Scoreboard', blurb: 'Tracked traders and wallets ranked by realised performance.' },
  { key: 'news', href: '/news', label: 'News', blurb: 'Crypto market news aggregated for treasury and trading decisions.' },
  { key: 'blog', href: '/blog', label: 'Blog', blurb: 'Research, playbooks and insights published through the CMS.' },
] as const;

/** The terminal is gated, so it is the bar's action link, not a section. */
export const TERMINAL = {
  href: '/team',
  label: 'Terminal',
  blurb: 'The cross-chain treasury terminal — team access.',
} as const;

/**
 * Which section a pathname belongs to, or `null` when none does.
 *
 * The match is on a SEGMENT boundary, and the LONGEST href wins:
 *  - `/economy/regime` is `economy`, and so is `/economy` itself;
 *  - `/market` must not claim `/marketplace`, which is why the test is
 *    `pathname === href || pathname.startsWith(href + '/')` and not a bare
 *    `startsWith`;
 *  - `/` matches by EQUALITY only. Every path is "under" the root, so a prefix
 *    rule would light Home up on every page of the site;
 *  - a path under no section (`/team/wallets`, `/login`) returns `null`, and the
 *    navbar renders with nothing active rather than guessing at one.
 */
export function activeSection(pathname: string): string | null {
  let best: NavSection | null = null;
  for (const section of NAV_SECTIONS) {
    const owns =
      section.href === '/'
        ? pathname === '/'
        : pathname === section.href || pathname.startsWith(`${section.href}/`);
    if (owns && (best === null || section.href.length > best.href.length)) best = section;
  }
  return best ? best.key : null;
}

/**
 * One path segment as a human label.
 *
 * The rules, in order:
 *  - a percent-encoded segment is decoded, so a slug carrying an escape reads as
 *    the word it is (a malformed escape stays literal rather than throwing);
 *  - `-` and `_` become spaces (`central-bank` → `central bank`);
 *  - an all-lowercase word of at most three characters is UPPERCASED, which is
 *    what turns the codes and acronyms this app actually spells in URLs into
 *    `ID`, `US` and `CPI` instead of `Id`, `Us` and `Cpi`;
 *  - every other word is capitalised on its first letter ONLY, so a slug is
 *    never silently re-cased into a word it is not.
 */
export function humanizeSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    /* a malformed escape stays literal — this is a label, never a URL */
  }
  return decoded
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) =>
      word.length <= 3 && word === word.toLowerCase()
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

export interface Crumb {
  href: string;
  label: string;
}

/**
 * The breadcrumb trail for a pathname: the root, then one crumb per segment.
 *
 * `labels` overrides the humanised fallback, keyed by the crumb's HREF rather
 * than by the raw segment — so a caller names a destination without having to
 * know how the URL spelled it. The last crumb is the current page, and the
 * component renders it as text with `aria-current="page"` instead of a link to
 * itself.
 *
 * The root is a crumb on every deeper page but is the ONLY crumb on `/`, which
 * is why a caller may hide the whole thing when `trail.length < 2`: a breadcrumb
 * that reads just "Home" on the home page is noise, not navigation.
 */
export function buildTrail(pathname: string, labels?: Readonly<Record<string, string>>): Crumb[] {
  const path = pathname.split('?')[0].split('#')[0];
  const trail: Crumb[] = [{ href: '/', label: labels?.['/'] ?? 'Home' }];
  let href = '';
  for (const segment of path.split('/').filter(Boolean)) {
    href += `/${segment}`;
    trail.push({ href, label: labels?.[href] ?? humanizeSegment(segment) });
  }
  return trail;
}

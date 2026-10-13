/**
 * The mega-menu model, computed from the two registries that already exist —
 * never a third hand-maintained list. Each top-level section's panel lists the
 * REGISTERED public routes that sit under its href prefix (segment-boundary
 * matched, same rule `activeSection` uses), each with the sitemap's own title.
 *
 * A new route becomes menu-eligible by being registered in PUBLIC_ROUTES — the
 * same act that makes it crawlable — so "in the menu" and "in the sitemap"
 * cannot disagree.
 *
 * The `MegaMenuSection`/`MegaMenuEntry` types live in `@/ui/site-nav` next to
 * the nav model they extend: the client navbar reads them without reaching into
 * this server module.
 */
import 'server-only';
import { NAV_SECTIONS, type MegaMenuSection } from '@/ui/site-nav';
import { PUBLIC_ROUTES } from '@/server/routes';

/** A route directly under a section (or the section hub itself) is a panel row. */
function childrenOf(sectionHref: string): MegaMenuSection['entries'] {
  if (sectionHref === '/') return [];
  const prefix = sectionHref + '/';
  return PUBLIC_ROUTES
    .filter((r) => r.path.startsWith(prefix))
    // One segment deep only: the panel is a menu, not a sitemap dump.
    .filter((r) => !r.path.slice(prefix.length).includes('/'))
    .map((r) => ({ href: r.path, label: r.title.replace(/ \| FUDCOURT$/, '') }));
}

export function megaMenu(): MegaMenuSection[] {
  return NAV_SECTIONS.map((s) => ({
    key: s.key,
    href: s.href,
    entries: childrenOf(s.href),
  }));
}

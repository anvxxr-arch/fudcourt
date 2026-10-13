'use client';

import { PagePanel, PagePanelLink } from '@/ui/page-chrome';
import { useT } from '@/lib/i18n/t';

// A client component on purpose: the RootLayout no longer reads `cookies()`
// (that made the whole tree request-time and 500'd every ISR route), so a
// server-side `tServer()` here would reintroduce the same dynamic marking
// through the not-found boundary. The locale arrives from LocaleProvider.
export default function FrontendNotFound() {
  const t = useT();
  return (
    <PagePanel title={t('page.notfound.title')} action={<PagePanelLink href="/">{t('page.backHome')}</PagePanelLink>}>
      {t('page.notfound.body')}
    </PagePanel>
  );
}

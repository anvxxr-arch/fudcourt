'use client';

import { useEffect } from 'react';
import { PagePanel, PagePanelLink } from '@/ui/page-chrome';
import { themeColor, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { useT } from '@/lib/i18n/t';

export default function FrontendError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useT();
  useEffect(() => {
    // Route errors surface loudly; keep the same console channel the feature
    // banners rely on so an upstream failure is never swallowed silently.
    console.error(error);
  }, [error]);
  return (
    <PagePanel
      title={t('page.error.title')}
      action={
        <button
          onClick={reset}
          style={{
            color: themeColor.labelOnAccent,
            background: themeColor.blue,
            border: 'none',
            borderRadius: radius[8],
            padding: `${space[8]}px ${space[16]}px`,
            fontSize: fontSize[12],
            fontWeight: fontWeight.semibold,
            cursor: 'pointer',
          }}
        >
          {t('page.error.retry')}
        </button>
      }
    >
      {error.message || t('page.error.body')}
      <div style={{ marginTop: space[8] }}>
        <PagePanelLink href="/">{t('page.backHome')}</PagePanelLink>
      </div>
    </PagePanel>
  );
}

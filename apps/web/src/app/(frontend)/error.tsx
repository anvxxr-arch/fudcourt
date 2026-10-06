'use client';

import { useEffect } from 'react';
import { PagePanel, PagePanelLink } from '@/ui/page-chrome';
import { color, fontSize, fontWeight, radius, space } from '@/styles/tokens';

export default function FrontendError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Route errors surface loudly; keep the same console channel the feature
    // banners rely on so an upstream failure is never swallowed silently.
    console.error(error);
  }, [error]);
  return (
    <PagePanel
      title="SOMETHING FAILED"
      action={
        <button
          onClick={reset}
          style={{
            color: color.labelOnAccent,
            background: color.blue,
            border: 'none',
            borderRadius: radius[8],
            padding: `${space[8]}px ${space[16]}px`,
            fontSize: fontSize[12],
            fontWeight: fontWeight.semibold,
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
      }
    >
      {error.message || 'An unexpected error occurred while rendering this route.'}
      <div style={{ marginTop: space[8] }}>
        <PagePanelLink href="/">Back to the landing page</PagePanelLink>
      </div>
    </PagePanel>
  );
}

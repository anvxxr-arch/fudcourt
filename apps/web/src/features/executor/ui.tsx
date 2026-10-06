'use client';
/**
 * ui.tsx — executor entry: ExecutorFrame (§81 chrome) + re-exports.
 *
 *   ui-shared.tsx    styles + scalar helpers
 *   ui-composer.tsx  ExecutorComposer, ComposerState, buildExecution (§82, §83, §84, §80)
 *   ui-progress.tsx  ExecutorProgress (§85, §86)
 *   ui-manage.tsx    ExecutorHistory (§22), ExecutorAccounts (§87), ExecutorSettings (§88)
 *
 * Import from '@/features/executor/ui' — never the section modules directly.
 *
 * House rules this feature keeps:
 * - No invented numbers. Every figure is a value the server returned; anything
 *   the server did not compute is `—` (`DASH`), never 0. The only arithmetic
 *   here is the difference of two returned values, which the PRD itself asks
 *   for (filled %, remaining quantity, remaining risk budget).
 * - No polling library and no SWR: fetch on mount plus a manual Refresh.
 * - No secret is ever rendered — the API never returns one (`apiKeyMasked`
 *   only), so the connect form is the single place key material is typed.
 */
import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { themeColor, fontFamily, fontSize, letterSpacing, radius, space } from '@/styles/tokens';
import { noteStyle } from './ui-shared';

// ---------------------------------------------------------------------------
// ExecutorFrame — §81
// ---------------------------------------------------------------------------

const NAV_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/executor/history', label: 'History' },
  { href: '/executor/new', label: 'New execution' },
  { href: '/executor/accounts', label: 'Accounts' },
  { href: '/executor/settings', label: 'Risk settings' },
];

export function ExecutorFrame({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <main style={{ background: themeColor.bgBase, minHeight: '100vh', color: themeColor.labelPrimary, fontFamily: fontFamily.mono, padding: space[20] }}>
      <h1 style={{ margin: 0, color: themeColor.blue, letterSpacing: letterSpacing.wider, fontSize: fontSize[17] }}>CEX EXECUTOR</h1>
      <p style={{ margin: `${space[4]}px 0 0`, color: themeColor.labelTertiary, fontSize: fontSize[11] }}>{title} · {subtitle}</p>
      <p style={noteStyle}>
        non-custodial · your exchange keys, never ours · every figure on this page is what the risk engine returned
        for your own account — a `—` means the engine did not compute it
      </p>
      <div style={{ marginTop: space[12] }}>
        <div style={{ display: 'flex', gap: space[8], flexWrap: 'wrap', margin: `0 0 ${space[12]}px` }}>
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              style={{
                background: themeColor.bgSecondary,
                color: themeColor.blue,
                border: `1px solid ${themeColor.separator}`,
                padding: `${space[8]}px ${space[12]}px`,
                borderRadius: radius[8],
                fontSize: fontSize[11],
                textDecoration: 'none',
              }}
            >
              {link.label}
            </Link>
          ))}
          <Link href="/team/balance" style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], padding: `${space[8]}px ${space[4]}px` }}>← back to store</Link>
        </div>
        {children}
      </div>
    </main>
  );
}

export type { ComposerState } from './ui-composer';
export { buildExecution, ExecutorComposer } from './ui-composer';
export { ExecutorProgress } from './ui-progress';
export { ExecutorAccounts, ExecutorHistory, ExecutorOverview, ExecutorSettings } from './ui-manage';

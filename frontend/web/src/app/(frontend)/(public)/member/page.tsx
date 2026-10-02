import StoreShell from '@/components/layout/store-shell';
import { requireTier } from '@/platform/auth/guard';
import { color, fontFamily, fontSize, letterSpacing, space } from '@/styles/tokens';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
// Member landing view: login-gated; the shared public market boards plus a
// small member overview placeholder. No new data sources — only the existing
// session and the board components the shell already mounts.
export default async function MemberPage() {
  const user = await requireTier('member');
  return (
    <main style={{ background: color.bg, minHeight: '100vh', color: color.text, fontFamily: fontFamily.mono }}>
      <div style={{ padding: `${space[20]}px ${space[20]}px 0` }}>
        <h1 style={{ margin: 0, color: color.accent, letterSpacing: letterSpacing.wider, fontSize: fontSize[18] }}>MEMBER OVERVIEW</h1>
        <p style={{ margin: `${space[4]}px 0 0`, color: color.textMuted, fontSize: fontSize[12] }}>
          {`Signed in as ${user.username} (${user.tier}).`}
        </p>
        <p style={{ margin: `${space[4]}px 0 0`, color: color.textMuted, fontSize: fontSize[12] }}>
          Your personal member view lands here next; below are the shared market boards.
        </p>
      </div>
      <StoreShell initialPage="ticker" />
    </main>
  );
}

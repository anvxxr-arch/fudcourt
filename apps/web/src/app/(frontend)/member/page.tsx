import StoreShell from '@/shell/store-shell';
import { requireTier } from '@/platform/auth/guard';
import { C } from '@/styles/shared';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Member landing view: login-gated; the shared public market boards plus a
// small member overview placeholder. No new data sources — only the existing
// session and the board components the shell already mounts.
export default async function MemberPage() {
  const user = await requireTier('member');
  return (
    <main style={{ background: C.bg, minHeight: '100vh', color: C.white, fontFamily: 'ui-monospace, monospace' }}>
      <div style={{ padding: '20px 20px 0' }}>
        <h1 style={{ margin: 0, color: C.accent, letterSpacing: 2, fontSize: 18 }}>MEMBER OVERVIEW</h1>
        <p style={{ margin: '4px 0 0', color: C.dim, fontSize: 12 }}>
          {`Signed in as ${user.username} (${user.tier}).`}
        </p>
        <p style={{ margin: '4px 0 0', color: C.dim, fontSize: 12 }}>
          Your personal member view lands here next; below are the shared market boards.
        </p>
      </div>
      <StoreShell initialPage="ticker" />
    </main>
  );
}

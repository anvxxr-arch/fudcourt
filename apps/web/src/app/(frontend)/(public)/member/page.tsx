import StoreShell from '@/features/overview/store-shell';
import { requireTier } from '@/server/auth';
import { color, fontFamily, fontSize, letterSpacing, space } from '@/styles/tokens';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
// Member landing view: login-gated; the shared public market boards plus a
// small member overview placeholder. No new data sources — only the existing
// session and the board components the shell already mounts.
export default async function MemberPage() {
  const user = await requireTier('member');
  return (
    <main style={{ background: color.bgBase, minHeight: '100vh', color: color.labelPrimary, fontFamily: fontFamily.mono }}>
      <div style={{ padding: `${space[20]}px ${space[20]}px 0` }}>
        <h1 style={{ margin: 0, color: color.blue, letterSpacing: letterSpacing.wider, fontSize: fontSize[17] }}>MEMBER OVERVIEW</h1>
        <p style={{ margin: `${space[4]}px 0 0`, color: color.labelTertiary, fontSize: fontSize[12] }}>
          {`Signed in as ${user.username} (${user.tier}).`}
        </p>
        <p style={{ margin: `${space[4]}px 0 0`, color: color.labelTertiary, fontSize: fontSize[12] }}>
          This is your member home: the same public market boards the anonymous surface shows, served live from the
          origin APIs. Nothing here touches the treasury — a member account earns the team terminal via Discord rank.
        </p>
      </div>
      <StoreShell initialPage="market" />
    </main>
  );
}

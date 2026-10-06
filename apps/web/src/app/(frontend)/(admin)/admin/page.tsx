import { requireTier } from '@/server/auth';
import { themeColor, fontFamily, fontSize, letterSpacing, space } from '@/styles/tokens';
import { getAll } from '@/server/db';
import { groupSum } from '@/lib/format';
import { Meter } from '@/ui/meter';
import MemberTable from '@/features/admin/members-table';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Admin control panel: server-gated to the admin tier, then two panes —
// (1) the guild member list with tier + role grant/revoke (fetched client-side
//     by MemberTable, which must be able to refresh after a role change), and
// (2) a read-only audit view of the treasury the team can see, so an admin can
//     diagnose a reconciliation gap without opening a database client.
//
// The treasury pane reads server-side and surfaces an upstream failure loudly
// instead of rendering an empty table that would read like a real result.
export default async function AdminPage() {
  const user = await requireTier('admin');

  let auditError: string | null = null;
  let snapshot: { wallets: number; transactions: number; assets: number; netWorth: number; topMovers: { asset: string; usd: number }[] } | null = null;
  try {
    const data = await getAll();
    const assets = (data.assets ?? []) as { value_usd?: number; asset?: string }[];
    const byAsset = groupSum(assets, (a) => a.asset ?? '—', (a) => Number(a.value_usd) || 0);
    snapshot = {
      wallets: (data.wallets ?? []).length,
      transactions: (data.transactions ?? []).length,
      assets: assets.length,
      netWorth: Number(data.net_worth) || 0,
      topMovers: Object.entries(byAsset)
        .map(([asset, usd]) => ({ asset, usd }))
        .sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd))
        .slice(0, 8),
    };
  } catch (err) {
    auditError = err instanceof Error ? err.message : String(err);
  }

  return (
    <main style={{ background: themeColor.bgBase, minHeight: '100vh', color: themeColor.labelPrimary, padding: space[20], fontFamily: fontFamily.mono }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: space[8] }}>
        <div>
          <h1 style={{ margin: 0, color: themeColor.blue, letterSpacing: letterSpacing.wider, fontSize: fontSize[20] }}>ADMIN CONTROL PANEL</h1>
          <p style={{ margin: `${space[4]}px 0 0`, color: themeColor.labelTertiary, fontSize: fontSize[12] }}>
            Signed in as {user.globalName ?? user.username} ({user.tier})
          </p>
        </div>
        <a href="/api/auth/logout" style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>log out →</a>
      </div>

      <section style={{ marginTop: space[24] }}>
        <h2 style={{ fontSize: fontSize[15], color: themeColor.labelPrimary, margin: `0 0 ${space[4]}px` }}>Members</h2>
        <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12], margin: `0 0 ${space[8]}px` }}>
          Tiers are read live from Discord roles. Grant or revoke here and the next sign-in picks it up.
        </p>
        <MemberTable />
      </section>

      <section style={{ marginTop: space[32] }}>
        <h2 style={{ fontSize: fontSize[15], color: themeColor.labelPrimary, margin: `0 0 ${space[8]}px` }}>Treasury audit (read-only)</h2>
        {auditError ? (
          <p style={{ color: themeColor.red, fontSize: fontSize[12] }}>treasury read failed: {auditError}</p>
        ) : snapshot ? (
          <div style={{ display: 'flex', gap: space[24], flexWrap: 'wrap' }}>
            <div>
              <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>net worth</div>
              <div style={{ color: themeColor.blue, fontSize: fontSize[17] }}>${snapshot.netWorth.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
            </div>
            {[['wallets', snapshot.wallets], ['transactions', snapshot.transactions], ['asset rows', snapshot.assets]].map(([label, value]) => (
              <div key={label as string}>
                <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>{label}</div>
                <div style={{ fontSize: fontSize[17] }}>{value}</div>
              </div>
            ))}
            <div style={{ flexBasis: '100%' }}>
              <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginBottom: space[4] }}>largest positions by asset</div>
              <Meter parts={snapshot.topMovers.map((t) => ({ label: t.asset, value: Math.abs(t.usd) }))} style={{ marginBottom: space[12] }} />
              <table style={{ fontSize: fontSize[12], borderCollapse: 'collapse' }}>
                <tbody>
                  {snapshot.topMovers.map(t => (
                    <tr key={t.asset}>
                      <td style={{ padding: '2px 12px 2px 0', color: themeColor.labelTertiary }}>{t.asset}</td>
                      <td style={{ padding: '2px 0' }}>${t.usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}

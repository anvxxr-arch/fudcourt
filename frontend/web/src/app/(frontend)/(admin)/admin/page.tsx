import { requireTier } from '@/platform/auth/guard';
import { C } from '@/styles/shared';
import { getAll } from '@/platform/db/client';
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
    const assets = (data.assets ?? []) as { value_usd?: number }[];
    const byAsset = new Map<string, number>();
    for (const a of assets) {
      const usd = Number(a.value_usd) || 0;
      const key = (a as { asset?: string }).asset ?? '—';
      byAsset.set(key, (byAsset.get(key) ?? 0) + usd);
    }
    snapshot = {
      wallets: (data.wallets ?? []).length,
      transactions: (data.transactions ?? []).length,
      assets: assets.length,
      netWorth: Number(data.net_worth) || 0,
      topMovers: Array.from(byAsset, ([asset, usd]) => ({ asset, usd }))
        .sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd))
        .slice(0, 8),
    };
  } catch (err) {
    auditError = err instanceof Error ? err.message : String(err);
  }

  return (
    <main style={{ background: C.bg, minHeight: '100vh', color: C.white, padding: 20, fontFamily: 'ui-monospace, monospace' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h1 style={{ margin: 0, color: C.accent, letterSpacing: 2, fontSize: 20 }}>ADMIN CONTROL PANEL</h1>
          <p style={{ margin: '4px 0 0', color: C.dim, fontSize: 12 }}>
            Signed in as {user.globalName ?? user.username} ({user.tier})
          </p>
        </div>
        <a href="/api/auth/logout" style={{ color: C.dim, fontSize: 12 }}>log out →</a>
      </div>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 14, color: C.white, margin: '0 0 4px' }}>Members</h2>
        <p style={{ color: C.dim, fontSize: 12, margin: '0 0 10px' }}>
          Tiers are read live from Discord roles. Grant or revoke here and the next sign-in picks it up.
        </p>
        <MemberTable />
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 14, color: C.white, margin: '0 0 10px' }}>Treasury audit (read-only)</h2>
        {auditError ? (
          <p style={{ color: C.red, fontSize: 12 }}>treasury read failed: {auditError}</p>
        ) : snapshot ? (
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <div>
              <div style={{ color: C.dim, fontSize: 11 }}>net worth</div>
              <div style={{ color: C.accent, fontSize: 16 }}>${snapshot.netWorth.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
            </div>
            {[['wallets', snapshot.wallets], ['transactions', snapshot.transactions], ['asset rows', snapshot.assets]].map(([label, value]) => (
              <div key={label as string}>
                <div style={{ color: C.dim, fontSize: 11 }}>{label}</div>
                <div style={{ fontSize: 16 }}>{value}</div>
              </div>
            ))}
            <div style={{ flexBasis: '100%' }}>
              <div style={{ color: C.dim, fontSize: 11, marginBottom: 4 }}>largest positions by asset</div>
              <table style={{ fontSize: 12, borderCollapse: 'collapse' }}>
                <tbody>
                  {snapshot.topMovers.map(t => (
                    <tr key={t.asset}>
                      <td style={{ padding: '2px 12px 2px 0', color: C.dim }}>{t.asset}</td>
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

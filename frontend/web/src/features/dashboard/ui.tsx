'use client';

import { C, Asset, CHAIN_COLOR, groupBy, groupSum } from '@/styles/shared';
import { Card } from '@/components/ui/primitives';

type Props = {
  assets: Asset[];
  total: number;
  getAlias: (label: string) => string;
  getColor: (label: string) => string;
};

export default function DashboardPage({ assets, total, getAlias, getColor }: Props) {
  const byOwner = groupBy(assets, a => a.wallet || 'Unassigned');
  const byChain = groupBy(assets, a => a.chain || 'Unknown');
  const ownerTotals = groupSum(assets, a => a.wallet || 'Unassigned', a => a.value_usd);
  const sortedOwners = Object.entries(ownerTotals).sort((a, b) => b[1] - a[1]);

  return (
    <div>
      <Card>
        <div style={{ color: C.dim, fontSize: 12, letterSpacing: 1 }}>NET WORTH</div>
        <div style={{ fontSize: 40, fontWeight: 700, color: C.accent }}>
          ${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        <div style={{ color: C.dim, fontSize: 12, marginTop: 6 }}>
          {assets.length} assets · {sortedOwners.length} entities · on-chain + CEX
        </div>
      </Card>

      <h3 style={{ color: C.accent }}>Per Entity</h3>
      {sortedOwners.map(([owner, total]) => (
        <Card key={owner}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <b style={{ color: getColor(owner) }}>{getAlias(owner)}</b>
            <b style={{ color: C.accent }}>${total.toFixed(2)}</b>
          </div>
          <div style={{ marginTop: 8, fontSize: 13, color: C.dim }}>
            {byOwner[owner].map(a => (
              <span key={a.id} style={{ marginRight: 12 }}>
                <span style={{ color: CHAIN_COLOR[a.chain] || C.dim }}>{a.asset}</span>{' '}
                {Number(a.quantity).toLocaleString('en-US', { maximumFractionDigits: 6 })}
              </span>
            ))}
          </div>
        </Card>
      ))}

      <h3 style={{ color: C.accent }}>Assets Detail</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${C.border}`, color: C.dim }}>
            <th style={{ textAlign: 'left', padding: 8 }}>Chain</th>
            <th style={{ textAlign: 'left', padding: 8 }}>Coin</th>
            <th style={{ textAlign: 'right', padding: 8 }}>Balance</th>
            <th style={{ textAlign: 'right', padding: 8 }}>USD</th>
            <th style={{ textAlign: 'left', padding: 8 }}>Owner</th>
          </tr>
        </thead>
        <tbody>
          {assets.map(a => (
            <tr key={a.id} style={{ borderBottom: `1px solid ${C.border}` }}>
              <td style={{ padding: 8, color: CHAIN_COLOR[a.chain] || C.white }}>{a.chain}</td>
              <td style={{ padding: 8 }}>{a.asset}</td>
              <td style={{ padding: 8, textAlign: 'right' }}>{Number(a.quantity).toLocaleString('en-US', { maximumFractionDigits: 8 })}</td>
              <td style={{ padding: 8, textAlign: 'right', color: C.accent }}>${Number(a.value_usd).toFixed(2)}</td>
              <td style={{ padding: 8, color: getColor(a.wallet) }}>{getAlias(a.wallet)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: `2px solid ${C.accent}` }}>
            <td colSpan={3} style={{ padding: 8, textAlign: 'right', color: C.dim }}>TOTAL</td>
            <td style={{ padding: 8, textAlign: 'right', fontWeight: 700, color: C.accent }}>${total.toFixed(2)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

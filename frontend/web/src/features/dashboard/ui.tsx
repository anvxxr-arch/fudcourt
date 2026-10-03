'use client';

import { color, fontSize, fontWeight, letterSpacing, space } from '@/styles/tokens';
import { Asset, CHAIN_COLOR, groupBy, groupSum } from '@/styles/shared';
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
        <div style={{ color: color.textMuted, fontSize: fontSize[12], letterSpacing: letterSpacing.wide }}>NET WORTH</div>
        <div style={{ fontSize: fontSize[40], fontWeight: fontWeight.bold, color: color.accent }}>
          ${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        <div style={{ color: color.textMuted, fontSize: fontSize[12], marginTop: space[6] }}>
          {assets.length} assets · {sortedOwners.length} entities · on-chain + CEX
        </div>
      </Card>

      <h3 style={{ color: color.accent }}>Per Entity</h3>
      {sortedOwners.map(([owner, total]) => (
        <Card key={owner}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <b style={{ color: getColor(owner) }}>{getAlias(owner)}</b>
            <b style={{ color: color.accent }}>${total.toFixed(2)}</b>
          </div>
          <div style={{ marginTop: space[8], fontSize: fontSize[13], color: color.textMuted }}>
            {byOwner[owner].map(a => (
              <span key={a.id} style={{ marginRight: space[12] }}>
                <span style={{ color: CHAIN_COLOR[a.chain] || color.textMuted }}>{a.asset}</span>{' '}
                {Number(a.quantity).toLocaleString('en-US', { maximumFractionDigits: 6 })}
              </span>
            ))}
          </div>
        </Card>
      ))}

      <h3 style={{ color: color.accent }}>Assets Detail</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: fontSize[13] }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${color.border}`, color: color.textMuted }}>
            <th style={{ textAlign: 'left', padding: space[8] }}>Chain</th>
            <th style={{ textAlign: 'left', padding: space[8] }}>Coin</th>
            <th style={{ textAlign: 'right', padding: space[8] }}>Balance</th>
            <th style={{ textAlign: 'right', padding: space[8] }}>USD</th>
            <th style={{ textAlign: 'left', padding: space[8] }}>Owner</th>
          </tr>
        </thead>
        <tbody>
          {assets.map(a => (
            <tr key={a.id} style={{ borderBottom: `1px solid ${color.border}` }}>
              <td style={{ padding: space[8], color: CHAIN_COLOR[a.chain] || color.text }}>{a.chain}</td>
              <td style={{ padding: space[8] }}>{a.asset}</td>
              <td style={{ padding: space[8], textAlign: 'right' }}>{Number(a.quantity).toLocaleString('en-US', { maximumFractionDigits: 8 })}</td>
              <td style={{ padding: space[8], textAlign: 'right', color: color.accent }}>${Number(a.value_usd).toFixed(2)}</td>
              <td style={{ padding: space[8], color: getColor(a.wallet) }}>{getAlias(a.wallet)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: `2px solid ${color.accent}` }}>
            <td colSpan={3} style={{ padding: space[8], textAlign: 'right', color: color.textMuted }}>TOTAL</td>
            <td style={{ padding: space[8], textAlign: 'right', fontWeight: fontWeight.bold, color: color.accent }}>${total.toFixed(2)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

'use client';

import { themeColor, fontSize, fontWeight, letterSpacing, space } from '@/styles/tokens';
import { Asset, CHAIN_COLOR, groupBy, groupSum } from '@/lib/format';
import { Card } from '@/ui/primitives';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';

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
        <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[12], letterSpacing: letterSpacing.wide }}>NET WORTH</div>
        <div style={{ fontSize: fontSize[34], fontWeight: fontWeight.bold, color: themeColor.blue }}>
          ${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[12], marginTop: space[8] }}>
          {assets.length} assets · {sortedOwners.length} entities · on-chain + CEX
        </div>
      </Card>

      <h3 style={{ color: themeColor.blue }}>Per Entity</h3>
      {sortedOwners.map(([owner, total]) => (
        <Card key={owner}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <b style={{ color: getColor(owner) }}>{getAlias(owner)}</b>
            <b style={{ color: themeColor.blue }}>${total.toFixed(2)}</b>
          </div>
          <div style={{ marginTop: space[8], fontSize: fontSize[13], color: themeColor.labelTertiary }}>
            {byOwner[owner].map(a => (
              <span key={a.id} style={{ marginRight: space[12] }}>
                <span style={{ color: CHAIN_COLOR[a.chain] || themeColor.labelTertiary }}>{a.asset}</span>{' '}
                {Number(a.quantity).toLocaleString('en-US', { maximumFractionDigits: 6 })}
              </span>
            ))}
          </div>
        </Card>
      ))}

      <h3 style={{ color: themeColor.blue }}>Assets Detail</h3>
      <Table style={{ fontSize: fontSize[13] }}>
        <THead>
          <TR style={{ color: themeColor.labelTertiary }}>
            <TH style={{ padding: space[8], fontWeight: fontWeight.regular }}>Chain</TH>
            <TH style={{ padding: space[8], fontWeight: fontWeight.regular }}>Coin</TH>
            <TH align="right" style={{ padding: space[8], fontWeight: fontWeight.regular }}>Balance</TH>
            <TH align="right" style={{ padding: space[8], fontWeight: fontWeight.regular }}>USD</TH>
            <TH style={{ padding: space[8], fontWeight: fontWeight.regular }}>Owner</TH>
          </TR>
        </THead>
        <TBody>
          {assets.map(a => (
            <TR key={a.id}>
              <TD style={{ padding: space[8], color: CHAIN_COLOR[a.chain] || themeColor.labelPrimary }}>{a.chain}</TD>
              <TD style={{ padding: space[8] }}>{a.asset}</TD>
              <TD align="right" mono style={{ padding: space[8] }}>{Number(a.quantity).toLocaleString('en-US', { maximumFractionDigits: 8 })}</TD>
              <TD align="right" mono style={{ padding: space[8], color: themeColor.blue }}>${Number(a.value_usd).toFixed(2)}</TD>
              <TD style={{ padding: space[8], color: getColor(a.wallet) }}>{getAlias(a.wallet)}</TD>
            </TR>
          ))}
        </TBody>
        <tfoot>
          <TR style={{ borderBottom: 'none', borderTop: `2px solid ${themeColor.blue}` }}>
            <TD colSpan={3} align="right" style={{ padding: space[8], color: themeColor.labelTertiary }}>TOTAL</TD>
            <TD align="right" mono style={{ padding: space[8], fontWeight: fontWeight.bold, color: themeColor.blue }}>${total.toFixed(2)}</TD>
            <TD />
          </TR>
        </tfoot>
      </Table>
    </div>
  );
}

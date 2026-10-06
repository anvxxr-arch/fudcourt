'use client';

import { themeColor, fontSize, space } from '@/styles/tokens';
import { Asset, CHAIN_COLOR, groupBy, groupSum } from '@/lib/format';
import { Card } from '@/ui/primitives';

type Props = {
  assets: Asset[];
  getAlias: (label: string) => string;
};

export default function PortfolioPage({ assets, getAlias }: Props) {
  const byChain = groupBy(assets, a => a.chain || 'Unknown');
  const chainTotals = groupSum(assets, a => a.chain || 'Unknown', a => a.value_usd);
  const sortedChains = Object.entries(chainTotals).sort((a, b) => b[1] - a[1]);

  return (
    <div>
      <h3 style={{ color: themeColor.blue }}>Portfolio by Chain</h3>
      {sortedChains.map(([chain, total]) => (
        <Card key={chain}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <b style={{ color: CHAIN_COLOR[chain] || themeColor.labelPrimary }}>{chain}</b>
            <b style={{ color: themeColor.blue }}>${total.toFixed(2)}</b>
          </div>
          <div style={{ marginTop: space[8], fontSize: fontSize[13], color: themeColor.labelTertiary }}>
            {byChain[chain].map(a => (
              <span key={a.id} style={{ marginRight: space[12] }}>
                <span style={{ color: themeColor.blue }}>{a.asset}</span>{' '}
                {Number(a.quantity).toLocaleString('en-US', { maximumFractionDigits: 8 })}
                <span style={{ marginLeft: space[4] }}>({getAlias(a.wallet)})</span>
              </span>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

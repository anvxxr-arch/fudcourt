'use client';

import { color, fontSize, space } from '@/styles/tokens';
import { Asset, CHAIN_COLOR, groupBy, groupSum } from '@/styles/shared';
import { Card } from '@/components/ui/primitives';

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
      <h3 style={{ color: color.accent }}>Portfolio by Chain</h3>
      {sortedChains.map(([chain, total]) => (
        <Card key={chain}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <b style={{ color: CHAIN_COLOR[chain] || color.text }}>{chain}</b>
            <b style={{ color: color.accent }}>${total.toFixed(2)}</b>
          </div>
          <div style={{ marginTop: space[8], fontSize: fontSize[13], color: color.textMuted }}>
            {byChain[chain].map(a => (
              <span key={a.id} style={{ marginRight: space[14] }}>
                <span style={{ color: color.accent }}>{a.asset}</span>{' '}
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

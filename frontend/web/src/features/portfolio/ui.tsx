'use client';

import { C, Asset, CHAIN_COLOR, groupBy, groupSum } from '@/styles/shared';
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
      <h3 style={{ color: C.accent }}>Portfolio by Chain</h3>
      {sortedChains.map(([chain, total]) => (
        <Card key={chain}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <b style={{ color: CHAIN_COLOR[chain] || C.white }}>{chain}</b>
            <b style={{ color: C.accent }}>${total.toFixed(2)}</b>
          </div>
          <div style={{ marginTop: 8, fontSize: 13, color: C.dim }}>
            {byChain[chain].map(a => (
              <span key={a.id} style={{ marginRight: 14 }}>
                <span style={{ color: C.accent }}>{a.asset}</span>{' '}
                {Number(a.quantity).toLocaleString('en-US', { maximumFractionDigits: 8 })}
                <span style={{ marginLeft: 4 }}>({getAlias(a.wallet)})</span>
              </span>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

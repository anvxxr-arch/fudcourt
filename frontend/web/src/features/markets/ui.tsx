'use client';

import { useState } from 'react';
import { color, fontSize, radius, space } from '@/styles/tokens';
import TrackerPage from '@/features/tracker/ui';
import LlamaPage from '@/features/llama/ui';
import DexPage from '@/features/dex/ui';
import TrenchPage from '@/features/dex/trench';

// The Markets surface — one page over three keyless providers, replacing the
// three separate price/chain/pair mirror pages:
//   prices  → CoinGecko   (/api/markets)   top-250 pool, local sort/search
//   chains  → DeFiLlama   (/api/llama)     chains + protocols + TVL
//   pairs   → DexScreener (/api/dex)       per-pair liquidity/txns/fdv
//   trench  → DexScreener (/api/dex)       live pair trench
// Each tab renders the existing board component unchanged; this page only adds
// the tab chrome, so the providers' envelopes are untouched.
const TABS = [
  { key: 'prices', label: 'Prices' },
  { key: 'chains', label: 'Chains & TVL' },
  { key: 'pairs', label: 'Pairs' },
  { key: 'trench', label: 'Trench' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export default function MarketsPage() {
  const [tab, setTab] = useState<TabKey>('prices');

  return (
    <div>
      <div style={{ display: 'flex', gap: space[10], marginBottom: space[18], flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              background: tab === t.key ? color.accent : color.surface,
              color: tab === t.key ? color.textOnAccent : color.text,
              padding: `${space[8]}px ${space[16]}px`,
              border: `1px solid ${color.border}`,
              borderRadius: radius[8],
              cursor: 'pointer',
              fontSize: fontSize[12],
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'prices' && <TrackerPage />}
      {tab === 'chains' && <LlamaPage />}
      {tab === 'pairs' && <DexPage />}
      {tab === 'trench' && <TrenchPage />}
    </div>
  );
}

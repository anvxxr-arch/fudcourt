'use client';

import { useState, useMemo } from 'react';
import { alpha, color, fontFamily, fontSize, fontWeight, letterSpacing, radius, space } from '@/styles/tokens';
import { EmptyState } from '@/components/ui/feedback';
import { Wallet, groupBy, groupSum } from '@/styles/shared';
import { Card } from '@/components/ui/primitives';

type ReconRow = {
  wallet: string;
  asset: string;
  current: number;
  in_sum: number;
  out_sum: number;
  expected: number;
  diff: number;
};

type Props = {
  rows: ReconRow[];
  wallets: Wallet[];
};

export default function ReconciliationPage({ rows, wallets }: Props) {
  const [filter, setFilter] = useState<'all' | 'diff' | 'ok'>('diff');
  const [search, setSearch] = useState('');

  const walletMap = useMemo(() => {
    const m: Record<string, Wallet> = {};
    for (const w of wallets) m[w.label] = w;
    return m;
  }, [wallets]);

  const filtered = useMemo(() => {
    return rows.filter(r => {
      if (filter === 'diff' && Math.abs(r.diff) < 0.01) return false;
      if (filter === 'ok' && Math.abs(r.diff) >= 0.01) return false;
      if (search) {
        const s = search.toLowerCase();
        return r.wallet.toLowerCase().includes(s) || r.asset.toLowerCase().includes(s);
      }
      return true;
    });
  }, [rows, filter, search]);

  const totals = useMemo(() => {
    let current = 0, expected = 0, diff = 0;
    for (const r of rows) {
      current += r.current;
      expected += r.expected;
      diff += r.diff;
    }
    return { current, expected, diff };
  }, [rows]);

  const totalAbsDiff = useMemo(() => {
    return rows.reduce((s, r) => s + Math.abs(r.diff), 0);
  }, [rows]);

  return (
    <div>
      <h3 style={{ color: color.accent }}>Reconciliation</h3>
      <p style={{ color: color.textMuted, fontSize: fontSize[12], marginBottom: space[16] }}>
        Cross-check: <b style={{ color: color.text }}>current balance</b> = sum(IN) − sum(OUT) per wallet/asset.
        Non-zero diff = investigate.
      </p>

      <div style={{ display: 'flex', gap: space[16], marginBottom: space[20], flexWrap: 'wrap' }}>
        <Card style={{ borderLeft: `3px solid ${totalAbsDiff < 0.01 ? color.accent : color.negative}` }}>
          <div style={{ color: color.textMuted, fontSize: fontSize[11] }}>NET DIFF</div>
          <div style={{ fontSize: fontSize[24], fontWeight: fontWeight.bold, color: totalAbsDiff < 0.01 ? color.accent : color.negative }}>
            ${totalAbsDiff.toFixed(2)}
          </div>
        </Card>
        <Card>
          <div style={{ color: color.textMuted, fontSize: fontSize[11] }}>TOTAL CURRENT</div>
          <div style={{ fontSize: fontSize[24], fontWeight: fontWeight.bold, color: color.accent }}>${totals.current.toFixed(2)}</div>
        </Card>
        <Card>
          <div style={{ color: color.textMuted, fontSize: fontSize[11] }}>TOTAL EXPECTED</div>
          <div style={{ fontSize: fontSize[24], fontWeight: fontWeight.bold, color: color.text }}>${totals.expected.toFixed(2)}</div>
        </Card>
      </div>

      <div style={{ display: 'flex', gap: space[10], marginBottom: space[16], flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search wallet or asset..."
          style={{
            background: color.surface, color: color.text, border: `1px solid ${color.border}`,
            borderRadius: radius[8], padding: `${space[8]}px ${space[12]}px`, fontSize: fontSize[13], outline: 'none', flex: 1, minWidth: 200,
          }}
        />
        <FilterBtn active={filter === 'diff'} onClick={() => setFilter('diff')} tone={color.negative}>
          Suspicious ({rows.filter(r => Math.abs(r.diff) >= 0.01).length})
        </FilterBtn>
        <FilterBtn active={filter === 'ok'} onClick={() => setFilter('ok')} tone={color.accent}>
          Balanced ({rows.filter(r => Math.abs(r.diff) < 0.01).length})
        </FilterBtn>
        <FilterBtn active={filter === 'all'} onClick={() => setFilter('all')} tone={color.accent}>
          All ({rows.length})
        </FilterBtn>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <EmptyState style={{ padding: space[20] }}>
            {filter === 'diff' ? 'No suspicious rows found ✓' : 'No rows found'}
          </EmptyState>
        </Card>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: fontSize[13] }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${color.border}` }}>
              <Th>Wallet</Th>
              <Th>Asset</Th>
              <Th align="right">Current</Th>
              <Th align="right">Σ IN</Th>
              <Th align="right">Σ OUT</Th>
              <Th align="right">Expected</Th>
              <Th align="right">Diff</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => {
              const isBad = Math.abs(r.diff) >= 0.01;
              const w = walletMap[r.wallet];
              return (
                <tr key={`${r.wallet}-${r.asset}-${i}`} style={{ borderBottom: `1px solid ${alpha(color.border, 0x22 / 255)}` }}>
                  <Td>
                    <span style={{ fontSize: fontSize[16] }}>{w?.emoji || '💰'}</span>{' '}
                    <b style={{ color: w?.color || color.accent }}>{w?.alias || r.wallet}</b>
                    {w?.alias && w.alias !== r.wallet && (
                      <span style={{ color: color.textMuted, fontSize: fontSize[10], marginLeft: space[6] }}>({r.wallet})</span>
                    )}
                  </Td>
                  <Td>
                    <span style={{ color: color.accent }}>{r.asset}</span>
                  </Td>
                  <Td align="right" style={{ color: color.text, fontFamily: fontFamily.mono }}>
                    {r.current.toFixed(6)}
                  </Td>
                  <Td align="right" style={{ color: color.accent, fontFamily: fontFamily.mono }}>
                    {r.in_sum.toFixed(2)}
                  </Td>
                  <Td align="right" style={{ color: color.negative, fontFamily: fontFamily.mono }}>
                    {r.out_sum.toFixed(2)}
                  </Td>
                  <Td align="right" style={{ color: color.textMuted, fontFamily: fontFamily.mono }}>
                    {r.expected.toFixed(2)}
                  </Td>
                  <Td
                    align="right"
                    style={{
                      fontFamily: fontFamily.mono,
                      fontWeight: fontWeight.bold,
                      color: isBad ? color.negative : color.accent,
                      background: isBad ? alpha(color.negative, 17 / 255) : 'transparent',
                    }}
                  >
                    {isBad ? '⚠️' : ''} {r.diff.toFixed(4)}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function FilterBtn({ active, onClick, children, tone }: { active: boolean; onClick: () => void; children: React.ReactNode; tone: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? tone : color.surface,
        color: active ? color.textOnAccent : color.text,
        border: `1px solid ${color.border}`,
        borderRadius: radius[8],
        padding: `${space[8]}px ${space[16]}px`,
        cursor: 'pointer',
        fontSize: fontSize[12],
        fontWeight: fontWeight.semibold,
      }}
    >
      {children}
    </button>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th style={{ padding: space[8], textAlign: align, color: color.textMuted, fontSize: fontSize[11], fontWeight: fontWeight.semibold, letterSpacing: letterSpacing.sm }}>
      {children}
    </th>
  );
}

function Td({ children, align = 'left', style }: { children: React.ReactNode; align?: 'left' | 'right'; style?: React.CSSProperties }) {
  return <td style={{ padding: space[8], textAlign: align, ...style }}>{children}</td>;
}

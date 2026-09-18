'use client';

import { useState, useMemo } from 'react';
import { C, Wallet, groupBy, groupSum } from '../../lib/ui/shared';
import { Card } from './ui';

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
      <h3 style={{ color: C.accent }}>Reconciliation</h3>
      <p style={{ color: C.dim, fontSize: 12, marginBottom: 16 }}>
        Cross-check: <b style={{ color: C.white }}>current balance</b> = sum(IN) − sum(OUT) per wallet/asset.
        Non-zero diff = investigate.
      </p>

      <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <Card style={{ borderLeft: `3px solid ${totalAbsDiff < 0.01 ? C.green : C.red}` }}>
          <div style={{ color: C.dim, fontSize: 11 }}>NET DIFF</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: totalAbsDiff < 0.01 ? C.green : C.red }}>
            ${totalAbsDiff.toFixed(2)}
          </div>
        </Card>
        <Card>
          <div style={{ color: C.dim, fontSize: 11 }}>TOTAL CURRENT</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: C.accent }}>${totals.current.toFixed(2)}</div>
        </Card>
        <Card>
          <div style={{ color: C.dim, fontSize: 11 }}>TOTAL EXPECTED</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: C.white }}>${totals.expected.toFixed(2)}</div>
        </Card>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search wallet or asset..."
          style={{
            background: C.card, color: C.white, border: `1px solid ${C.border}`,
            borderRadius: 8, padding: '8px 12px', fontSize: 13, outline: 'none', flex: 1, minWidth: 200,
          }}
        />
        <FilterBtn active={filter === 'diff'} onClick={() => setFilter('diff')} color={C.red}>
          Suspicious ({rows.filter(r => Math.abs(r.diff) >= 0.01).length})
        </FilterBtn>
        <FilterBtn active={filter === 'ok'} onClick={() => setFilter('ok')} color={C.green}>
          Balanced ({rows.filter(r => Math.abs(r.diff) < 0.01).length})
        </FilterBtn>
        <FilterBtn active={filter === 'all'} onClick={() => setFilter('all')} color={C.accent}>
          All ({rows.length})
        </FilterBtn>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <div style={{ color: C.dim, textAlign: 'center', padding: 20 }}>
            {filter === 'diff' ? 'No suspicious rows found ✓' : 'No rows found'}
          </div>
        </Card>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.border}` }}>
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
                <tr key={`${r.wallet}-${r.asset}-${i}`} style={{ borderBottom: `1px solid ${C.border}22` }}>
                  <Td>
                    <span style={{ fontSize: 16 }}>{w?.emoji || '💰'}</span>{' '}
                    <b style={{ color: w?.color || C.accent }}>{w?.alias || r.wallet}</b>
                    {w?.alias && w.alias !== r.wallet && (
                      <span style={{ color: C.dim, fontSize: 10, marginLeft: 6 }}>({r.wallet})</span>
                    )}
                  </Td>
                  <Td>
                    <span style={{ color: C.accent }}>{r.asset}</span>
                  </Td>
                  <Td align="right" style={{ color: C.white, fontFamily: 'monospace' }}>
                    {r.current.toFixed(6)}
                  </Td>
                  <Td align="right" style={{ color: C.green, fontFamily: 'monospace' }}>
                    {r.in_sum.toFixed(2)}
                  </Td>
                  <Td align="right" style={{ color: C.red, fontFamily: 'monospace' }}>
                    {r.out_sum.toFixed(2)}
                  </Td>
                  <Td align="right" style={{ color: C.dim, fontFamily: 'monospace' }}>
                    {r.expected.toFixed(2)}
                  </Td>
                  <Td
                    align="right"
                    style={{
                      fontFamily: 'monospace',
                      fontWeight: 700,
                      color: isBad ? C.red : C.green,
                      background: isBad ? `${C.red}11` : 'transparent',
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

function FilterBtn({ active, onClick, children, color }: { active: boolean; onClick: () => void; children: React.ReactNode; color: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? color : C.card,
        color: active ? '#04140f' : C.white,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: '8px 16px',
        cursor: 'pointer',
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {children}
    </button>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th style={{ padding: 8, textAlign: align, color: C.dim, fontSize: 11, fontWeight: 600, letterSpacing: 0.5 }}>
      {children}
    </th>
  );
}

function Td({ children, align = 'left', style }: { children: React.ReactNode; align?: 'left' | 'right'; style?: React.CSSProperties }) {
  return <td style={{ padding: 8, textAlign: align, ...style }}>{children}</td>;
}

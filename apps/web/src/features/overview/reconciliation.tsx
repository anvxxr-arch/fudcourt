'use client';

import { useState, useMemo } from 'react';
import { alpha, themeColor, fontSize, fontWeight, letterSpacing, radius, space } from '@/styles/tokens';
import { EmptyState } from '@/ui/feedback';
import { Wallet, groupBy, groupSum } from '@/lib/format';
import { Card } from '@/ui/primitives';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';

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
      <h3 style={{ color: themeColor.blue }}>Reconciliation</h3>
      <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12], marginBottom: space[16] }}>
        Cross-check: <b style={{ color: themeColor.labelPrimary }}>current balance</b> = sum(IN) − sum(OUT) per wallet/asset.
        Non-zero diff = investigate.
      </p>

      <div style={{ display: 'flex', gap: space[16], marginBottom: space[20], flexWrap: 'wrap' }}>
        <Card style={{ borderLeft: `3px solid ${totalAbsDiff < 0.01 ? themeColor.blue : themeColor.red}` }}>
          <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>NET DIFF</div>
          <div style={{ fontSize: fontSize[22], fontWeight: fontWeight.bold, color: totalAbsDiff < 0.01 ? themeColor.blue : themeColor.red }}>
            ${totalAbsDiff.toFixed(2)}
          </div>
        </Card>
        <Card>
          <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>TOTAL CURRENT</div>
          <div style={{ fontSize: fontSize[22], fontWeight: fontWeight.bold, color: themeColor.blue }}>${totals.current.toFixed(2)}</div>
        </Card>
        <Card>
          <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>TOTAL EXPECTED</div>
          <div style={{ fontSize: fontSize[22], fontWeight: fontWeight.bold, color: themeColor.labelPrimary }}>${totals.expected.toFixed(2)}</div>
        </Card>
      </div>

      <div style={{ display: 'flex', gap: space[8], marginBottom: space[16], flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search wallet or asset..."
          style={{
            background: themeColor.bgSecondary, color: themeColor.labelPrimary, border: `1px solid ${themeColor.separator}`,
            borderRadius: radius[8], padding: `${space[8]}px ${space[12]}px`, fontSize: fontSize[13], outline: 'none', flex: 1, minWidth: 200,
          }}
        />
        <FilterBtn active={filter === 'diff'} onClick={() => setFilter('diff')} tone={themeColor.red}>
          Suspicious ({rows.filter(r => Math.abs(r.diff) >= 0.01).length})
        </FilterBtn>
        <FilterBtn active={filter === 'ok'} onClick={() => setFilter('ok')} tone={themeColor.blue}>
          Balanced ({rows.filter(r => Math.abs(r.diff) < 0.01).length})
        </FilterBtn>
        <FilterBtn active={filter === 'all'} onClick={() => setFilter('all')} tone={themeColor.blue}>
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
        <div style={{ overflowX: 'auto' }}>
        <Table style={{ fontSize: fontSize[13] }}>
          <THead>
            <TR>
              <TH style={{ padding: space[8], fontSize: fontSize[11], letterSpacing: letterSpacing.sm }}>Wallet</TH>
              <TH style={{ padding: space[8], fontSize: fontSize[11], letterSpacing: letterSpacing.sm }}>Asset</TH>
              <TH align="right" style={{ padding: space[8], fontSize: fontSize[11], letterSpacing: letterSpacing.sm }}>Current</TH>
              <TH align="right" style={{ padding: space[8], fontSize: fontSize[11], letterSpacing: letterSpacing.sm }}>Σ IN</TH>
              <TH align="right" style={{ padding: space[8], fontSize: fontSize[11], letterSpacing: letterSpacing.sm }}>Σ OUT</TH>
              <TH align="right" style={{ padding: space[8], fontSize: fontSize[11], letterSpacing: letterSpacing.sm }}>Expected</TH>
              <TH align="right" style={{ padding: space[8], fontSize: fontSize[11], letterSpacing: letterSpacing.sm }}>Diff</TH>
            </TR>
          </THead>
          <TBody>
            {filtered.map((r, i) => {
              const isBad = Math.abs(r.diff) >= 0.01;
              const w = walletMap[r.wallet];
              return (
                <TR key={`${r.wallet}-${r.asset}-${i}`} style={{ borderBottom: `1px solid ${alpha(themeColor.separator, 0x22 / 255)}` }}>
                  <TD style={{ padding: space[8] }}>
                    <span style={{ fontSize: fontSize[17] }}>{w?.emoji || '💰'}</span>{' '}
                    <b style={{ color: w?.color || themeColor.blue }}>{w?.alias || r.wallet}</b>
                    {w?.alias && w.alias !== r.wallet && (
                      <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginLeft: space[8] }}>({r.wallet})</span>
                    )}
                  </TD>
                  <TD style={{ padding: space[8] }}>
                    <span style={{ color: themeColor.blue }}>{r.asset}</span>
                  </TD>
                  <TD align="right" mono style={{ padding: space[8], color: themeColor.labelPrimary }}>
                    {r.current.toFixed(6)}
                  </TD>
                  <TD align="right" mono style={{ padding: space[8], color: themeColor.blue }}>
                    {r.in_sum.toFixed(2)}
                  </TD>
                  <TD align="right" mono style={{ padding: space[8], color: themeColor.red }}>
                    {r.out_sum.toFixed(2)}
                  </TD>
                  <TD align="right" mono style={{ padding: space[8], color: themeColor.labelTertiary }}>
                    {r.expected.toFixed(2)}
                  </TD>
                  <TD
                    align="right"
                    mono
                    style={{
                      padding: space[8],
                      fontWeight: fontWeight.bold,
                      color: isBad ? themeColor.red : themeColor.blue,
                      background: isBad ? alpha(themeColor.red, 17 / 255) : 'transparent',
                    }}
                  >
                    {isBad ? '⚠️' : ''} {r.diff.toFixed(4)}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
        </div>
      )}
    </div>
  );
}

function FilterBtn({ active, onClick, children, tone }: { active: boolean; onClick: () => void; children: React.ReactNode; tone: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? tone : themeColor.bgSecondary,
        color: active ? themeColor.labelOnAccent : themeColor.labelPrimary,
        border: `1px solid ${themeColor.separator}`,
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

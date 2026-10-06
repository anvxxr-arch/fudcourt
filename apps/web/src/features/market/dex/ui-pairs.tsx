'use client';
import { alpha, themeColor, fontSize, fontWeight, space } from '@/styles/tokens';
import { Table, TBody, THead } from '@/ui/table';
import type { DexPair } from './client';
import { num, money, pct, age, win } from './ui-format';
import { memo } from 'react';
// Props are the `pair` object and its index. `visible` is rebuilt each render by
// the parent's filter, but `rows.filter()` preserves the object identity of every
// element, so each `pair` reference is the one held in `rows` state. `i` is a
// number. Neither prop is created per render, so memo holds across re-renders
// that only touch the toolbar/filter state.
const PairRow = memo(function PairRow({ pair, i }: { pair: DexPair; i: number }) {
  const t24 = win(pair.txns, 'h24');
  const ch24 = win(pair.priceChange, 'h24');
  return (
    <tr key={pair.pairAddress + i} style={{ borderBottom: `1px solid ${alpha(themeColor.labelOnAccent, 0.04)}` }}>
      <td style={{ padding: '5px 6px', whiteSpace: 'nowrap' }}>
        <span style={{ color: themeColor.blue, textDecoration: 'none', fontWeight: fontWeight.bold }}>
          {pair.baseToken?.symbol || '—'}
        </span>
        <span style={{ color: themeColor.labelTertiary }}>/{pair.quoteToken?.symbol || '—'}</span>
      </td>
      <td style={{ padding: '5px 6px', color: themeColor.labelTertiary }}>{pair.dexId || '—'}</td>
      <td style={{ padding: '5px 6px', color: themeColor.labelPrimary }}>{num(pair.priceUsd, { prefix: '$' })}</td>
      <td style={{ padding: '5px 6px', color: ch24 == null ? themeColor.labelTertiary : ch24 >= 0 ? themeColor.green : themeColor.red }}>{pct(ch24)}</td>
      <td style={{ padding: '5px 6px', color: themeColor.labelPrimary }}>{money(win(pair.volume, 'h24') ?? null)}</td>
      <td style={{ padding: '5px 6px', color: themeColor.labelPrimary }}>{money(pair.liquidity?.usd ?? null)}</td>
      <td style={{ padding: '5px 6px', color: themeColor.labelTertiary, whiteSpace: 'nowrap' }}>
        {t24?.buys == null || t24?.sells == null ? '—' : `${t24.buys}/${t24.sells}`}
      </td>
      <td style={{ padding: '5px 6px', color: themeColor.labelPrimary }}>{money(pair.marketCap ?? null)}</td>
      <td style={{ padding: '5px 6px', color: themeColor.labelTertiary }}>{age(pair.pairCreatedAt)}</td>
      <td style={{ padding: '5px 6px', color: themeColor.labelTertiary }}>
        {pair.labels && pair.labels.length ? pair.labels.join(',') : '—'}
      </td>
    </tr>
  );
});
export function PairsTable({ rows, visible }: { rows: DexPair[]; visible: DexPair[] }) {
  return (
    <>
      {rows.length === 0 && <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>no pairs returned for this query.</p>}
      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <Table style={{ fontSize: fontSize[11] }}>
            <THead>
              <tr style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], textAlign: 'left' }}>
                {['pair', 'dex', 'price', '24h', 'vol 24h', 'liq', 'buys/sells 24h', 'mcap', 'age', 'labels'].map((h) => (
                  <th key={h} style={{ padding: `${space[4]}px ${space[8]}px`, borderBottom: `1px solid ${themeColor.separator}`, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </THead>
            <TBody>
              {visible.slice(0, 100).map((p, i) => (
                <PairRow key={p.pairAddress + i} pair={p} i={i} />
              ))}
            </TBody>
          </Table>
          {visible.length > 100 && (
            <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginTop: space[8] }}>showing first 100 of {visible.length} — narrow the filter</p>
          )}
        </div>
      )}
    </>
  );
}

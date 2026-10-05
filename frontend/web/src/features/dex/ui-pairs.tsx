'use client';
import { alpha, color, fontSize, fontWeight, space } from '@/styles/tokens';
import { Table, TBody, THead } from '@/ui/table';
import type { DexPair } from './client';
import { num, money, pct, age, win } from './ui-format';

export function PairsTable({ rows, visible }: { rows: DexPair[]; visible: DexPair[] }) {
  return (
    <>
      {rows.length === 0 && <p style={{ color: color.labelTertiary, fontSize: fontSize[12] }}>no pairs returned for this query.</p>}
      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <Table style={{ fontSize: fontSize[11] }}>
            <THead>
              <tr style={{ color: color.labelTertiary, fontSize: fontSize[11], textAlign: 'left' }}>
                {['pair', 'dex', 'price', '24h', 'vol 24h', 'liq', 'buys/sells 24h', 'mcap', 'age', 'labels'].map((h) => (
                  <th key={h} style={{ padding: `${space[4]}px ${space[8]}px`, borderBottom: `1px solid ${color.separator}`, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </THead>
            <TBody>
              {visible.slice(0, 100).map((p, i) => {
                const t24 = win(p.txns, 'h24');
                const ch24 = win(p.priceChange, 'h24');
                return (
                  <tr key={p.pairAddress + i} style={{ borderBottom: `1px solid ${alpha(color.labelOnAccent, 0.04)}` }}>
                    <td style={{ padding: '5px 6px', whiteSpace: 'nowrap' }}>
                      <span style={{ color: color.blue, textDecoration: 'none', fontWeight: fontWeight.bold }}>
                        {p.baseToken?.symbol || '—'}
                      </span>
                      <span style={{ color: color.labelTertiary }}>/{p.quoteToken?.symbol || '—'}</span>
                    </td>
                    <td style={{ padding: '5px 6px', color: color.labelTertiary }}>{p.dexId || '—'}</td>
                    <td style={{ padding: '5px 6px', color: color.labelPrimary }}>{num(p.priceUsd, { prefix: '$' })}</td>
                    <td style={{ padding: '5px 6px', color: ch24 == null ? color.labelTertiary : ch24 >= 0 ? color.green : color.red }}>{pct(ch24)}</td>
                    <td style={{ padding: '5px 6px', color: color.labelPrimary }}>{money(win(p.volume, 'h24') ?? null)}</td>
                    <td style={{ padding: '5px 6px', color: color.labelPrimary }}>{money(p.liquidity?.usd ?? null)}</td>
                    <td style={{ padding: '5px 6px', color: color.labelTertiary, whiteSpace: 'nowrap' }}>
                      {t24?.buys == null || t24?.sells == null ? '—' : `${t24.buys}/${t24.sells}`}
                    </td>
                    <td style={{ padding: '5px 6px', color: color.labelPrimary }}>{money(p.marketCap ?? null)}</td>
                    <td style={{ padding: '5px 6px', color: color.labelTertiary }}>{age(p.pairCreatedAt)}</td>
                    <td style={{ padding: '5px 6px', color: color.labelTertiary }}>
                      {p.labels && p.labels.length ? p.labels.join(',') : '—'}
                    </td>
                  </tr>
                );
              })}
            </TBody>
          </Table>
          {visible.length > 100 && (
            <p style={{ color: color.labelTertiary, fontSize: fontSize[11], marginTop: space[8] }}>showing first 100 of {visible.length} — narrow the filter</p>
          )}
        </div>
      )}
    </>
  );
}

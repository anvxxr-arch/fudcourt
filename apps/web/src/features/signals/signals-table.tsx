'use client';
import { alpha, themeColor, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { chainColor } from '@/lib/format';
import { Table, TBody, THead } from '@/ui/table';
import { imgSrc } from '@/lib/img';
import { DECISION_COLOR, MERGED, ago, n2, shortAddr, usd } from './model';
import type { ChainKey, Payload, SignalRow } from './model';
import { memo } from 'react';
// Props are the `row` object (stable: the parent's `rows` array is useMemo'd on
// [data, q, onlyDecision], so each row identity survives unrelated re-renders)
// and the `chain` string. Neither is created per render, so memo actually holds.
const SignalRow = memo(function SignalRow({ row, chain }: { row: SignalRow; chain: ChainKey }) {
  return (
    <tr
      style={{ borderBottom: `1px solid ${alpha(themeColor.separator, 0.4)}` }}
      onMouseOver={e => { e.currentTarget.style.background = alpha(themeColor.blue, 0.05); }}
      onMouseOut={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      <td style={{ padding: `${space[8]}px ${space[8]}px`, color: themeColor.labelTertiary, whiteSpace: 'nowrap' }}>{ago(row.ts)}</td>
      {MERGED.includes(chain) && (
        <td style={{ padding: `${space[8]}px ${space[8]}px`, color: row.chain === 'robinhood' ? chainColor('robinhood') : chainColor('solana'), whiteSpace: 'nowrap' }}>
          {row.chain === 'robinhood' ? '🪶 rh' : row.chain === 'solana' ? '◎ sol' : row.chain || '—'}
        </td>
      )}
      <td style={{ padding: `${space[8]}px ${space[8]}px`, whiteSpace: 'nowrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: space[8] }}>
          {row.image
            ? <img src={imgSrc(row.image)} alt="" width={16} height={16} loading="lazy" decoding="async" style={{ width: space[16], height: space[16], borderRadius: radius.circle }} />
            : <span style={{ width: space[16], height: space[16], borderRadius: radius.circle, background: themeColor.separator, display: 'inline-block' }} />}
          <span style={{ color: themeColor.labelPrimary, fontWeight: fontWeight.bold }}>{row.symbol || '?'}</span>
          <span style={{ color: themeColor.labelTertiary }}>{shortAddr(row.mint)}</span>
        </span>
      </td>
      <td style={{ padding: `${space[8]}px ${space[8]}px`, whiteSpace: 'nowrap' }}>
        {row.decision
          ? <span style={{ color: DECISION_COLOR[row.decision] || themeColor.labelTertiary }}>{row.decision}</span>
          : <span style={{ color: themeColor.labelTertiary }}>—</span>}
      </td>
      <td style={{ padding: `${space[8]}px ${space[8]}px`, color: themeColor.blue }}>{typeof row.score === 'number' ? row.score.toFixed(1) : '—'}</td>
      <td style={{ padding: `${space[8]}px ${space[8]}px`, color: themeColor.labelPrimary }}>{usd(row.mcap)}</td>
      <td style={{ padding: `${space[8]}px ${space[8]}px`, color: themeColor.labelPrimary }}>{typeof row.liq === 'number' ? usd(row.liq) : '—'}</td>
      <td style={{ padding: `${space[8]}px ${space[8]}px`, color: themeColor.labelPrimary }}>{typeof row.price === 'number' ? `$${row.price.toPrecision(4)}` : '—'}</td>
      <td style={{ padding: `${space[8]}px ${space[8]}px`, color: themeColor.labelPrimary }}>{typeof row.holdersCount === 'number' ? n2(row.holdersCount) : '—'}</td>
      <td style={{ padding: `${space[8]}px ${space[8]}px`, color: themeColor.labelPrimary }}>{typeof row.topHolderPct === 'number' ? `${row.topHolderPct.toFixed(1)}%` : '—'}</td>
      <td style={{ padding: `${space[8]}px ${space[8]}px`, color: themeColor.labelTertiary }}>
        {row.sightings ? `${row.sightings.n}×/${row.sightings.spanH}h` : typeof row.persistCount === 'number' ? `×${row.persistCount}` : '—'}
      </td>
      <td style={{ padding: `${space[8]}px ${space[8]}px`, color: themeColor.labelTertiary }}>{row.source || '—'}</td>
      <td style={{ padding: `${space[8]}px ${space[8]}px`, color: themeColor.labelTertiary }}>{row.kind}</td>
    </tr>
  );
});
export function SignalsTable({ rows, chain, loading, data, error }: {
  rows: SignalRow[];
  chain: ChainKey;
  loading: boolean;
  data: Payload | null;
  error: string;
}) {
  if (loading || !data) return null;
  return (
    <div style={{ overflowX: 'auto' }}>
      <Table style={{ fontSize: fontSize[11] }}>
        <THead>
          <tr style={{ color: themeColor.labelTertiary, textAlign: 'left', borderBottom: `1px solid ${themeColor.separator}` }}>
            {['age', ...(MERGED.includes(chain) ? ['chain'] : []), 'token', 'decision', 'score', 'mcap', 'liq', 'price', 'holders', 'top%', 'sight', 'src', 'kind'].map(h => (
              <th key={h} style={{ padding: `${space[8]}px ${space[8]}px`, fontWeight: fontWeight.medium, whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </THead>
        <TBody>
          {rows.slice(0, 300).map(r => (
            <SignalRow key={`${r.id}-${r.mint}`} row={r} chain={chain} />
          ))}
        </TBody>
      </Table>
      {rows.length === 0 && !loading && (
        <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12], marginTop: space[8] }}>
          {error ? 'upstream failed — row list withheld, not empty' : 'no rows match filter'}
        </p>
      )}
      {rows.length > 300 && (
        <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginTop: space[8] }}>
          showing first 300 of {n2(rows.length)} — narrow the filter to see more
        </p>
      )}
    </div>
  );
}

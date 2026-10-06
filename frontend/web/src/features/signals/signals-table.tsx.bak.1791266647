'use client';
import { alpha, color, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { chainColor } from '@/lib/format';
import { Table, TBody, THead } from '@/ui/table';
import { imgSrc } from '@/lib/img';
import { DECISION_COLOR, MERGED, ago, n2, shortAddr, usd } from './model';
import type { ChainKey, Payload, SignalRow } from './model';

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
          <tr style={{ color: color.labelTertiary, textAlign: 'left', borderBottom: `1px solid ${color.separator}` }}>
            {['age', ...(MERGED.includes(chain) ? ['chain'] : []), 'token', 'decision', 'score', 'mcap', 'liq', 'price', 'holders', 'top%', 'sight', 'src', 'kind'].map(h => (
              <th key={h} style={{ padding: `${space[8]}px ${space[8]}px`, fontWeight: fontWeight.medium, whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </THead>
        <TBody>
          {rows.slice(0, 300).map(r => (
            <tr
              key={`${r.id}-${r.mint}`}
              style={{ borderBottom: `1px solid ${alpha(color.separator, 0.4)}` }}
              onMouseOver={e => { e.currentTarget.style.background = alpha(color.blue, 0.05); }}
              onMouseOut={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <td style={{ padding: `${space[8]}px ${space[8]}px`, color: color.labelTertiary, whiteSpace: 'nowrap' }}>{ago(r.ts)}</td>
              {MERGED.includes(chain) && (
                <td style={{ padding: `${space[8]}px ${space[8]}px`, color: r.chain === 'robinhood' ? chainColor('robinhood') : chainColor('solana'), whiteSpace: 'nowrap' }}>
                  {r.chain === 'robinhood' ? '🪶 rh' : r.chain === 'solana' ? '◎ sol' : r.chain || '—'}
                </td>
              )}
              <td style={{ padding: `${space[8]}px ${space[8]}px`, whiteSpace: 'nowrap' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: space[8] }}>
                  {r.image
                    ? <img src={imgSrc(r.image)} alt="" style={{ width: space[16], height: space[16], borderRadius: radius.circle }} />
                    : <span style={{ width: space[16], height: space[16], borderRadius: radius.circle, background: color.separator, display: 'inline-block' }} />}
                  <span style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>{r.symbol || '?'}</span>
                  <span style={{ color: color.labelTertiary }}>{shortAddr(r.mint)}</span>
                </span>
              </td>
              <td style={{ padding: `${space[8]}px ${space[8]}px`, whiteSpace: 'nowrap' }}>
                {r.decision
                  ? <span style={{ color: DECISION_COLOR[r.decision] || color.labelTertiary }}>{r.decision}</span>
                  : <span style={{ color: color.labelTertiary }}>—</span>}
              </td>
              <td style={{ padding: `${space[8]}px ${space[8]}px`, color: color.blue }}>{typeof r.score === 'number' ? r.score.toFixed(1) : '—'}</td>
              <td style={{ padding: `${space[8]}px ${space[8]}px`, color: color.labelPrimary }}>{usd(r.mcap)}</td>
              <td style={{ padding: `${space[8]}px ${space[8]}px`, color: color.labelPrimary }}>{typeof r.liq === 'number' ? usd(r.liq) : '—'}</td>
              <td style={{ padding: `${space[8]}px ${space[8]}px`, color: color.labelPrimary }}>{typeof r.price === 'number' ? `$${r.price.toPrecision(4)}` : '—'}</td>
              <td style={{ padding: `${space[8]}px ${space[8]}px`, color: color.labelPrimary }}>{typeof r.holdersCount === 'number' ? n2(r.holdersCount) : '—'}</td>
              <td style={{ padding: `${space[8]}px ${space[8]}px`, color: color.labelPrimary }}>{typeof r.topHolderPct === 'number' ? `${r.topHolderPct.toFixed(1)}%` : '—'}</td>
              <td style={{ padding: `${space[8]}px ${space[8]}px`, color: color.labelTertiary }}>
                {r.sightings ? `${r.sightings.n}×/${r.sightings.spanH}h` : typeof r.persistCount === 'number' ? `×${r.persistCount}` : '—'}
              </td>
              <td style={{ padding: `${space[8]}px ${space[8]}px`, color: color.labelTertiary }}>{r.source || '—'}</td>
              <td style={{ padding: `${space[8]}px ${space[8]}px`, color: color.labelTertiary }}>{r.kind}</td>
            </tr>
          ))}
        </TBody>
      </Table>
      {rows.length === 0 && !loading && (
        <p style={{ color: color.labelTertiary, fontSize: fontSize[12], marginTop: space[8] }}>
          {error ? 'upstream failed — row list withheld, not empty' : 'no rows match filter'}
        </p>
      )}
      {rows.length > 300 && (
        <p style={{ color: color.labelTertiary, fontSize: fontSize[11], marginTop: space[8] }}>
          showing first 300 of {n2(rows.length)} — narrow the filter to see more
        </p>
      )}
    </div>
  );
}

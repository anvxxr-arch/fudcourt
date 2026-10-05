'use client';
import { color, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { Table, TBody, THead } from '@/ui/table';
import type { DexProfile } from './client';
import { imgSrc } from '@/lib/img';
import { money, age } from './ui-format';

export type OrderData = { orders: Record<string, unknown>[]; boosts: Record<string, unknown>[] };

export function ProfilesGrid({ profiles }: { profiles: DexProfile[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: space[8] }}>
      {profiles.length === 0 && <p style={{ color: color.labelTertiary, fontSize: fontSize[12] }}>upstream returned no profiles.</p>}
      {profiles.map((p, i) => (
        <div key={p.address + i} style={{ background: color.bgSecondary, border: `1px solid ${color.separator}`, borderRadius: radius[8], overflow: 'hidden' }}>
          {p.header && <div style={{ height: 54, backgroundImage: `url(${imgSrc(p.header)})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />}
          <div style={{ padding: space[8] }}>
            <div style={{ color: color.labelPrimary, fontSize: fontSize[12], fontWeight: fontWeight.bold }}>
              {p.symbol || p.address.slice(0, 6) + '…'}
              <span style={{ color: color.labelTertiary, fontSize: fontSize[11], marginLeft: space[8] }}>{p.chain}</span>
            </div>
            <div style={{ color: color.labelTertiary, fontSize: fontSize[11], marginTop: 2, wordBreak: 'break-all' }}>{p.address}</div>
            {(p.amount != null || p.totalAmount != null) && (
              <div style={{ color: color.blue, fontSize: fontSize[11], marginTop: space[4] }}>
                boost {money(p.amount)}{p.totalAmount != null && ` · total ${money(p.totalAmount)}`}
              </div>
            )}
            {p.links.length > 0 && (
              <div style={{ display: 'flex', gap: space[4], marginTop: 5, flexWrap: 'wrap' }}>
                {p.links.slice(0, 3).map((l, j) => (
                  <span key={j}
                    style={{ color: color.blue, fontSize: fontSize[11], textDecoration: 'none' }}>
                    {l.label || l.type || 'link'}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function OrdersTables({ orderData }: { orderData: OrderData }) {
  return (
    <div>
      {orderData.orders.length === 0 && orderData.boosts.length === 0 && (
        <p style={{ color: color.labelTertiary, fontSize: fontSize[12] }}>
          upstream returned no orders and no boosts for this token — genuinely none, nothing faked.
        </p>
      )}
      {orderData.orders.length > 0 && (
        <Table style={{ fontSize: fontSize[11], marginBottom: space[8] }}>
          <THead>
            <tr style={{ color: color.labelTertiary, textAlign: 'left' }}>
              <th style={{ padding: `${space[4]}px ${space[8]}px` }}>order</th>
              <th style={{ padding: `${space[4]}px ${space[8]}px` }}>status</th>
              <th style={{ padding: `${space[4]}px ${space[8]}px` }}>paid</th>
            </tr>
          </THead>
          <TBody>
            {orderData.orders.map((o, i) => (
              <tr key={String(o.paymentTimestamp ?? i)} style={{ borderTop: `1px solid ${color.separator}` }}>
                <td style={{ padding: '5px 8px', color: color.labelPrimary }}>{String(o.type ?? '—')}</td>
                <td style={{ padding: '5px 8px', color: o.status === 'approved' ? color.blue : color.orange }}>{String(o.status ?? '—')}</td>
                <td style={{ padding: '5px 8px', color: color.labelTertiary }}>{age(typeof o.paymentTimestamp === 'number' ? o.paymentTimestamp : null)}</td>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
      {orderData.boosts.length > 0 && (
        <Table style={{ fontSize: fontSize[11] }}>
          <THead>
            <tr style={{ color: color.labelTertiary, textAlign: 'left' }}>
              <th style={{ padding: `${space[4]}px ${space[8]}px` }}>boost payment</th>
              <th style={{ padding: `${space[4]}px ${space[8]}px` }}>amount</th>
              <th style={{ padding: `${space[4]}px ${space[8]}px` }}>paid</th>
            </tr>
          </THead>
          <TBody>
            {orderData.boosts.map((b, i) => (
              <tr key={String(b.id ?? i)} style={{ borderTop: `1px solid ${color.separator}` }}>
                <td style={{ padding: '5px 8px', color: color.labelPrimary }}>{String(b.tokenAddress ?? '—').slice(0, 10)}…</td>
                <td style={{ padding: '5px 8px', color: color.labelPrimary }}>{money(typeof b.amount === 'number' ? b.amount : null)}</td>
                <td style={{ padding: '5px 8px', color: color.labelTertiary }}>{age(typeof b.paymentTimestamp === 'number' ? b.paymentTimestamp : null)}</td>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}

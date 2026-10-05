'use client';

/**
 * The liquidity board (plan Phase 9) — `/economy/liquidity`.
 *
 * Each component states its direction: a rising reverse-repo balance or a rising
 * dollar TIGHTENS, so the tint and the index vote both read `direction`, not the
 * raw sign of the change. A board that treated every rise as expansion would be
 * confidently wrong in exactly the regime it exists to detect.
 */
import { useEffect, useState } from 'react';
import { color, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { fetchLiquidity, formatCompact, formatDate, formatValue, type LiquidityEnvelope } from '@/features/economy/model';
import { Card, DataTable, ECONOMY_NAV, ErrorState, Loading, PageHeader } from '@/features/economy/ui/parts';

export default function LiquidityBoard() {
  const [data, setData] = useState<LiquidityEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchLiquidity(ac.signal)
      .then((d) => !ac.signal.aborted && setData(d))
      .catch((e) => !ac.signal.aborted && setError(e instanceof Error ? e.message : String(e)));
    return () => ac.abort();
  }, []);

  if (error) {
    return (
      <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
        <ErrorState title="Could not load the liquidity board" detail={error} />
      </main>
    );
  }
  if (!data) return <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}><Loading what="liquidity" /></main>;

  const idx = data.index;
  const trendColor = idx?.trend === 'Expanding' ? color.green : idx?.trend === 'Contracting' ? color.red : color.orange;

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
      <PageHeader
        title="Global Liquidity"
        description="Balance-sheet size, reserves, reverse repo, the dollar and financial conditions — the plumbing behind risk assets. Each component states which way a rising value pushes liquidity."
        nav={ECONOMY_NAV}
      />

      {idx && (
        <Card title="Global Liquidity Index" subtitle="derived position in this basket — not an official gauge">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: space[8] }}>
            <span style={{ fontSize: fontSize[34], fontWeight: fontWeight.bold, color: color.labelPrimary }}>{idx.value}</span>
            <span style={{ fontSize: fontSize[17], color: trendColor, fontWeight: fontWeight.semibold }}>{idx.trend}</span>
          </div>
          <div style={{ height: 8, background: color.separator, borderRadius: radius[8], marginTop: space[8] }}>
            <div style={{ width: `${idx.value}%`, height: '100%', background: trendColor, borderRadius: radius[8] }} />
          </div>
          <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: color.labelTertiary }}>
            Share of {idx.components} live components moving in their loosening direction. 50 = balanced; above 58 expanding, below 42 contracting.
          </p>
        </Card>
      )}

      <div style={{ marginTop: space[12] }}>
        <Card title="Components" subtitle="level, 30-day change, and the direction that counts as loosening">
          <DataTable
            head={['Component', 'Level', 'Date', '30d change', 'Loosens when']}
            rows={data.components.map((c) => {
              const loosening = c.change === null ? null : Math.sign(c.change * c.direction);
              const changeColor = loosening === null ? color.labelTertiary : loosening > 0 ? color.green : loosening < 0 ? color.red : color.labelTertiary;
              return {
                cells: [
                  <span key="l" title={c.note}>{c.label}</span>,
                  <span key="v">{c.value === null ? '—' : `${formatCompact(c.value, 2)} ${c.unit}`}</span>,
                  <span key="d" style={{ color: color.labelTertiary }}>{formatDate(c.date)}</span>,
                  <span key="c" style={{ color: changeColor }}>{c.change === null ? '—' : `${c.change > 0 ? '+' : ''}${formatValue(c.change, 2)}`}</span>,
                  <span key="dir" style={{ color: color.labelTertiary }}>{c.direction > 0 ? 'rising' : 'falling'}</span>,
                ],
              };
            })}
          />
        </Card>
      </div>

      {data.failed.length > 0 && (
        <div style={{ marginTop: space[12] }}>
          <ErrorState title={`${data.failed.length} component(s) unavailable`} detail={data.failed.map((f) => `${f.symbol}: ${f.reason}`).join(' · ')} />
        </div>
      )}

      <p style={{ marginTop: space[16], fontSize: fontSize[11], color: color.labelTertiary }}>{data.derived}</p>
    </main>
  );
}

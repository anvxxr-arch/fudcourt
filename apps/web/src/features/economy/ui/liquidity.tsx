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
import { useT } from '@/lib/i18n/t';
import { themeColor, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { fetchLiquidity, formatCompact, formatDate, type LiquidityEnvelope } from '@/features/economy/model';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { ECONOMY_NAV } from '@/features/economy/nav';
import { ErrorState } from '@/ui/feedback';
import { Loading } from '@/ui/feedback';
import { PageHeader } from '@/ui/page-header';
import { Meter } from '@/ui/meter';

export default function LiquidityBoard() {
  const t = useT();
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
        <ErrorState title={t('economy.liquidityLoadError')} detail={error} />
      </main>
    );
  }
  if (!data) return <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}><Loading what={t('economy.loadingLiquidity')} /></main>;

  const idx = data.index;
  const trendColor = idx?.trend === 'Expanding' ? themeColor.green : idx?.trend === 'Contracting' ? themeColor.red : themeColor.orange;

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
      <PageHeader
        title={t('economy.liquidityTitle')}
        description={t('economy.liquidityDesc')}
        nav={ECONOMY_NAV}
      />

      {idx && (
        <Card title={t('economy.liquidityIndex')} subtitle={t('economy.liquidityIndexSub')}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: space[8] }}>
            <span style={{ fontSize: fontSize[34], fontWeight: fontWeight.bold, color: themeColor.labelPrimary }}>{idx.value}</span>
            <span style={{ fontSize: fontSize[17], color: trendColor, fontWeight: fontWeight.semibold }}>{idx.trend}</span>
          </div>
          <div style={{ height: 8, background: themeColor.separator, borderRadius: radius[8], marginTop: space[8] }}>
            <div style={{ width: `${idx.value}%`, height: '100%', background: trendColor, borderRadius: radius[8] }} />
          </div>
          <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary }}>
            {t('economy.liquidityIndexNote', { n: idx.components })}
          </p>
        </Card>
      )}

      <Card title={t('economy.componentVote')} subtitle={t('economy.componentVoteSub')}>
        <Meter
          parts={(() => {
            const loosening = data.components.filter((c) => c.change !== null && Math.sign(c.change * c.direction) > 0).length;
            const tightening = data.components.filter((c) => c.change !== null && Math.sign(c.change * c.direction) < 0).length;
            const flat = data.components.filter((c) => c.change !== null && Math.sign(c.change * c.direction) === 0).length;
            const unreadable = data.components.filter((c) => c.change === null).length;
            return [
              { label: t('economy.meterLoosening'), value: loosening, color: themeColor.green },
              { label: t('economy.meterTightening'), value: tightening, color: themeColor.red },
              { label: t('economy.meterFlat'), value: flat, color: themeColor.labelTertiary },
              { label: t('economy.meterUnreadable'), value: unreadable, color: themeColor.separator },
            ];
          })()}
        />
      </Card>
      <div style={{ marginTop: space[12] }}>
        <Card title={t('economy.componentsTitle')} subtitle={t('economy.componentsSub')}>
          <DataTable
            head={[t('economy.hComponent'), t('economy.hLevel'), t('col.date'), t('economy.hChange30d'), t('economy.hLoosensWhen')]}
            rows={data.components.map((c) => {
              const loosening = c.change === null ? null : Math.sign(c.change * c.direction);
              const changeColor = loosening === null ? themeColor.labelTertiary : loosening > 0 ? themeColor.green : loosening < 0 ? themeColor.red : themeColor.labelTertiary;
              return {
                cells: [
                  <span key="l" title={c.note}>{c.label}</span>,
                  <span key="v">{c.value === null ? '—' : `${formatCompact(c.value, 2)} ${c.unit}`}</span>,
                  <span key="d" style={{ color: themeColor.labelTertiary }}>{formatDate(c.date)}</span>,
                  <span key="c" style={{ color: changeColor }}>{c.change === null ? '—' : `${c.change > 0 ? '+' : ''}${formatCompact(c.change, 2)} ${c.unit}`}</span>,
                  <span key="dir" style={{ color: themeColor.labelTertiary }}>{c.direction > 0 ? t('economy.rising') : t('economy.falling')}</span>,
                ],
              };
            })}
          />
        </Card>
      </div>

      {data.failed.length > 0 && (
        <div style={{ marginTop: space[12] }}>
          <ErrorState title={t('economy.componentsUnavailable', { n: data.failed.length })} detail={data.failed.map((f) => `${f.symbol}: ${f.reason}`).join(' · ')} />
        </div>
      )}

      <p style={{ marginTop: space[16], fontSize: fontSize[11], color: themeColor.labelTertiary }}>{data.derived}</p>
    </main>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/lib/i18n/t';
import { themeColor, fontSize, space, fontWeight, radius } from '@/styles/tokens';
import { fetchCentralBanks, formatDate, formatValue, NO_VALUE, type CentralBanksEnvelope, fetchCentralBank, type CentralBankEnvelope } from '@/features/economy/model';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { ErrorState, Loading } from '@/ui/feedback';
import { PageHeader } from '@/ui/page-header';
import { Value } from '@/ui/value';
import { ECONOMY_NAV } from '@/features/economy/nav';

/**
 * Every tracked central bank (plan Phase 7) — `/economy/central-bank`.
 *
 * One BIS call fills the whole board. A bank BIS carries no observation for keeps
 * `rate: null` and is named in the failures — the row still renders, because "we
 * track this bank but BIS is quiet" is a different fact from "this bank does not
 * exist".
 */

export default function CentralBankIndex() {
  const t = useT();
  const [data, setData] = useState<CentralBanksEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchCentralBanks(ac.signal)
      .then((d) => !ac.signal.aborted && setData(d))
      .catch((e) => !ac.signal.aborted && setError(e instanceof Error ? e.message : String(e)));
    return () => ac.abort();
  }, []);

  const byRegion = useMemo(() => {
    const m = new Map<string, CentralBanksEnvelope['banks'][number][]>();
    for (const b of data?.banks ?? []) {
      const list = m.get(b.region) ?? [];
      list.push(b);
      m.set(b.region, list);
    }
    return m;
  }, [data]);

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
      <PageHeader
        title={t('economy.centralBanksTitle')}
        description={t('economy.centralBanksDesc')}
        nav={ECONOMY_NAV}
      />

      {error && <ErrorState title={t('economy.centralBanksError')} detail={error} />}
      {!data && !error && <Loading what={t('economy.loadingBanks')} />}

      {data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[12] }}>
          {[...byRegion.entries()].map(([region, banks]) => (
            <Card key={region} title={region} subtitle={t('economy.authoritiesCount', { n: banks.length })}>
              <DataTable
                head={[t('economy.hBank'), t('economy.hPolicyRate'), t('col.asOf'), t('economy.hArea')]}
                rows={banks.map((b) => ({
                  href: `/economy/central-bank/${b.slug}`,
                  cells: [
                    b.name,
                    <span key="r" style={{ color: b.rate === null ? themeColor.labelTertiary : themeColor.labelPrimary }}>{b.rate === null ? '—' : `${formatValue(b.rate, 2)}%`}</span>,
                    <span key="d" style={{ color: themeColor.labelTertiary }}>{formatDate(b.date)}</span>,
                    <span key="a" style={{ color: themeColor.labelTertiary }}>{b.area}</span>,
                  ],
                }))}
              />
            </Card>
          ))}
          {data.failed.length > 0 && (
            <ErrorState title={t('economy.areasUnresolved', { n: data.failed.length })} detail={data.failed.map((f) => `${f.symbol}: ${f.reason}`).join(' · ')} />
          )}
          <p style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>{data.derived}</p>
        </div>
      )}
    </main>
  );
}

/**
 * One central bank (plan Phase 7) — `/economy/central-bank/[bank]`.
 *
 * The rate history is the daily BIS series; the DECISION list is derived from it
 * (each level change with the date it took effect). Nothing here claims a meeting
 * calendar or a statement, because BIS publishes neither — the page says so.
 */

const W = 720;
const H = 180;

function Chart({ points }: { points: { date: string; value: number | null }[] }) {
  const t = useT();
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null && Number.isFinite(v));
  if (vals.length < 2) return <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>{t('economy.notEnoughObs')}</p>;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = W / Math.max(1, points.length - 1);
  const path = points
    .map((p, i) => (p.value === null ? null : `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(H - ((p.value - min) / span) * H).toFixed(1)}`))
    .filter((s): s is string => s !== null)
    .join(' ');
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={W} height={H + 22} role="img" aria-label={t('economy.policyRateHistoryLabel')}>
        <path d={path} fill="none" stroke={themeColor.blue} strokeWidth={1.6} />
        <text x={0} y={H + 16} fill={themeColor.labelTertiary} fontSize={10}>{points[0]?.date}</text>
        <text x={W} y={H + 16} fill={themeColor.labelTertiary} fontSize={10} textAnchor="end">{points[points.length - 1]?.date}</text>
        <text x={0} y={10} fill={themeColor.labelTertiary} fontSize={10}>{formatValue(max, 2)}%</text>
        <text x={0} y={H} fill={themeColor.labelTertiary} fontSize={10}>{formatValue(min, 2)}%</text>
      </svg>
    </div>
  );
}

export function CentralBankDetail({ bank }: { bank: string }) {
  const t = useT();
  const [data, setData] = useState<CentralBankEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchCentralBank(bank, ac.signal)
      .then((d) => !ac.signal.aborted && setData(d))
      .catch((e) => !ac.signal.aborted && setError(e instanceof Error ? e.message : String(e)));
    return () => ac.abort();
  }, [bank]);

  if (error) {
    return (
      <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
        <ErrorState title={t('economy.centralBankError')} detail={error} />
        <p style={{ marginTop: space[12] }}><Link href="/economy/central-bank" style={{ color: themeColor.blue }}>{t('economy.allCentralBanks')}</Link></p>
      </main>
    );
  }
  if (!data) return <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}><Loading what={t('economy.loadingCentralBank')} /></main>;

  const b = data.bank;
  const delta = b.rate !== null && b.previousRate !== null ? b.rate - b.previousRate : null;

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
      <PageHeader title={b.name} description={t('economy.bankDesc', { short: b.short, area: b.area, region: b.region })} nav={ECONOMY_NAV} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: space[12] }}>
        <Card>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(110px, 100%), 1fr))', gap: space[12] }}>
            <Value label={t('economy.hPolicyRate')} value={b.rate === null ? NO_VALUE : formatValue(b.rate, 2)} tone={b.rate === null ? 'muted' : 'default'} unit={b.rate === null ? undefined : '%'} />
            <Value label={t('economy.lastChange')} value={delta === null ? NO_VALUE : formatValue(delta, 2)} tone={delta === null ? 'muted' : 'default'} unit={delta === null ? undefined : 'pp'} hint={t('economy.lastChangeHint')} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[4] }}>
              <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary, textTransform: 'uppercase' }}>{t('col.asOf')}</span>
              <span style={{ fontSize: fontSize[15], color: themeColor.labelPrimary }}>{formatDate(b.date)}</span>
            </div>
          </div>
          <p style={{ margin: `${space[12]}px 0 0`, fontSize: fontSize[12], color: themeColor.labelTertiary }}>{b.note}</p>
        </Card>
        <Card title={t('economy.rateHistory')} subtitle={t('economy.dailyObs', { n: data.history.length })}>
          <Chart points={data.history} />
        </Card>
      </div>

      <div style={{ marginTop: space[12] }}>
        <Card title={t('economy.decisionsTitle')} subtitle={t('economy.decisionsSub')}>
          {data.changes.length === 0 ? (
            <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>{t('economy.noLevelChange')}</p>
          ) : (
            <DataTable
              head={[t('col.date'), t('economy.fromLabel'), t('economy.toLabel'), t('economy.hMove')]}
              rows={data.changes.map((c) => ({
                cells: [
                  formatDate(c.date),
                  <span key="f">{formatValue(c.from, 2)}%</span>,
                  <span key="t">{formatValue(c.to, 2)}%</span>,
                  <span key="m" style={{ color: c.to > c.from ? themeColor.red : themeColor.green }}>{c.to > c.from ? t('economy.hike') : t('economy.cut')} {formatValue(Math.abs(c.to - c.from), 2)}pp</span>,
                ],
              }))}
            />
          )}
        </Card>
      </div>

      {data.related.length > 0 && (
        <div style={{ marginTop: space[12] }}>
          <Card title={t('economy.relatedMonetary')}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
              {data.related.map((r) => (
                <Link key={r.slug} href={`/economy/indicator/${r.slug}`} style={{ padding: `${space[4]}px ${space[8]}px`, border: `1px solid ${themeColor.separator}`, borderRadius: radius[8], color: themeColor.labelPrimary, fontSize: fontSize[11], textDecoration: 'none' }}>{r.name}</Link>
              ))}
            </div>
          </Card>
        </div>
      )}

      <p style={{ marginTop: space[16], fontSize: fontSize[11], color: themeColor.labelTertiary }}>
        <strong style={{ fontWeight: fontWeight.medium }}>{t('economy.upstreamLabel')}</strong> {data.upstream.join(' · ')}
      </p>
      <p style={{ marginTop: space[8], fontSize: fontSize[11], color: themeColor.labelTertiary }}>{data.derived}</p>
    </main>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/lib/i18n/t';
import { themeColor, fontSize, radius, space, fontWeight } from '@/styles/tokens';
import { fetchIndicators, type IndicatorsEnvelope, type IndicatorMeta, fetchIndicator, formatDate, formatDelta, formatValue, NO_VALUE, type IndicatorEnvelope } from '@/features/economy/model';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { ErrorState, Loading } from '@/ui/feedback';
import { PageHeader } from '@/ui/page-header';
import { Value } from '@/ui/value';
import { ImportanceDots } from '@/features/economy/ui/importance-dots';
import { ECONOMY_NAV } from '@/features/economy/nav';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';

/**
 * The indicator explorer (plan Phase 6) — `/economy/indicator`.
 *
 * Filters are LOCAL (the payload says so): the registry is small enough to narrow
 * in memory, and a filter that re-fetched would cost an upstream call per
 * keystroke. Facet counts come from the FULL set, so they do not collapse to 1 as
 * the user drills in.
 */

const FIELD = {
  padding: `${space[8]}px ${space[8]}px`,
  background: themeColor.bgSecondary,
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  color: themeColor.labelPrimary,
  fontSize: fontSize[11],
} as const;

export default function IndicatorExplorer() {
  const t = useT();
  const [data, setData] = useState<IndicatorsEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState('');
  const [country, setCountry] = useState('');
  const [frequency, setFrequency] = useState('');
  const [source, setSource] = useState('');
  const [q, setQ] = useState('');

  const load = useCallback(
    (signal: AbortSignal) => {
      fetchIndicators({ category, country, frequency, source, q }, signal)
        .then((d) => !signal.aborted && setData(d))
        .catch((e) => !signal.aborted && setError(e instanceof Error ? e.message : String(e)));
    },
    [category, country, frequency, source, q]
  );

  useEffect(() => {
    const ac = new AbortController();
    // Debounce the free-text field; the selects apply immediately.
    const t = setTimeout(() => load(ac.signal), q ? 220 : 0);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [load, q]);

  const rows: IndicatorMeta[] = data?.indicators ?? [];

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
      <PageHeader
        title={t('economy.indicatorsTitle')}
        description={t('economy.indicatorsDesc')}
        nav={ECONOMY_NAV}
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12] }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('economy.searchIndicators')} aria-label={t('economy.searchIndicatorsLabel')} style={{ ...FIELD, flex: '1 1 220px' }} />
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t('economy.hCategory')} style={FIELD}>
          <option value="">{t('economy.allCategories')}</option>
          {data?.facets.categories.map((c) => <option key={c.id} value={c.id}>{c.label} ({c.count})</option>)}
        </select>
        <select value={country} onChange={(e) => setCountry(e.target.value)} aria-label={t('economy.hCountry')} style={FIELD}>
          <option value="">{t('economy.allCountriesFilter')}</option>
          {data?.facets.countries.slice(0, 60).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.count})</option>)}
        </select>
        <select value={frequency} onChange={(e) => setFrequency(e.target.value)} aria-label={t('economy.frequencyLabel')} style={FIELD}>
          <option value="">{t('economy.anyFrequency')}</option>
          {data?.facets.frequencies.map((f) => <option key={f.id} value={f.id}>{f.id} ({f.count})</option>)}
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label={t('economy.sourceLabel')} style={FIELD}>
          <option value="">{t('economy.anySource')}</option>
          {data?.facets.sources.map((s) => <option key={s.id} value={s.id}>{s.id} ({s.count})</option>)}
        </select>
      </div>

      {error && <ErrorState title={t('economy.indicatorsError')} detail={error} />}
      {!data && !error && <Loading what={t('economy.loadingIndicators')} />}

      {data && (
        <Card
          title={t('economy.seriesRegistryCount', { n: rows.length, total: data.registryTotal })}
          subtitle={t('economy.filteredLocally')}
          right={data.facets.sources.length > 0 ? <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>{t('economy.categoriesCount', { n: data.facets.categories.length })}</span> : undefined}
        >
          <div style={{ maxHeight: 620, overflowY: 'auto' }}>
            <Table>
              <THead>
                <TR>
                  {[t('economy.hIndicator'), t('economy.hCountry'), t('economy.hCategory'), t('economy.hFreq'), t('economy.hSource'), t('economy.hImp')].map((h) => (
                    <TH key={h} style={{ position: 'sticky', top: 0, background: themeColor.bgSecondary, textAlign: 'left', padding: `${space[8]}px ${space[8]}px`, color: themeColor.labelTertiary, fontSize: fontSize[11], borderBottom: `1px solid ${themeColor.separator}` }}>{h}</TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {rows.slice(0, 400).map((r) => (
                  <TR key={r.slug}>
                    <TD style={{ padding: `${space[4]}px ${space[8]}px`, borderBottom: `1px solid ${themeColor.separator}` }}>
                      <Link href={`/economy/indicator/${r.slug}`} style={{ color: themeColor.blue, textDecoration: 'none' }} title={r.note}>{r.name}</Link>
                      <div style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>{r.slug}</div>
                    </TD>
                    <TD style={{ padding: `${space[4]}px ${space[8]}px`, borderBottom: `1px solid ${themeColor.separator}`, color: themeColor.labelTertiary }}>{r.countryName ?? '—'}</TD>
                    <TD style={{ padding: `${space[4]}px ${space[8]}px`, borderBottom: `1px solid ${themeColor.separator}`, color: themeColor.labelTertiary }}>{r.category}</TD>
                    <TD style={{ padding: `${space[4]}px ${space[8]}px`, borderBottom: `1px solid ${themeColor.separator}`, color: themeColor.labelTertiary }}>{r.frequency}</TD>
                    <TD style={{ padding: `${space[4]}px ${space[8]}px`, borderBottom: `1px solid ${themeColor.separator}`, color: themeColor.labelTertiary }}>{r.source}</TD>
                    <TD style={{ padding: `${space[4]}px ${space[8]}px`, borderBottom: `1px solid ${themeColor.separator}` }}><ImportanceDots level={r.importance} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          {rows.length > 400 && <p style={{ marginTop: space[8], fontSize: fontSize[11], color: themeColor.labelTertiary }}>{t('economy.showingFirst400', { n: rows.length })}</p>}
        </Card>
      )}
    </main>
  );
}

/**
 * One canonical series (plan Phase 6) — `/economy/indicator/[indicator]`.
 *
 * The chart is drawn from the OBSERVATIONS themselves, one point per published
 * period, with gaps left as gaps: a monthly series with a missing month is not
 * interpolated across, because a line drawn through a hole asserts a value that
 * was never published.
 */

const W = 720;
const H = 200;

function Chart({ points }: { points: { date: string; value: number | null }[] }) {
  const t = useT();
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null && Number.isFinite(v));
  if (vals.length < 2) return <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>{t('economy.notEnoughPublished')}</p>;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = W / Math.max(1, points.length - 1);
  // One segment per contiguous run of published values, so a gap breaks the line.
  const segments: string[] = [];
  let run: string[] = [];
  points.forEach((p, i) => {
    if (p.value === null || !Number.isFinite(p.value)) {
      if (run.length > 1) segments.push(run.join(' '));
      run = [];
      return;
    }
    run.push(`${run.length === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(H - ((p.value - min) / span) * H).toFixed(1)}`);
  });
  if (run.length > 1) segments.push(run.join(' '));
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={W} height={H + 22} role="img" aria-label={t('economy.seriesHistoryLabel')}>
        {segments.map((d, i) => <path key={i} d={d} fill="none" stroke={themeColor.blue} strokeWidth={1.6} />)}
        <text x={0} y={H + 16} fill={themeColor.labelTertiary} fontSize={10}>{points[0]?.date}</text>
        <text x={W} y={H + 16} fill={themeColor.labelTertiary} fontSize={10} textAnchor="end">{points[points.length - 1]?.date}</text>
        <text x={0} y={10} fill={themeColor.labelTertiary} fontSize={10}>{formatValue(max, 2)}</text>
        <text x={0} y={H} fill={themeColor.labelTertiary} fontSize={10}>{formatValue(min, 2)}</text>
      </svg>
    </div>
  );
}

export function IndicatorDetail({ slug }: { slug: string }) {
  const t = useT();
  const [data, setData] = useState<IndicatorEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchIndicator(slug, ac.signal)
      .then((d) => !ac.signal.aborted && setData(d))
      .catch((e) => !ac.signal.aborted && setError(e instanceof Error ? e.message : String(e)));
    return () => ac.abort();
  }, [slug]);

  if (error) {
    return (
      <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
        <ErrorState title={t('economy.indicatorError')} detail={error} />
        <p style={{ marginTop: space[12] }}><Link href="/economy/indicator" style={{ color: themeColor.blue }}>{t('economy.allIndicators')}</Link></p>
      </main>
    );
  }
  if (!data) {
    return <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}><Loading what={t('economy.loadingIndicator')} /></main>;
  }

  const i = data.indicator;
  const latest = data.latest;
  const change = latest && data.observations.length > 1 ? latest.value - (data.observations[data.observations.length - 2]?.value ?? latest.value) : null;
  const recent = [...data.observations].reverse().slice(0, 24);

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
      <PageHeader
        title={i.name}
        description={t('economy.indicatorDesc', { slug: i.slug, category: i.category, subcategory: i.subcategory, frequency: i.frequency, sa: i.seasonalAdjustment === 'NA' ? '' : ` · ${i.seasonalAdjustment}`, source: i.source })}
        nav={ECONOMY_NAV}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: space[12] }}>
        <Card>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(110px, 100%), 1fr))', gap: space[12] }}>
            <Value label={t('economy.hLatest')} value={latest?.value == null ? NO_VALUE : formatValue(latest.value, i.decimals)} tone={latest?.value == null ? 'muted' : 'default'} unit={latest?.value == null ? undefined : i.unit} />
            <Value label={t('economy.hChange')} value={change === null ? NO_VALUE : formatValue(change, i.decimals)} tone={change === null ? 'muted' : 'default'} hint={t('economy.vsPrevious')} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[4] }}>
              <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary, textTransform: 'uppercase' }}>{t('economy.hPeriod')}</span>
              <span style={{ fontSize: fontSize[15], color: themeColor.labelPrimary }}>{formatDate(latest?.date)}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[4] }}>
              <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary, textTransform: 'uppercase' }}>{t('economy.importanceLabel')}</span>
              <span><ImportanceDots level={i.importance} /></span>
            </div>
          </div>
          <p style={{ margin: `${space[12]}px 0 0`, fontSize: fontSize[12], color: themeColor.labelTertiary }}>{i.note}</p>
        </Card>

        <Card title={t('economy.historyTitle')} subtitle={t('economy.publishedObs', { n: data.observations.length })}>
          <Chart points={data.observations} />
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: space[12], marginTop: space[12] }}>
        <Card title={t('economy.recentObs')} subtitle={t('economy.newestFirst')}>
          <DataTable
            head={[t('economy.hPeriod'), t('economy.hValue'), t('economy.hDeltaPrior')]}
            rows={recent.map((o) => ({
              cells: [
                formatDate(o.date),
                <span key="v">{o.value === null ? '—' : formatValue(o.value, i.decimals)}</span>,
                <span key="d" style={{ color: themeColor.labelTertiary }}>{o.previous === null || o.value === null ? '—' : formatDelta(o.value - o.previous, i.decimals)}</span>,
              ],
            }))}
          />
        </Card>

        <Card title={t('economy.releaseTitle')} subtitle={t('economy.releaseSub')}>
          <DataTable
            head={[t('economy.hField'), t('economy.hValue')]}
            rows={[
              { cells: [t('economy.refPeriod'), formatDate(data.release?.releaseAt ?? null)] },
              { cells: [t('economy.hActual'), data.release?.actual === null || data.release?.actual === undefined ? '—' : formatValue(data.release.actual, i.decimals)] },
              { cells: [t('economy.hPrevious'), data.release?.previous === null || data.release?.previous === undefined ? '—' : formatValue(data.release.previous, i.decimals)] },
              { cells: [t('economy.hForecast'), <span key="f" style={{ color: themeColor.labelTertiary }}>{t('economy.notPublished')}</span>] },
            ]}
          />
        </Card>
      </div>

      {data.related.length > 0 && (
        <div style={{ marginTop: space[12] }}>
          <Card title={t('economy.relatedTitle')} subtitle={t('economy.relatedSub')}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
              {data.related.map((r) => (
                <Link key={r.slug} href={`/economy/indicator/${r.slug}`} style={{ padding: `${space[4]}px ${space[8]}px`, border: `1px solid ${themeColor.separator}`, borderRadius: radius[8], color: themeColor.labelPrimary, fontSize: fontSize[11], textDecoration: 'none' }}>
                  {r.countryName ? `${r.countryName} · ` : ''}{r.subcategory}
                </Link>
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

'use client';

/**
 * The economic calendar (plan Phase 8) — `/economy/calendar`.
 *
 * This is a RELEASE LOG, not a forward schedule, and the page says so in the
 * header: no keyless source here publishes a publication calendar or a consensus,
 * so every row's period is a value that already exists and the forecast column is
 * always an em dash. Presenting it as a forward calendar would be the single most
 * misleading thing this module could do.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/lib/i18n/t';
import { themeColor, fontSize, radius, space } from '@/styles/tokens';
import { fetchCalendar, formatDate, formatValue, type CalendarEnvelope } from '@/features/economy/model';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { ECONOMY_NAV } from '@/features/economy/nav';
import { ErrorState } from '@/ui/feedback';
import { ImportanceDots } from '@/features/economy/ui/importance-dots';
import { Loading } from '@/ui/feedback';
import { PageHeader } from '@/ui/page-header';

const FIELD = {
  padding: `${space[8]}px ${space[8]}px`,
  background: themeColor.bgSecondary,
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  color: themeColor.labelPrimary,
  fontSize: fontSize[11],
} as const;

/** Today and `n` days ago, as `YYYY-MM-DD`, for the default window. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

export default function EconomyCalendar() {
  const t = useT();
  const [data, setData] = useState<CalendarEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState(daysAgo(120));
  const [to, setTo] = useState(daysAgo(0));
  const [category, setCategory] = useState('');
  const [country, setCountry] = useState('');

  const load = useCallback(
    (signal: AbortSignal) => {
      fetchCalendar({ from, to, category, country }, signal)
        .then((d) => !signal.aborted && setData(d))
        .catch((e) => !signal.aborted && setError(e instanceof Error ? e.message : String(e)));
    },
    [from, to, category, country]
  );

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
      <PageHeader
        title={t('economy.calendarTitle')}
        description={t('economy.calendarDesc')}
        nav={ECONOMY_NAV}
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[12], alignItems: 'center' }}>
        <label style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>
          {t('economy.fromLabel')} <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ ...FIELD, marginLeft: space[8] }} />
        </label>
        <label style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>
          {t('economy.toLabel')} <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ ...FIELD, marginLeft: space[8] }} />
        </label>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t('economy.hCategory')} style={FIELD}>
          <option value="">{t('economy.anyCategory')}</option>
          {['growth', 'labor', 'inflation', 'monetary', 'fiscal', 'trade'].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} placeholder="ISO3 (e.g. USA)" aria-label={t('economy.hCountry')} style={{ ...FIELD, width: 130 }} />
        {data && <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>{t('economy.calendarCount', { n: data.total, from: data.window.from, to: data.window.to })}</span>}
      </div>

      {error && <ErrorState title={t('economy.calendarError')} detail={error} />}
      {!data && !error && <Loading what={t('economy.loadingCalendar')} />}

      {data && (
        <Card title={t('economy.releasesTitle')} subtitle={t('economy.releasesSub')}>
          {data.events.length === 0 ? (
            <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>{t('economy.noReleases')}</p>
          ) : (
            <DataTable
              head={[t('economy.hIndicator'), t('economy.hCountry'), t('economy.hPeriod'), t('economy.hActual'), t('economy.hPrevious'), t('economy.hImp')]}
              rows={data.events.map((e, i) => ({
                href: `/economy/indicator/${e.slug}`,
                cells: [
                  e.label,
                  <span key="c" style={{ color: themeColor.labelTertiary }}>{e.country ?? '—'}</span>,
                  <span key="d" style={{ color: themeColor.labelTertiary }}>{formatDate(e.releaseAt)}</span>,
                  <span key="a">{e.actual === null ? '—' : formatValue(e.actual, 2)}</span>,
                  <span key="p" style={{ color: themeColor.labelTertiary }}>{e.previous === null ? '—' : formatValue(e.previous, 2)}</span>,
                  <ImportanceDots key={`i${i}`} level={e.importance} />,
                ],
              }))}
            />
          )}
        </Card>
      )}

      {data && data.failed.length > 0 && (
        <div style={{ marginTop: space[12] }}>
          <ErrorState title={t('economy.seriesUnreadable', { n: data.failed.length })} detail={data.failed.map((f) => `${f.symbol}: ${f.reason}`).join(' · ')} />
        </div>
      )}

      <p style={{ marginTop: space[16], fontSize: fontSize[11], color: themeColor.labelTertiary }}>{data?.derived}</p>
      <p style={{ marginTop: space[8], fontSize: fontSize[11], color: themeColor.labelTertiary }}>
        {t('economy.calendarHintPre')} <Link href="/economy/indicator" style={{ color: themeColor.blue }}>{t('economy.calendarHintLink')}</Link>.
      </p>
    </main>
  );
}

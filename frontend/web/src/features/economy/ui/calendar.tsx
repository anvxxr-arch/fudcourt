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
import { color, fontSize, radius, space } from '@/styles/tokens';
import { fetchCalendar, formatDate, formatValue, type CalendarEnvelope } from '@/features/economy/client';
import { Card, DataTable, ECONOMY_NAV, ErrorState, ImportanceDots, Loading, PageHeader } from '@/features/economy/ui/parts';

const FIELD = {
  padding: `${space[6]}px ${space[8]}px`,
  background: color.surface,
  border: `1px solid ${color.border}`,
  borderRadius: radius[6],
  color: color.text,
  fontSize: fontSize[11],
} as const;

/** Today and `n` days ago, as `YYYY-MM-DD`, for the default window. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

export default function EconomyCalendar() {
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
        title="Economic Calendar"
        description="A release log of market-moving series by reference period. These sources publish no forward schedule and no consensus, so the forecast column is always an em dash — it is not a forward calendar."
        nav={ECONOMY_NAV}
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[14], alignItems: 'center' }}>
        <label style={{ fontSize: fontSize[11], color: color.textMuted }}>
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ ...FIELD, marginLeft: space[6] }} />
        </label>
        <label style={{ fontSize: fontSize[11], color: color.textMuted }}>
          To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ ...FIELD, marginLeft: space[6] }} />
        </label>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" style={FIELD}>
          <option value="">Any category</option>
          {['growth', 'labor', 'inflation', 'monetary', 'fiscal', 'trade'].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} placeholder="ISO3 (e.g. USA)" aria-label="Country" style={{ ...FIELD, width: 130 }} />
        {data && <span style={{ fontSize: fontSize[11], color: color.textMuted }}>{data.total} event(s) in {data.window.from} → {data.window.to}</span>}
      </div>

      {error && <ErrorState title="Could not load the calendar" detail={error} />}
      {!data && !error && <Loading what="calendar" />}

      {data && (
        <Card title="Releases" subtitle="reference periods, newest first">
          {data.events.length === 0 ? (
            <p style={{ color: color.textMuted, fontSize: fontSize[12] }}>No releases in this window. Widen the date range or clear the filters.</p>
          ) : (
            <DataTable
              head={['Indicator', 'Country', 'Period', 'Actual', 'Previous', 'Imp.']}
              rows={data.events.map((e, i) => ({
                href: `/economy/indicator/${e.slug}`,
                cells: [
                  e.label,
                  <span key="c" style={{ color: color.textMuted }}>{e.country ?? '—'}</span>,
                  <span key="d" style={{ color: color.textMuted }}>{formatDate(e.releaseAt)}</span>,
                  <span key="a">{e.actual === null ? '—' : formatValue(e.actual, 2)}</span>,
                  <span key="p" style={{ color: color.textMuted }}>{e.previous === null ? '—' : formatValue(e.previous, 2)}</span>,
                  <ImportanceDots key={`i${i}`} level={e.importance} />,
                ],
              }))}
            />
          )}
        </Card>
      )}

      {data && data.failed.length > 0 && (
        <div style={{ marginTop: space[14] }}>
          <ErrorState title={`${data.failed.length} series could not be read`} detail={data.failed.map((f) => `${f.symbol}: ${f.reason}`).join(' · ')} />
        </div>
      )}

      <p style={{ marginTop: space[16], fontSize: fontSize[11], color: color.textMuted }}>{data?.derived}</p>
      <p style={{ marginTop: space[8], fontSize: fontSize[11], color: color.textMuted }}>
        Looking for a single series? Open it from the <Link href="/economy/indicator" style={{ color: color.accent }}>indicator explorer</Link>.
      </p>
    </main>
  );
}

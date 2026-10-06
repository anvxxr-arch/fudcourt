'use client';

/**
 * Compare any set of series (plan Phase 10) — `/economy/compare`.
 *
 * The query lives in the URL (`?countries=us,id&series=cpi,gdp&period=5y`), so a
 * comparison is shareable without minting a static page per combination — the
 * plan's explicit requirement. Series are drawn on their own axes: a monthly CPI
 * and an annual GDP print cannot be honestly interpolated onto one grid, so each
 * gets its own row and its own chart rather than one misleading overlay.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { color, fontSize, radius, space } from '@/styles/tokens';
import { fetchCompare, formatDate, formatValue, type CompareEnvelope } from '@/features/economy/model';
import { Card } from '@/ui/card';
import { ECONOMY_NAV } from '@/features/economy/nav';
import { ErrorState } from '@/ui/feedback';
import { Loading } from '@/ui/feedback';
import { PageHeader } from '@/ui/page-header';
import { Sparkline } from '@/ui/sparkline';

const COUNTRIES = ['us', 'cn', 'de', 'jp', 'gb', 'in', 'id', 'br', 'fr', 'kr'] as const;
const SERIES = [
  { id: 'gdp', label: 'GDP growth' },
  { id: 'cpi', label: 'CPI' },
  { id: 'unemployment', label: 'Unemployment' },
  { id: 'm2', label: 'M2' },
  { id: 'gov-revenue', label: 'Government revenue' },
  { id: 'deficit', label: 'Budget balance' },
] as const;
const PERIODS = ['1y', '2y', '5y', '10y', 'max'] as const;

const FIELD = {
  padding: `${space[8]}px ${space[8]}px`,
  background: color.bgSecondary,
  border: `1px solid ${color.separator}`,
  borderRadius: radius[8],
  color: color.labelPrimary,
  fontSize: fontSize[11],
} as const;

export default function CompareBoard() {
  const [selectedCountries, setSelectedCountries] = useState<string[]>(['us', 'id']);
  const [selectedSeries, setSelectedSeries] = useState<string[]>(['cpi', 'gdp']);
  const [period, setPeriod] = useState<string>('5y');
  const [data, setData] = useState<CompareEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedCountries.length === 0 || selectedSeries.length === 0) {
      setData(null);
      return;
    }
    const ac = new AbortController();
    const slugs = selectedCountries.flatMap((c) => selectedSeries.map((s) => `${c}-${s}`));
    fetchCompare(slugs, period, ac.signal)
      .then((d) => !ac.signal.aborted && setData(d))
      .catch((e) => !ac.signal.aborted && setError(e instanceof Error ? e.message : String(e)));
    return () => ac.abort();
  }, [selectedCountries, selectedSeries, period]);

  // Keep the URL in step with the selection so the view is shareable.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams({ countries: selectedCountries.join(','), series: selectedSeries.join(','), period });
    window.history.replaceState(null, '', `/economy/compare?${p}`);
  }, [selectedCountries, selectedSeries, period]);

  const toggle = (list: string[], setList: (v: string[]) => void, id: string) => {
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  };

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
      <PageHeader
        title="Compare"
        description="Put any countries on any measures over one period. The query lives in the URL, so a comparison is shareable without a page per combination. Series keep their own cadence — they are never resampled onto one grid."
        nav={ECONOMY_NAV}
      />

      <Card title="Countries">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
          {COUNTRIES.map((c) => {
            const on = selectedCountries.includes(c);
            return (
              <button key={c} onClick={() => toggle(selectedCountries, setSelectedCountries, c)} aria-pressed={on} style={{ ...FIELD, cursor: 'pointer', background: on ? color.blue : color.bgSecondary, color: on ? color.labelOnAccent : color.labelPrimary }}>
                {c.toUpperCase()}
              </button>
            );
          })}
        </div>
      </Card>

      <div style={{ marginTop: space[8] }}>
        <Card title="Series">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
            {SERIES.map((s) => {
              const on = selectedSeries.includes(s.id);
              return (
                <button key={s.id} onClick={() => toggle(selectedSeries, setSelectedSeries, s.id)} aria-pressed={on} style={{ ...FIELD, cursor: 'pointer', background: on ? color.blue : color.bgSecondary, color: on ? color.labelOnAccent : color.labelPrimary }}>
                  {s.label}
                </button>
              );
            })}
            <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Period" style={FIELD}>
              {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </Card>
      </div>

      {error && <div style={{ marginTop: space[12] }}><ErrorState title="Could not compare" detail={error} /></div>}
      {!data && !error && selectedCountries.length > 0 && selectedSeries.length > 0 && <div style={{ marginTop: space[12] }}><Loading what="comparison" /></div>}

      {data && (
        <div style={{ marginTop: space[12] }}>
          <Card title={`${data.series.length} series`} subtitle={`period ${data.period}${data.missing.length ? ` · unresolved: ${data.missing.join(', ')}` : ''}`}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
              {data.series.map((s) => {
                const latest = [...s.points].reverse().find((p) => p.value !== null);
                return (
                  <div key={s.slug} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space[8], borderBottom: `1px solid ${color.separator}`, paddingBottom: space[8] }}>
                    <div style={{ minWidth: 0 }}>
                      <Link href={`/economy/indicator/${s.slug}`} style={{ color: color.labelPrimary, textDecoration: 'none', fontSize: fontSize[12] }}>{s.label}</Link>
                      <div style={{ fontSize: fontSize[11], color: color.labelTertiary }}>{latest ? formatDate(latest.date) : '—'} · {s.frequency} · {s.unit}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: space[8] }}>
                      <Sparkline points={s.points.map((p) => p.value)} width={140} />
                      <span style={{ fontSize: fontSize[15], color: color.labelPrimary, minWidth: 64, textAlign: 'right' }}>{latest ? formatValue(latest.value, s.decimals) : '—'}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
          <p style={{ marginTop: space[12], fontSize: fontSize[11], color: color.labelTertiary }}>{data.derived}</p>
        </div>
      )}
    </main>
  );
}

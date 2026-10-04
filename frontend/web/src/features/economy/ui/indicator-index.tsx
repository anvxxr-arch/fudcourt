'use client';

/**
 * The indicator explorer (plan Phase 6) — `/economy/indicator`.
 *
 * Filters are LOCAL (the payload says so): the registry is small enough to narrow
 * in memory, and a filter that re-fetched would cost an upstream call per
 * keystroke. Facet counts come from the FULL set, so they do not collapse to 1 as
 * the user drills in.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { color, fontSize, radius, space } from '@/styles/tokens';
import { fetchIndicators, type IndicatorsEnvelope, type IndicatorMeta } from '@/features/economy/client';
import { Card, ECONOMY_NAV, ErrorState, ImportanceDots, Loading, PageHeader } from '@/features/economy/ui/parts';

const FIELD = {
  padding: `${space[6]}px ${space[8]}px`,
  background: color.surface,
  border: `1px solid ${color.border}`,
  borderRadius: radius[6],
  color: color.text,
  fontSize: fontSize[11],
} as const;

export default function IndicatorExplorer() {
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
        title="Indicators"
        description="Every canonical series in the registry, addressed by a stable slug (`us-cpi`, `id-cpi`). Filter by category, country, frequency or source; each row resolves to one upstream binding."
        nav={ECONOMY_NAV}
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8], marginBottom: space[14] }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or slug…" aria-label="Search indicators" style={{ ...FIELD, flex: '1 1 220px' }} />
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" style={FIELD}>
          <option value="">All categories</option>
          {data?.facets.categories.map((c) => <option key={c.id} value={c.id}>{c.label} ({c.count})</option>)}
        </select>
        <select value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Country" style={FIELD}>
          <option value="">All countries</option>
          {data?.facets.countries.slice(0, 60).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.count})</option>)}
        </select>
        <select value={frequency} onChange={(e) => setFrequency(e.target.value)} aria-label="Frequency" style={FIELD}>
          <option value="">Any frequency</option>
          {data?.facets.frequencies.map((f) => <option key={f.id} value={f.id}>{f.id} ({f.count})</option>)}
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source" style={FIELD}>
          <option value="">Any source</option>
          {data?.facets.sources.map((s) => <option key={s.id} value={s.id}>{s.id} ({s.count})</option>)}
        </select>
      </div>

      {error && <ErrorState title="Could not load indicators" detail={error} />}
      {!data && !error && <Loading what="indicators" />}

      {data && (
        <Card
          title={`${rows.length} of ${data.registryTotal} series`}
          subtitle="filtered locally — no upstream call per keystroke"
          right={data.facets.sources.length > 0 ? <span style={{ fontSize: fontSize[10], color: color.textMuted }}>{data.facets.categories.length} categories</span> : undefined}
        >
          <div style={{ maxHeight: 620, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: fontSize[12] }}>
              <thead>
                <tr>
                  {['Indicator', 'Country', 'Category', 'Freq', 'Source', 'Imp.'].map((h) => (
                    <th key={h} style={{ position: 'sticky', top: 0, background: color.surface, textAlign: 'left', padding: `${space[6]}px ${space[8]}px`, color: color.textMuted, fontSize: fontSize[10], borderBottom: `1px solid ${color.border}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 400).map((r) => (
                  <tr key={r.slug}>
                    <td style={{ padding: `${space[5]}px ${space[8]}px`, borderBottom: `1px solid ${color.border}` }}>
                      <Link href={`/economy/indicator/${r.slug}`} style={{ color: color.accent, textDecoration: 'none' }} title={r.note}>{r.name}</Link>
                      <div style={{ fontSize: fontSize[10], color: color.textMuted }}>{r.slug}</div>
                    </td>
                    <td style={{ padding: `${space[5]}px ${space[8]}px`, borderBottom: `1px solid ${color.border}`, color: color.textMuted }}>{r.countryName ?? '—'}</td>
                    <td style={{ padding: `${space[5]}px ${space[8]}px`, borderBottom: `1px solid ${color.border}`, color: color.textMuted }}>{r.category}</td>
                    <td style={{ padding: `${space[5]}px ${space[8]}px`, borderBottom: `1px solid ${color.border}`, color: color.textMuted }}>{r.frequency}</td>
                    <td style={{ padding: `${space[5]}px ${space[8]}px`, borderBottom: `1px solid ${color.border}`, color: color.textMuted }}>{r.source}</td>
                    <td style={{ padding: `${space[5]}px ${space[8]}px`, borderBottom: `1px solid ${color.border}` }}><ImportanceDots level={r.importance} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 400 && <p style={{ marginTop: space[8], fontSize: fontSize[11], color: color.textMuted }}>showing the first 400 of {rows.length} — narrow the filters to see the rest</p>}
        </Card>
      )}
    </main>
  );
}

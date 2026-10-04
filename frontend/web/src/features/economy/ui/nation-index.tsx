'use client';

/**
 * The country explorer (plan Phase 5) — `/economy/nation`.
 *
 * Search + regional grouping + a per-country indicator count. The list is served
 * from the compiled registry (`/api/economy/countries`), so it renders even when
 * every provider is down — a navigation page that fails is a page nobody can
 * reach the data through. Ranking is by indicator count, so a country with a
 * deeper profile leads.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { color, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { fetchCountries, type CountriesEnvelope, type CountrySummary } from '@/features/economy/client';
import { Card, ECONOMY_NAV, ErrorState, Loading, PageHeader } from '@/features/economy/ui/parts';

export default function NationExplorer() {
  const [data, setData] = useState<CountriesEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    const ac = new AbortController();
    fetchCountries(ac.signal)
      .then((d) => !ac.signal.aborted && setData(d))
      .catch((e) => !ac.signal.aborted && setError(e instanceof Error ? e.message : String(e)));
    return () => ac.abort();
  }, []);

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return data.countries;
    return data.countries.filter(
      (c) => c.name.toLowerCase().includes(needle) || c.iso2.toLowerCase() === needle || c.iso3.toLowerCase() === needle || c.currency.toLowerCase() === needle
    );
  }, [data, q]);

  const byRegion = useMemo(() => {
    const m = new Map<string, CountrySummary[]>();
    for (const c of filtered) {
      const list = m.get(c.region) ?? [];
      list.push(c);
      m.set(c.region, list);
    }
    for (const list of m.values()) list.sort((a, b) => b.indicatorCount - a.indicatorCount || a.name.localeCompare(b.name));
    return m;
  }, [filtered]);

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
      <PageHeader
        title="Nations"
        description="Every economy the module covers, grouped by region. A country page is the aggregator for all of its series: growth, inflation, labour, money, fiscal and trade."
        nav={ECONOMY_NAV}
      />

      <div style={{ marginBottom: space[14], display: 'flex', gap: space[10], alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search country, ISO code or currency…"
          aria-label="Search countries"
          style={{
            flex: '1 1 280px',
            padding: `${space[8]}px ${space[10]}px`,
            background: color.surface,
            border: `1px solid ${color.border}`,
            borderRadius: radius[6],
            color: color.text,
            fontSize: fontSize[12],
          }}
        />
        {data && (
          <span style={{ fontSize: fontSize[11], color: color.textMuted }}>
            {filtered.length} of {data.total} countries
          </span>
        )}
      </div>

      {error && <ErrorState title="Could not load countries" detail={error} />}
      {!data && !error && <Loading what="countries" />}

      {data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[16] }}>
          {data.regions.map((region) => {
            const list = byRegion.get(region);
            if (!list || list.length === 0) return null;
            return (
              <Card key={region} title={region} subtitle={`${list.length} countries`}>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: space[6] }}>
                  {list.map((c) => (
                    <li key={c.id}>
                      <Link
                        href={`/economy/nation/${c.iso2.toLowerCase()}`}
                        style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          justifyContent: 'space-between',
                          gap: space[6],
                          padding: `${space[6]}px ${space[8]}px`,
                          border: `1px solid ${color.border}`,
                          borderRadius: radius[6],
                          color: color.text,
                          fontSize: fontSize[12],
                          textDecoration: 'none',
                        }}
                      >
                        <span style={{ minWidth: 0 }}>{c.name}</span>
                        <span style={{ color: color.textMuted, fontSize: fontSize[10], fontWeight: fontWeight.medium }}>{c.currency} · {c.indicatorCount}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
    </main>
  );
}

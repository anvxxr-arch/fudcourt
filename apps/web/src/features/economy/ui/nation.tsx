'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { themeColor, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { fetchCountries, type CountriesEnvelope, type CountrySummary, fetchCountry, formatDate, formatDelta, formatValue, NO_VALUE, type CountryEnvelope } from '@/features/economy/model';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { ErrorState, Loading } from '@/ui/feedback';
import { PageHeader } from '@/ui/page-header';
import { Value } from '@/ui/value';
import { ImportanceDots } from '@/features/economy/ui/importance-dots';
import { ECONOMY_NAV } from '@/features/economy/nav';
import RegimeBoard from '@/features/economy/ui/regime';

/**
 * The country explorer (plan Phase 5) — `/economy/nation`.
 *
 * Search + regional grouping + a per-country indicator count. The list is served
 * from the compiled registry (`/api/economy/countries`), so it renders even when
 * every provider is down — a navigation page that fails is a page nobody can
 * reach the data through. Ranking is by indicator count, so a country with a
 * deeper profile leads.
 */

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

      <div style={{ marginBottom: space[12], display: 'flex', gap: space[8], alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search country, ISO code or currency…"
          aria-label="Search countries"
          style={{
            flex: '1 1 280px',
            padding: `${space[8]}px ${space[8]}px`,
            background: themeColor.bgSecondary,
            border: `1px solid ${themeColor.separator}`,
            borderRadius: radius[8],
            color: themeColor.labelPrimary,
            fontSize: fontSize[12],
          }}
        />
        {data && (
          <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>
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
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(200px, 100%), 1fr))', gap: space[8] }}>
                  {list.map((c) => (
                    <li key={c.id}>
                      <Link
                        href={`/economy/nation/${c.iso2.toLowerCase()}`}
                        style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          justifyContent: 'space-between',
                          gap: space[8],
                          padding: `${space[8]}px ${space[8]}px`,
                          border: `1px solid ${themeColor.separator}`,
                          borderRadius: radius[8],
                          color: themeColor.labelPrimary,
                          fontSize: fontSize[12],
                          textDecoration: 'none',
                        }}
                      >
                        <span style={{ minWidth: 0 }}>{c.name}</span>
                        <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], fontWeight: fontWeight.medium }}>{c.currency} · {c.indicatorCount}</span>
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

/**
 * One country's profile (plan Phase 5) — `/economy/nation/[country]`.
 *
 * Layout: key metrics, then a block per taxonomy category, then the latest
 * releases. Every category block is a real group of the country's own series, so
 * the page is an aggregator over the registry rather than a hand-picked list.
 */

export function NationProfile({ code }: { code: string }) {
  const [data, setData] = useState<CountryEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchCountry(code, ac.signal)
      .then((d) => !ac.signal.aborted && setData(d))
      .catch((e) => !ac.signal.aborted && setError(e instanceof Error ? e.message : String(e)));
    return () => ac.abort();
  }, [code]);

  if (error) {
    return (
      <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
        <ErrorState title="Could not load this country" detail={error} />
        <p style={{ marginTop: space[12] }}><Link href="/economy/nation" style={{ color: themeColor.blue }}>← all nations</Link></p>
      </main>
    );
  }
  if (!data) {
    return (
      <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
        <Loading what="country profile" />
      </main>
    );
  }

  const c = data.country;

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
      <PageHeader
        title={c.name}
        description={`${c.iso3} · ${c.region} · ${c.currency}${c.timezone ? ` · ${c.timezone}` : ''} — ${c.indicatorCount} series, read from their own upstreams and normalised to one model.`}
        nav={ECONOMY_NAV}
      />

      <Card title="Key Metrics" subtitle="headline series, newest published observation">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(150px, 100%), 1fr))', gap: space[12] }}>
          {data.keyMetrics.map((m) => (
            <Link key={m.slug} href={`/economy/indicator/${m.slug}`} style={{ textDecoration: 'none' }}>
              <Value label={m.label.replace(`${c.name} `, '')} value={m.value === null ? NO_VALUE : formatValue(m.value, m.decimals)} tone={m.value === null ? 'muted' : 'default'} unit={m.value === null ? undefined : m.unit} hint={`${m.date ?? 'no observation'} · ${m.source}`} />
            </Link>
          ))}
        </div>
      </Card>

      <RegimeBoard country={c.iso3} embedded />

      <div style={{ display: 'grid', gap: space[12], gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', marginTop: space[12] }}>
        {data.groups.map((g) => (
          <Card key={g.category} title={g.label}>
            <DataTable
              head={['Indicator', 'Value', 'Date', 'Δ prior']}
              rows={g.rows.map((r) => ({
                href: `/economy/indicator/${r.slug}`,
                cells: [
                  r.label.replace(`${c.name} `, ''),
                  <span key="v" style={{ color: r.value === null ? themeColor.labelTertiary : themeColor.labelPrimary }}>{r.value === null ? '—' : `${formatValue(r.value, r.decimals)}${r.unit ? ` ${r.unit}` : ''}`}</span>,
                  <span key="d" style={{ color: themeColor.labelTertiary }}>{formatDate(r.date)}</span>,
                  <span key="p" style={{ color: themeColor.labelTertiary }}>{r.previous === null || r.value === null ? '—' : formatDelta(r.value - r.previous, r.decimals)}</span>,
                ],
              }))}
            />
          </Card>
        ))}
      </div>

      {data.releases.length > 0 && (
        <div style={{ marginTop: space[12] }}>
          <Card title="Latest Releases" subtitle="reference periods, newest first — no consensus is published by these sources, so none is shown">
            <DataTable
              head={['Indicator', 'Period', 'Actual', 'Previous', 'Imp.']}
              rows={data.releases.map((r) => ({
                href: `/economy/indicator/${r.slug}`,
                cells: [
                  r.label,
                  <span key="d" style={{ color: themeColor.labelTertiary }}>{formatDate(r.releaseAt)}</span>,
                  <span key="a">{r.actual === null ? '—' : formatValue(r.actual, 2)}</span>,
                  <span key="p" style={{ color: themeColor.labelTertiary }}>{r.previous === null ? '—' : formatValue(r.previous, 2)}</span>,
                  <ImportanceDots key="i" level={r.importance} />,
                ],
              }))}
            />
          </Card>
        </div>
      )}

      {data.failed.length > 0 && (
        <div style={{ marginTop: space[12] }}>
          <ErrorState title={`${data.failed.length} series could not be read`} detail={data.failed.map((f) => `${f.symbol}: ${f.reason}`).join(' · ')} />
        </div>
      )}

      <p style={{ marginTop: space[16], fontSize: fontSize[11], color: themeColor.labelTertiary }}>
        <strong style={{ color: themeColor.labelTertiary, fontWeight: fontWeight.medium }}>Sources:</strong> {data.upstream.join(' · ')}
      </p>
      <p style={{ marginTop: space[8], fontSize: fontSize[11], color: themeColor.labelTertiary }}>{data.derived}</p>
    </main>
  );
}

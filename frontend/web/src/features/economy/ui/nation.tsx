'use client';

/**
 * One country's profile (plan Phase 5) — `/economy/nation/[country]`.
 *
 * Layout: key metrics, then a block per taxonomy category, then the latest
 * releases. Every category block is a real group of the country's own series, so
 * the page is an aggregator over the registry rather than a hand-picked list.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { color, fontSize, fontWeight, space } from '@/styles/tokens';
import { fetchCountry, formatDate, formatDelta, formatValue, type CountryEnvelope } from '@/features/economy/client';
import { Card, DataTable, ECONOMY_NAV, ErrorState, ImportanceDots, Loading, PageHeader, Value } from '@/features/economy/ui/parts';
import RegimeBoard from '@/features/economy/ui/regime';

export default function NationProfile({ code }: { code: string }) {
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
        <p style={{ marginTop: space[12] }}><Link href="/economy/nation" style={{ color: color.accent }}>← all nations</Link></p>
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: space[14] }}>
          {data.keyMetrics.map((m) => (
            <Link key={m.slug} href={`/economy/indicator/${m.slug}`} style={{ textDecoration: 'none' }}>
              <Value label={m.label.replace(`${c.name} `, '')} value={m.value} decimals={m.decimals} unit={m.unit} hint={`${m.date ?? 'no observation'} · ${m.source}`} />
            </Link>
          ))}
        </div>
      </Card>

      <RegimeBoard country={c.iso3} embedded />

      <div style={{ display: 'grid', gap: space[14], gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', marginTop: space[14] }}>
        {data.groups.map((g) => (
          <Card key={g.category} title={g.label}>
            <DataTable
              head={['Indicator', 'Value', 'Date', 'Δ prior']}
              rows={g.rows.map((r) => ({
                href: `/economy/indicator/${r.slug}`,
                cells: [
                  r.label.replace(`${c.name} `, ''),
                  <span key="v" style={{ color: r.value === null ? color.textMuted : color.text }}>{r.value === null ? '—' : `${formatValue(r.value, r.decimals)}${r.unit ? ` ${r.unit}` : ''}`}</span>,
                  <span key="d" style={{ color: color.textMuted }}>{formatDate(r.date)}</span>,
                  <span key="p" style={{ color: color.textMuted }}>{r.previous === null || r.value === null ? '—' : formatDelta(r.value - r.previous, r.decimals)}</span>,
                ],
              }))}
            />
          </Card>
        ))}
      </div>

      {data.releases.length > 0 && (
        <div style={{ marginTop: space[14] }}>
          <Card title="Latest Releases" subtitle="reference periods, newest first — no consensus is published by these sources, so none is shown">
            <DataTable
              head={['Indicator', 'Period', 'Actual', 'Previous', 'Imp.']}
              rows={data.releases.map((r) => ({
                href: `/economy/indicator/${r.slug}`,
                cells: [
                  r.label,
                  <span key="d" style={{ color: color.textMuted }}>{formatDate(r.releaseAt)}</span>,
                  <span key="a">{r.actual === null ? '—' : formatValue(r.actual, 2)}</span>,
                  <span key="p" style={{ color: color.textMuted }}>{r.previous === null ? '—' : formatValue(r.previous, 2)}</span>,
                  <ImportanceDots key="i" level={r.importance} />,
                ],
              }))}
            />
          </Card>
        </div>
      )}

      {data.failed.length > 0 && (
        <div style={{ marginTop: space[14] }}>
          <ErrorState title={`${data.failed.length} series could not be read`} detail={data.failed.map((f) => `${f.symbol}: ${f.reason}`).join(' · ')} />
        </div>
      )}

      <p style={{ marginTop: space[16], fontSize: fontSize[11], color: color.textMuted }}>
        <strong style={{ color: color.textMuted, fontWeight: fontWeight.medium }}>Sources:</strong> {data.upstream.join(' · ')}
      </p>
      <p style={{ marginTop: space[6], fontSize: fontSize[11], color: color.textMuted }}>{data.derived}</p>
    </main>
  );
}

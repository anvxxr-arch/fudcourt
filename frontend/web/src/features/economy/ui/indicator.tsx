'use client';

/**
 * One canonical series (plan Phase 6) — `/economy/indicator/[indicator]`.
 *
 * The chart is drawn from the OBSERVATIONS themselves, one point per published
 * period, with gaps left as gaps: a monthly series with a missing month is not
 * interpolated across, because a line drawn through a hole asserts a value that
 * was never published.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { color, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { fetchIndicator, formatDate, formatDelta, formatValue, type IndicatorEnvelope } from '@/features/economy/client';
import { Card, DataTable, ECONOMY_NAV, ErrorState, ImportanceDots, Loading, PageHeader, Value } from '@/features/economy/ui/parts';

const W = 720;
const H = 200;

function Chart({ points }: { points: { date: string; value: number | null }[] }) {
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null && Number.isFinite(v));
  if (vals.length < 2) return <p style={{ color: color.textMuted, fontSize: fontSize[12] }}>Not enough published observations to chart.</p>;
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
      <svg width={W} height={H + 22} role="img" aria-label="series history">
        {segments.map((d, i) => <path key={i} d={d} fill="none" stroke={color.accent} strokeWidth={1.6} />)}
        <text x={0} y={H + 16} fill={color.textMuted} fontSize={10}>{points[0]?.date}</text>
        <text x={W} y={H + 16} fill={color.textMuted} fontSize={10} textAnchor="end">{points[points.length - 1]?.date}</text>
        <text x={0} y={10} fill={color.textMuted} fontSize={10}>{formatValue(max, 2)}</text>
        <text x={0} y={H} fill={color.textMuted} fontSize={10}>{formatValue(min, 2)}</text>
      </svg>
    </div>
  );
}

export default function IndicatorDetail({ slug }: { slug: string }) {
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
        <ErrorState title="Could not load this indicator" detail={error} />
        <p style={{ marginTop: space[12] }}><Link href="/economy/indicator" style={{ color: color.accent }}>← all indicators</Link></p>
      </main>
    );
  }
  if (!data) {
    return <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}><Loading what="indicator" /></main>;
  }

  const i = data.indicator;
  const latest = data.latest;
  const change = latest && data.observations.length > 1 ? latest.value - (data.observations[data.observations.length - 2]?.value ?? latest.value) : null;
  const recent = [...data.observations].reverse().slice(0, 24);

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
      <PageHeader
        title={i.name}
        description={`${i.slug} · ${i.category} / ${i.subcategory} · ${i.frequency}${i.seasonalAdjustment === 'NA' ? '' : ` · ${i.seasonalAdjustment}`} · source ${i.source}`}
        nav={ECONOMY_NAV}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: space[14] }}>
        <Card>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: space[12] }}>
            <Value label="Latest" value={latest?.value ?? null} decimals={i.decimals} unit={i.unit} />
            <Value label="Change" value={change} decimals={i.decimals} hint="vs previous observation" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[4] }}>
              <span style={{ fontSize: fontSize[10], color: color.textMuted, textTransform: 'uppercase' }}>Period</span>
              <span style={{ fontSize: fontSize[14], color: color.text }}>{formatDate(latest?.date)}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[4] }}>
              <span style={{ fontSize: fontSize[10], color: color.textMuted, textTransform: 'uppercase' }}>Importance</span>
              <span><ImportanceDots level={i.importance} /></span>
            </div>
          </div>
          <p style={{ margin: `${space[12]}px 0 0`, fontSize: fontSize[12], color: color.textMuted }}>{i.note}</p>
        </Card>

        <Card title="History" subtitle={`${data.observations.length} published observations`}>
          <Chart points={data.observations} />
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: space[14], marginTop: space[14] }}>
        <Card title="Recent observations" subtitle="newest first">
          <DataTable
            head={['Period', 'Value', 'Δ prior']}
            rows={recent.map((o) => ({
              cells: [
                formatDate(o.date),
                <span key="v">{o.value === null ? '—' : formatValue(o.value, i.decimals)}</span>,
                <span key="d" style={{ color: color.textMuted }}>{o.previous === null || o.value === null ? '—' : formatDelta(o.value - o.previous, i.decimals)}</span>,
              ],
            }))}
          />
        </Card>

        <Card title="Release" subtitle="derived from the series itself — no forward schedule or consensus is published by these sources">
          <DataTable
            head={['Field', 'Value']}
            rows={[
              { cells: ['Reference period', formatDate(data.release?.releaseAt ?? null)] },
              { cells: ['Actual', data.release?.actual === null || data.release?.actual === undefined ? '—' : formatValue(data.release.actual, i.decimals)] },
              { cells: ['Previous', data.release?.previous === null || data.release?.previous === undefined ? '—' : formatValue(data.release.previous, i.decimals)] },
              { cells: ['Forecast', <span key="f" style={{ color: color.textMuted }}>— (not published)</span>] },
            ]}
          />
        </Card>
      </div>

      {data.related.length > 0 && (
        <div style={{ marginTop: space[14] }}>
          <Card title="Related" subtitle="same category for this country, then the same series elsewhere">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[6] }}>
              {data.related.map((r) => (
                <Link key={r.slug} href={`/economy/indicator/${r.slug}`} style={{ padding: `${space[4]}px ${space[8]}px`, border: `1px solid ${color.border}`, borderRadius: radius[6], color: color.text, fontSize: fontSize[11], textDecoration: 'none' }}>
                  {r.countryName ? `${r.countryName} · ` : ''}{r.subcategory}
                </Link>
              ))}
            </div>
          </Card>
        </div>
      )}

      <p style={{ marginTop: space[16], fontSize: fontSize[11], color: color.textMuted }}>
        <strong style={{ fontWeight: fontWeight.medium }}>Upstream:</strong> {data.upstream.join(' · ')}
      </p>
      <p style={{ marginTop: space[6], fontSize: fontSize[11], color: color.textMuted }}>{data.derived}</p>
    </main>
  );
}

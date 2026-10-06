'use client';

/**
 * The macro regime board (plan Phase 13, stages 16–17) — `/economy/regime`, and
 * embedded on a country profile when a `country` is given.
 *
 * WHAT THIS PAGE MUST NOT DO. It must never render a confident label over a
 * dimension it could not read. When a series is missing the row says so and the
 * regime states why no rule fired, because "the upstream is quiet" and "this
 * economy is steady" are different claims and only one of them is true. For the
 * same reason the direction glyph is coloured by DIRECTION, never by whether the
 * move is good news: inflation rising and inflation falling are both "up" and
 * "down", and colouring by desirability would editorialise the data.
 *
 * The asset table is a weight table, not a forecast, and the page says so in the
 * subtitle and the footer — every contribution is shown so the sum can be
 * audited rather than trusted.
 */
import { useEffect, useState } from 'react';
import { color, fontSize, fontWeight, lineHeight, radius, space } from '@/styles/tokens';
import { fetchRegime, formatDate, formatValue, type RegimeEnvelope } from '@/features/economy/model';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { ECONOMY_NAV } from '@/features/economy/nav';
import { ErrorState } from '@/ui/feedback';
import { Loading } from '@/ui/feedback';
import { PageHeader } from '@/ui/page-header';

const ARROW: Record<string, string> = { up: '↑', down: '↓', flat: '→' };
const ARROW_COLOR: Record<string, string> = { up: color.blue, down: color.orange, flat: color.labelTertiary };
const STANCE_COLOR: Record<string, string> = {
  'strongly bullish': color.green,
  bullish: color.green,
  neutral: color.labelTertiary,
  bearish: color.red,
  'strongly bearish': color.red,
};
const CONFIDENCE_COLOR: Record<string, string> = { high: color.green, medium: color.orange, low: color.red };

export default function RegimeBoard({ country, embedded = false }: { country?: string; embedded?: boolean }) {
  const [data, setData] = useState<RegimeEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setData(null);
    setError(null);
    fetchRegime(country, ac.signal)
      .then((d) => !ac.signal.aborted && setData(d))
      .catch((e) => !ac.signal.aborted && setError(e instanceof Error ? e.message : String(e)));
    return () => ac.abort();
  }, [country]);

  const pad = { maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` };

  if (error) {
    return embedded ? (
      <ErrorState title="Could not load the macro regime" detail={error} />
    ) : (
      <main style={pad}>
        <ErrorState title="Could not load the macro regime" detail={error} />
      </main>
    );
  }
  if (!data) {
    return embedded ? <Loading what="regime" /> : <main style={pad}><Loading what="regime" /></main>;
  }

  const label = data.subject;
  const body = (
    <>
      {data.regime ? (
        <Card title={data.regime.label} subtitle={`${label} · evidence confidence: ${data.confidence}`}>
          <p style={{ margin: 0, fontSize: fontSize[15], color: color.labelPrimary, lineHeight: lineHeight.normal }}>{data.regime.summary}</p>
          <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[12], color: color.labelTertiary, lineHeight: lineHeight.normal }}>{data.narrative}</p>
        </Card>
      ) : (
        <Card title="No regime stated" subtitle={`${label} · evidence confidence: ${data.confidence}`}>
          <p style={{ margin: 0, fontSize: fontSize[15], color: color.orange, lineHeight: lineHeight.normal }}>{data.regimeReason}</p>
          <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[12], color: color.labelTertiary, lineHeight: lineHeight.normal }}>{data.narrative}</p>
        </Card>
      )}

      <div style={{ marginTop: space[12] }}>
        <Card title="Dimensions" subtitle="direction is declared only past each series' own noise floor">
          <DataTable
            head={['Dimension', 'Reading', 'Latest', 'Compared with', 'Change', 'Signal / noise', 'Series']}
            rows={data.dimensions.map((d) => {
              const dir = d.trend?.direction ?? 'flat';
              const readable = d.trend !== null;
              return {
                cells: [
                  <span key="l" style={{ fontWeight: fontWeight.semibold }}>{d.label}</span>,
                  readable ? (
                    <span key="w">
                      <span style={{ color: ARROW_COLOR[dir], marginRight: space[8] }}>{ARROW[dir]}</span>
                      {d.word}
                    </span>
                  ) : (
                    <span key="w" style={{ color: color.labelTertiary }} title={d.reason ?? undefined}>— not readable</span>
                  ),
                  <span key="v" style={{ color: readable ? color.labelPrimary : color.labelTertiary }}>
                    {d.latest ? `${formatValue(d.latest.value, d.decimals)} ${d.unit}` : '—'}
                  </span>,
                  <span key="p" style={{ color: color.labelTertiary }}>
                    {d.prior ? `${formatValue(d.prior.value, d.decimals)} ${d.unit}` : '—'}
                    {d.prior?.date ? ` · ${formatDate(d.prior.date)}` : ''}
                  </span>,
                  <span key="c" style={{ color: readable ? ARROW_COLOR[dir] : color.labelTertiary }}>
                    {d.trend ? `${d.trend.change > 0 ? '+' : ''}${formatValue(d.trend.change, d.decimals)}` : '—'}
                  </span>,
                  <span key="s" style={{ color: color.labelTertiary }}>
                    {d.trend ? `${d.trend.strength.toFixed(2)}× (noise ${d.trend.noise.toPrecision(2)})` : '—'}
                  </span>,
                  <span key="slug" style={{ color: color.labelTertiary }}>{d.series || '—'}</span>,
                ],
              };
            })}
          />
          <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: color.labelTertiary, lineHeight: lineHeight.normal }}>
            A dimension is read only when its series published at least four observations. A move smaller than the
            series&apos; own period-to-period variation is reported as steady, so rounding noise cannot flip a regime.
          </p>
        </Card>
      </div>

      {data.missing.length > 0 && (
        <div style={{ marginTop: space[12] }}>
          <ErrorState
            title={`${data.missing.length} dimension(s) could not be read`}
            detail={`${data.missing.join(', ')} — no rule that needs them can fire, and they are left blank rather than filled in.`}
          />
        </div>
      )}

      <div style={{ marginTop: space[12] }}>
        <Card title="Potential market impact" subtitle="a stated weight table over the readings above — not a forecast">
          <DataTable
            head={['Asset', 'Stance', 'Score', 'Contributions']}
            rows={data.impacts.map((i) => ({
              cells: [
                <span key="a" style={{ fontWeight: fontWeight.semibold }}>{i.label}</span>,
                <span key="s" style={{ color: STANCE_COLOR[i.stance] ?? color.labelTertiary, fontWeight: fontWeight.semibold }}>{i.stance}</span>,
                <span key="sc" style={{ color: i.score > 0 ? color.green : i.score < 0 ? color.red : color.labelTertiary }}>
                  {i.score > 0 ? '+' : ''}{i.score.toFixed(2)}
                </span>,
                <span key="c" style={{ color: color.labelTertiary }}>
                  {i.contributions.length === 0
                    ? '— no dimension is moving in a scored direction'
                    : i.contributions.map((c) => `${c.dimension} ${c.word} ${c.weight > 0 ? '+' : ''}${c.weight}`).join(' · ')}
                </span>,
              ],
            }))}
          />
          <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: color.labelTertiary, lineHeight: lineHeight.normal }}>
            Weights encode the conventional transmission channel — liquidity and policy dominate risk assets, inflation
            dominates duration, a stronger dollar tightens global conditions. Every contribution is listed so the sum can
            be audited.
          </p>
        </Card>
      </div>

      {data.failed.length > 0 && (
        <div style={{ marginTop: space[12] }}>
          <ErrorState
            title={`${data.failed.length} upstream item(s) failed`}
            detail={data.failed.map((f) => `${f.symbol}: ${f.reason}`).join(' · ')}
          />
        </div>
      )}

      <p style={{ marginTop: space[16], fontSize: fontSize[11], color: color.labelTertiary, lineHeight: lineHeight.normal }}>{data.derived}</p>
      <p style={{ marginTop: space[8], fontSize: fontSize[11], color: color.labelTertiary, lineHeight: lineHeight.normal }}>
        Sources: {data.upstream.join(' · ')} · read {formatDate(new Date(data.asOf * 1000).toISOString().slice(0, 10))}
      </p>
    </>
  );

  if (embedded) {
    return (
      <div style={{ marginTop: space[12] }}>
        <h2 style={{ margin: `0 0 ${space[8]}px`, fontSize: fontSize[20], fontWeight: fontWeight.semibold, color: color.labelPrimary }}>
          Macro regime
        </h2>
        {body}
      </div>
    );
  }

  return (
    <main style={pad}>
      <PageHeader
        title={`Macro Regime${data.scope.kind === 'country' ? ` — ${data.subject}` : ''}`}
        description="Growth, inflation, labor, liquidity and policy read from published observations, matched against an explicit rule table. The backend computes; nothing here is inferred from a headline."
        nav={ECONOMY_NAV}
      />
      {body}
      <div style={{ marginTop: space[12], display: 'flex', gap: space[8] }}>
        <span style={{ fontSize: fontSize[11], color: color.labelTertiary }}>
          Confidence:{' '}
          <span style={{ color: CONFIDENCE_COLOR[data.confidence] ?? color.labelTertiary, fontWeight: fontWeight.semibold }}>
            {data.confidence}
          </span>{' '}
          — evidence confidence, not a probability that the regime is correct.
        </span>
      </div>
    </main>
  );
}

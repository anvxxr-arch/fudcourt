'use client';

/**
 * The Global Macro Dashboard (plan Phase 4) — `/economy`.
 *
 * WHY IT REUSES THE OTHER ROUTES. The dashboard fetches `compare`,
 * `central-banks`, `liquidity` and `calendar` rather than a bespoke
 * `/api/economy/dashboard` endpoint. A dashboard that reads its own private
 * aggregate is a second source of truth for numbers the other pages already
 * serve, and the two drift the first time one is changed. Composing the same
 * public endpoints means the dashboard can never show a value its own detail
 * page would contradict.
 *
 * Each panel is independent: one upstream failing empties its panel with a named
 * error and leaves the rest of the page intact.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { color, fontSize, fontWeight, letterSpacing, lineHeight, radius, space } from '@/styles/tokens';
import {
  fetchCalendar,
  fetchCentralBanks,
  fetchCompare,
  fetchLiquidity,
  fetchRegime,
  formatDate,
  formatValue,
  type CalendarEnvelope,
  type CentralBanksEnvelope,
  type CompareEnvelope,
  type LiquidityEnvelope,
  type RegimeEnvelope,
} from '@/features/economy/model';
import { Card } from '@/ui/card';
import { ECONOMY_NAV } from '@/features/economy/nav';
import { ErrorState } from '@/ui/feedback';
import { ImportanceDots } from '@/features/economy/ui/importance-dots';
import { Loading } from '@/ui/feedback';
import { PageHeader } from '@/ui/page-header';
import { Sparkline } from '@/ui/sparkline';

/** The pulse is a curated cross-country basket, not "every indicator". */
const PULSE = ['us-gdp', 'us-cpi', 'us-core-cpi', 'us-unemployment', 'us-m2', 'us-policy-rate', 'xm-policy-rate'] as const;

/** The majors the board leads with, in display order. */
const MAJORS = [
  { iso2: 'us', name: 'United States' },
  { iso2: 'cn', name: 'China' },
  { iso2: 'de', name: 'Germany' },
  { iso2: 'jp', name: 'Japan' },
  { iso2: 'in', name: 'India' },
  { iso2: 'id', name: 'Indonesia' },
] as const;

const FEATURED_BANKS = ['fed', 'ecb', 'boj', 'boe', 'bi'] as const;

type State = {
  pulse: CompareEnvelope | null;
  banks: CentralBanksEnvelope | null;
  liquidity: LiquidityEnvelope | null;
  calendar: CalendarEnvelope | null;
  regime: RegimeEnvelope | null;
  errors: string[];
};

export default function EconomyDashboard() {
  const [state, setState] = useState<State>({ pulse: null, banks: null, liquidity: null, calendar: null, regime: null, errors: [] });

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      const errors: string[] = [];
      const [pulse, banks, liquidity, calendar, regime] = await Promise.all([
        fetchCompare(PULSE, '1y', ac.signal).catch((e) => {
          errors.push(`macro pulse: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        }),
        fetchCentralBanks(ac.signal).catch((e) => {
          errors.push(`central banks: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        }),
        fetchLiquidity(ac.signal).catch((e) => {
          errors.push(`liquidity: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        }),
        fetchCalendar({}, ac.signal).catch((e) => {
          errors.push(`calendar: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        }),
        fetchRegime(undefined, ac.signal).catch((e) => {
          errors.push(`regime: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        }),
      ]);
      if (!ac.signal.aborted) setState({ pulse, banks, liquidity, calendar, regime, errors });
    })();
    return () => ac.abort();
  }, []);

  const { pulse, banks, liquidity, calendar, regime, errors } = state;

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
      <PageHeader
        title="Global Macro Dashboard"
        description="Canonical economic series across growth, inflation, labour, money and policy — read from FRED, the World Bank and BIS, normalised to one model so a monthly US print and an annual World Bank print are never compared as if they were the same measurement."
        nav={ECONOMY_NAV}
      />

      {errors.length > 0 && (
        <div style={{ marginBottom: space[12] }}>
          {errors.map((e) => (
            <ErrorState key={e} title="Panel unavailable" detail={e} />
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gap: space[12], gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <Card title="Macro Regime" subtitle="rule table over published readings — not a forecast">
          {!regime ? (
            <Loading what="regime" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
              {regime.regime ? (
                <>
                  <div style={{ fontSize: fontSize[20], fontWeight: fontWeight.bold, color: color.labelPrimary }}>{regime.regime.label}</div>
                  <div style={{ fontSize: fontSize[11], color: color.labelTertiary }}>
                    evidence confidence: <span style={{ color: regime.confidence === 'high' ? color.green : regime.confidence === 'medium' ? color.orange : color.red }}>{regime.confidence}</span>
                    {regime.missing.length > 0 ? ` · ${regime.missing.length} dimension(s) unreadable` : ''}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: fontSize[15], fontWeight: fontWeight.semibold, color: color.orange }}>No regime stated</div>
                  <div style={{ fontSize: fontSize[11], color: color.labelTertiary, lineHeight: lineHeight.normal }}>{regime.regimeReason}</div>
                </>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
                {regime.dimensions.map((d) => (
                  <span
                    key={d.id}
                    style={{
                      padding: `${space[4]}px ${space[8]}px`,
                      border: `1px solid ${color.separator}`,
                      borderRadius: radius[8],
                      fontSize: fontSize[11],
                      color: d.word ? color.labelPrimary : color.labelTertiary,
                    }}
                  >
                    {d.label}: {d.word ?? '—'}
                  </span>
                ))}
              </div>
              <Link href="/economy/regime" style={{ fontSize: fontSize[11], color: color.blue, textDecoration: 'none' }}>full regime board →</Link>
            </div>
          )}
        </Card>

        <Card title="Global Macro Pulse" subtitle="latest observation of a curated basket; sparkline is the last year">
          {!pulse ? (
            <Loading what="macro pulse" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
              {pulse.series.map((s) => {
                const pts = s.points.map((p) => p.value);
                const latest = [...s.points].reverse().find((p) => p.value !== null);
                return (
                  <div key={s.slug} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space[8] }}>
                    <div style={{ minWidth: 0 }}>
                      <Link href={`/economy/indicator/${s.slug}`} style={{ color: color.labelPrimary, textDecoration: 'none', fontSize: fontSize[12] }}>{s.label}</Link>
                      <div style={{ fontSize: fontSize[11], color: color.labelTertiary }}>{latest ? formatDate(latest.date) : '—'} · {s.frequency}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: space[8] }}>
                      <Sparkline points={pts} />
                      <span style={{ fontSize: fontSize[15], fontWeight: fontWeight.semibold, color: color.labelPrimary, minWidth: 56, textAlign: 'right' }}>
                        {latest ? formatValue(latest.value, s.decimals) : '—'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card title="Global Liquidity" subtitle="derived position in a curated basket of real liquidity series">
          {!liquidity ? (
            <Loading what="liquidity" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[12] }}>
              {liquidity.index && (
                <div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: space[8] }}>
                    <span style={{ fontSize: fontSize[28], fontWeight: fontWeight.bold, color: color.labelPrimary }}>{liquidity.index.value}</span>
                    <span style={{ fontSize: fontSize[12], color: liquidity.index.trend === 'Expanding' ? color.green : liquidity.index.trend === 'Contracting' ? color.red : color.orange }}>
                      {liquidity.index.trend}
                    </span>
                  </div>
                  <div style={{ height: 6, background: color.separator, borderRadius: radius[8], marginTop: space[8] }}>
                    <div style={{ width: `${liquidity.index.value}%`, height: '100%', background: color.blue, borderRadius: radius[8] }} />
                  </div>
                  <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: color.labelTertiary }}>share of {liquidity.index.components} live components moving looser · 0–100, derived</p>
                </div>
              )}
              {liquidity.components.slice(0, 4).map((c) => (
                <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: fontSize[11], color: color.labelTertiary }}>
                  <span>{c.label}</span>
                  <span style={{ color: color.labelPrimary }}>{c.change === null ? '—' : `${c.change > 0 ? '+' : ''}${formatValue(c.change, 1)}`}</span>
                </div>
              ))}
              <Link href="/economy/liquidity" style={{ fontSize: fontSize[11], color: color.blue, textDecoration: 'none' }}>full liquidity board →</Link>
            </div>
          )}
        </Card>

        <Card title="Central Banks" subtitle="policy rate, latest BIS observation">
          {!banks ? (
            <Loading what="central banks" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
              {FEATURED_BANKS.map((slug) => {
                const b = banks.banks.find((x) => x.slug === slug);
                if (!b) return null;
                return (
                  <div key={slug} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Link href={`/economy/central-bank/${slug}`} style={{ color: color.labelPrimary, textDecoration: 'none', fontSize: fontSize[12] }}>{b.short}</Link>
                    <span style={{ fontSize: fontSize[13], fontWeight: fontWeight.semibold, color: b.rate === null ? color.labelTertiary : color.labelPrimary }}>
                      {b.rate === null ? '—' : `${formatValue(b.rate, 2)}%`}
                    </span>
                  </div>
                );
              })}
              <Link href="/economy/central-bank" style={{ fontSize: fontSize[11], color: color.blue, textDecoration: 'none' }}>all {banks.banks.length} banks →</Link>
            </div>
          )}
        </Card>

        <Card title="Major Economies" subtitle="country profiles — the aggregator for every series we hold">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: space[8] }}>
            {MAJORS.map((m) => (
              <Link key={m.iso2} href={`/economy/nation/${m.iso2}`} style={{ padding: `${space[8]}px ${space[8]}px`, border: `1px solid ${color.separator}`, borderRadius: radius[8], color: color.labelPrimary, fontSize: fontSize[12], textDecoration: 'none' }}>
                {m.name}
              </Link>
            ))}
          </div>
          <Link href="/economy/nation" style={{ display: 'inline-block', marginTop: space[8], fontSize: fontSize[11], color: color.blue, textDecoration: 'none' }}>all countries →</Link>
        </Card>

        <Card title="Recent Releases" subtitle="reference periods, newest first — a release log, not a forward schedule">
          {!calendar ? (
            <Loading what="releases" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
              {calendar.events.slice(0, 8).map((e, i) => (
                <div key={`${e.slug}-${i}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space[8] }}>
                  <div style={{ minWidth: 0 }}>
                    <Link href={`/economy/indicator/${e.slug}`} style={{ color: color.labelPrimary, textDecoration: 'none', fontSize: fontSize[11] }}>{e.label}</Link>
                    <div style={{ fontSize: fontSize[11], color: color.labelTertiary }}>{formatDate(e.releaseAt)}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: space[8] }}>
                    <ImportanceDots level={e.importance} />
                    <span style={{ fontSize: fontSize[12], color: color.labelPrimary }}>{e.actual === null ? '—' : formatValue(e.actual, 2)}</span>
                  </div>
                </div>
              ))}
              <Link href="/economy/calendar" style={{ fontSize: fontSize[11], color: color.blue, textDecoration: 'none' }}>full calendar →</Link>
            </div>
          )}
        </Card>
      </div>

      <p style={{ marginTop: space[16], fontSize: fontSize[11], color: color.labelTertiary, lineHeight: lineHeight.normal, letterSpacing: letterSpacing.xs }}>
        Every value is a published observation, never a model estimate. A series the upstream did not publish renders “—” rather than zero, and the liquidity index is a derived position in this module’s own basket, not an official gauge.
      </p>
    </main>
  );
}

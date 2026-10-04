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
} from '@/features/economy/client';
import { Card, ECONOMY_NAV, ErrorState, ImportanceDots, Loading, PageHeader, Sparkline, Value } from '@/features/economy/ui/parts';

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
        <div style={{ marginBottom: space[14] }}>
          {errors.map((e) => (
            <ErrorState key={e} title="Panel unavailable" detail={e} />
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gap: space[14], gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <Card title="Macro Regime" subtitle="rule table over published readings — not a forecast">
          {!regime ? (
            <Loading what="regime" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[10] }}>
              {regime.regime ? (
                <>
                  <div style={{ fontSize: fontSize[20], fontWeight: fontWeight.bold, color: color.text }}>{regime.regime.label}</div>
                  <div style={{ fontSize: fontSize[11], color: color.textMuted }}>
                    evidence confidence: <span style={{ color: regime.confidence === 'high' ? color.positive : regime.confidence === 'medium' ? color.warn : color.negative }}>{regime.confidence}</span>
                    {regime.missing.length > 0 ? ` · ${regime.missing.length} dimension(s) unreadable` : ''}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: fontSize[14], fontWeight: fontWeight.semibold, color: color.warn }}>No regime stated</div>
                  <div style={{ fontSize: fontSize[11], color: color.textMuted, lineHeight: lineHeight.normal }}>{regime.regimeReason}</div>
                </>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[6] }}>
                {regime.dimensions.map((d) => (
                  <span
                    key={d.id}
                    style={{
                      padding: `${space[4]}px ${space[8]}px`,
                      border: `1px solid ${color.border}`,
                      borderRadius: radius[4],
                      fontSize: fontSize[10],
                      color: d.word ? color.text : color.textMuted,
                    }}
                  >
                    {d.label}: {d.word ?? '—'}
                  </span>
                ))}
              </div>
              <Link href="/economy/regime" style={{ fontSize: fontSize[11], color: color.accent, textDecoration: 'none' }}>full regime board →</Link>
            </div>
          )}
        </Card>

        <Card title="Global Macro Pulse" subtitle="latest observation of a curated basket; sparkline is the last year">
          {!pulse ? (
            <Loading what="macro pulse" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[10] }}>
              {pulse.series.map((s) => {
                const pts = s.points.map((p) => p.value);
                const latest = [...s.points].reverse().find((p) => p.value !== null);
                return (
                  <div key={s.slug} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space[10] }}>
                    <div style={{ minWidth: 0 }}>
                      <Link href={`/economy/indicator/${s.slug}`} style={{ color: color.text, textDecoration: 'none', fontSize: fontSize[12] }}>{s.label}</Link>
                      <div style={{ fontSize: fontSize[10], color: color.textMuted }}>{latest ? formatDate(latest.date) : '—'} · {s.frequency}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: space[10] }}>
                      <Sparkline points={pts} />
                      <span style={{ fontSize: fontSize[14], fontWeight: fontWeight.semibold, color: color.text, minWidth: 56, textAlign: 'right' }}>
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
                    <span style={{ fontSize: fontSize[32], fontWeight: fontWeight.bold, color: color.text }}>{liquidity.index.value}</span>
                    <span style={{ fontSize: fontSize[12], color: liquidity.index.trend === 'Expanding' ? color.positive : liquidity.index.trend === 'Contracting' ? color.negative : color.warn }}>
                      {liquidity.index.trend}
                    </span>
                  </div>
                  <div style={{ height: 6, background: color.border, borderRadius: radius[4], marginTop: space[6] }}>
                    <div style={{ width: `${liquidity.index.value}%`, height: '100%', background: color.accent, borderRadius: radius[4] }} />
                  </div>
                  <p style={{ margin: `${space[6]}px 0 0`, fontSize: fontSize[10], color: color.textMuted }}>share of {liquidity.index.components} live components moving looser · 0–100, derived</p>
                </div>
              )}
              {liquidity.components.slice(0, 4).map((c) => (
                <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: fontSize[11], color: color.textMuted }}>
                  <span>{c.label}</span>
                  <span style={{ color: color.text }}>{c.change === null ? '—' : `${c.change > 0 ? '+' : ''}${formatValue(c.change, 1)}`}</span>
                </div>
              ))}
              <Link href="/economy/liquidity" style={{ fontSize: fontSize[11], color: color.accent, textDecoration: 'none' }}>full liquidity board →</Link>
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
                    <Link href={`/economy/central-bank/${slug}`} style={{ color: color.text, textDecoration: 'none', fontSize: fontSize[12] }}>{b.short}</Link>
                    <span style={{ fontSize: fontSize[13], fontWeight: fontWeight.semibold, color: b.rate === null ? color.textMuted : color.text }}>
                      {b.rate === null ? '—' : `${formatValue(b.rate, 2)}%`}
                    </span>
                  </div>
                );
              })}
              <Link href="/economy/central-bank" style={{ fontSize: fontSize[11], color: color.accent, textDecoration: 'none' }}>all {banks.banks.length} banks →</Link>
            </div>
          )}
        </Card>

        <Card title="Major Economies" subtitle="country profiles — the aggregator for every series we hold">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: space[6] }}>
            {MAJORS.map((m) => (
              <Link key={m.iso2} href={`/economy/nation/${m.iso2}`} style={{ padding: `${space[8]}px ${space[10]}px`, border: `1px solid ${color.border}`, borderRadius: radius[6], color: color.text, fontSize: fontSize[12], textDecoration: 'none' }}>
                {m.name}
              </Link>
            ))}
          </div>
          <Link href="/economy/nation" style={{ display: 'inline-block', marginTop: space[10], fontSize: fontSize[11], color: color.accent, textDecoration: 'none' }}>all countries →</Link>
        </Card>

        <Card title="Recent Releases" subtitle="reference periods, newest first — a release log, not a forward schedule">
          {!calendar ? (
            <Loading what="releases" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
              {calendar.events.slice(0, 8).map((e, i) => (
                <div key={`${e.slug}-${i}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space[8] }}>
                  <div style={{ minWidth: 0 }}>
                    <Link href={`/economy/indicator/${e.slug}`} style={{ color: color.text, textDecoration: 'none', fontSize: fontSize[11] }}>{e.label}</Link>
                    <div style={{ fontSize: fontSize[10], color: color.textMuted }}>{formatDate(e.releaseAt)}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: space[8] }}>
                    <ImportanceDots level={e.importance} />
                    <span style={{ fontSize: fontSize[12], color: color.text }}>{e.actual === null ? '—' : formatValue(e.actual, 2)}</span>
                  </div>
                </div>
              ))}
              <Link href="/economy/calendar" style={{ fontSize: fontSize[11], color: color.accent, textDecoration: 'none' }}>full calendar →</Link>
            </div>
          )}
        </Card>
      </div>

      <p style={{ marginTop: space[18], fontSize: fontSize[11], color: color.textMuted, lineHeight: lineHeight.normal, letterSpacing: letterSpacing.xs }}>
        Every value is a published observation, never a model estimate. A series the upstream did not publish renders “—” rather than zero, and the liquidity index is a derived position in this module’s own basket, not an official gauge.
      </p>
    </main>
  );
}

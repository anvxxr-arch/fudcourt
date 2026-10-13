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
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/lib/i18n/t';
import { themeColor, fontSize, fontWeight, letterSpacing, lineHeight, radius, space } from '@/styles/tokens';
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
// The pulse basket lives in the client model so the server prerender and this
// fallback read the same list (one source, not a copy).
import { PULSE } from '@/features/economy/model';
import { Card } from '@/ui/card';
import { ECONOMY_NAV } from '@/features/economy/nav';
import { ErrorState } from '@/ui/feedback';
import { ImportanceDots } from '@/features/economy/ui/importance-dots';
import { Loading } from '@/ui/feedback';
import { PageHeader } from '@/ui/page-header';
import { Sparkline } from '@/ui/sparkline';

/** The pulse is a curated cross-country basket, not "every indicator". */

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

/**
 * The boards the server may hand in. A `null` board means the server could not
 * read it (no upstream access at prerender, or that board failed), in which case
 * the dashboard fetches it on the client exactly as it always did.
 */
export type EconomyBoardsProp = {
  pulse: CompareEnvelope | null;
  banks: CentralBanksEnvelope | null;
  liquidity: LiquidityEnvelope | null;
  calendar: CalendarEnvelope | null;
  regime: RegimeEnvelope | null;
};
export default function EconomyDashboard({ initial = null }: { initial?: EconomyBoardsProp | null }) {
  const t = useT();
  const [state, setState] = useState<State>({
    pulse: initial?.pulse ?? null,
    banks: initial?.banks ?? null,
    liquidity: initial?.liquidity ?? null,
    calendar: initial?.calendar ?? null,
    regime: initial?.regime ?? null,
    errors: [],
  });

  // The server hands in the figures so the FIRST paint already carries the real
  // card heights — this is the /economy CLS fix. The prerendered shell used to
  // ship `Loading` placeholders and grow 100px+ per card when the client data
  // landed (measured: Pulse 112px -> 532px, the cards below it moving 136px).
  // Only the boards the server could NOT resolve are fetched here, so a build
  // without upstream access degrades to the old client-only behaviour instead of
  // baking an error page for the whole revalidate window.
  const initialRef = useRef(initial);
  useEffect(() => {
    const seed = initialRef.current;
    const ac = new AbortController();
    (async () => {
      const errors: string[] = [];
      const missing = (v: unknown): boolean => v === null || v === undefined;
      const want: Array<[keyof State, string, () => Promise<unknown>]> = [];
      if (missing(seed?.pulse)) want.push(['pulse', t('economy.errPulse'), () => fetchCompare(PULSE, '1y', ac.signal)]);
      if (missing(seed?.banks)) want.push(['banks', t('economy.errBanks'), () => fetchCentralBanks(ac.signal)]);
      if (missing(seed?.liquidity)) want.push(['liquidity', t('economy.errLiquidity'), () => fetchLiquidity(ac.signal)]);
      if (missing(seed?.calendar)) want.push(['calendar', t('economy.errCalendar'), () => fetchCalendar({}, ac.signal)]);
      if (missing(seed?.regime)) want.push(['regime', t('economy.errRegime'), () => fetchRegime(undefined, ac.signal)]);
      if (want.length === 0) return;
      const results = await Promise.all(
        want.map(async ([key, label, load]) => {
          try {
            return [key, await load()] as const;
          } catch (e) {
            errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
            return [key, undefined] as const;
          }
        })
      );
      if (ac.signal.aborted) return;
      setState((s) => {
        const next: Record<string, unknown> = { ...s, errors };
        for (const [key, value] of results) if (value !== undefined) next[key] = value;
        return next as State;
      });
    })();
    return () => ac.abort();
    // The server value is a build-time constant for the page; re-running on a new
    // object identity would refetch every board, so it is read through a ref and
    // deliberately excluded from the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { pulse, banks, liquidity, calendar, regime, errors } = state;

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
      <PageHeader
        title={t('economy.dashboardTitle')}
        description={t('economy.dashboardDesc')}
        nav={ECONOMY_NAV}
      />

      {errors.length > 0 && (
        <div style={{ marginBottom: space[12] }}>
          {errors.map((e) => (
            <ErrorState key={e} title={t('economy.panelUnavailable')} detail={e} />
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gap: space[12], gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))' }}>
        <Card title={t('economy.regimeSnapshot')} subtitle={t('economy.regimeSnapshotSub')}>
          {!regime ? (
            <Loading what={t('economy.loadingRegime')} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
              {regime.regime ? (
                <>
                  <div style={{ fontSize: fontSize[20], fontWeight: fontWeight.bold, color: themeColor.labelPrimary }}>{regime.regime.label}</div>
                  <div style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>
                    {t('economy.evidenceConfidence')} <span style={{ color: regime.confidence === 'high' ? themeColor.green : regime.confidence === 'medium' ? themeColor.orange : themeColor.red }}>{regime.confidence}</span>
                    {regime.missing.length > 0 ? t('economy.unreadableDims', { n: regime.missing.length }) : ''}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: fontSize[15], fontWeight: fontWeight.semibold, color: themeColor.orange }}>{t('economy.noRegime')}</div>
                  <div style={{ fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>{regime.regimeReason}</div>
                </>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
                {regime.dimensions.map((d) => (
                  <span
                    key={d.id}
                    style={{
                      padding: `${space[4]}px ${space[8]}px`,
                      border: `1px solid ${themeColor.separator}`,
                      borderRadius: radius[8],
                      fontSize: fontSize[11],
                      color: d.word ? themeColor.labelPrimary : themeColor.labelTertiary,
                    }}
                  >
                    {d.label}: {d.word ?? '—'}
                  </span>
                ))}
              </div>
              <Link href="/economy/regime" style={{ fontSize: fontSize[11], color: themeColor.blue, textDecoration: 'none' }}>{t('economy.fullRegimeBoard')}</Link>
            </div>
          )}
        </Card>

        <Card title={t('economy.pulseSnapshot')} subtitle={t('economy.pulseSnapshotSub')}>
          {!pulse ? (
            <Loading what={t('economy.loadingPulse')} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
              {pulse.series.map((s) => {
                const pts = s.points.map((p) => p.value);
                const latest = [...s.points].reverse().find((p) => p.value !== null);
                return (
                  <div key={s.slug} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space[8] }}>
                    <div style={{ minWidth: 0 }}>
                      <Link href={`/economy/indicator/${s.slug}`} style={{ color: themeColor.labelPrimary, textDecoration: 'none', fontSize: fontSize[12] }}>{s.label}</Link>
                      <div style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>{latest ? formatDate(latest.date) : '—'} · {s.frequency}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: space[8] }}>
                      <Sparkline points={pts} />
                      <span style={{ fontSize: fontSize[15], fontWeight: fontWeight.semibold, color: themeColor.labelPrimary, minWidth: 56, textAlign: 'right' }}>
                        {latest ? formatValue(latest.value, s.decimals) : '—'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card title={t('economy.liquiditySnapshot')} subtitle={t('economy.liquiditySnapshotSub')}>
          {!liquidity ? (
            <Loading what={t('economy.loadingLiquidity')} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[12] }}>
              {liquidity.index && (
                <div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: space[8] }}>
                    <span style={{ fontSize: fontSize[28], fontWeight: fontWeight.bold, color: themeColor.labelPrimary }}>{liquidity.index.value}</span>
                    <span style={{ fontSize: fontSize[12], color: liquidity.index.trend === 'Expanding' ? themeColor.green : liquidity.index.trend === 'Contracting' ? themeColor.red : themeColor.orange }}>
                      {liquidity.index.trend}
                    </span>
                  </div>
                  <div style={{ height: 6, background: themeColor.separator, borderRadius: radius[8], marginTop: space[8] }}>
                    <div style={{ width: `${liquidity.index.value}%`, height: '100%', background: themeColor.blue, borderRadius: radius[8] }} />
                  </div>
                  <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary }}>{t('economy.liquidityShareNote', { n: liquidity.index.components })}</p>
                </div>
              )}
              {liquidity.components.slice(0, 4).map((c) => (
                <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: fontSize[11], color: themeColor.labelTertiary }}>
                  <span>{c.label}</span>
                  <span style={{ color: themeColor.labelPrimary }}>{c.change === null ? '—' : `${c.change > 0 ? '+' : ''}${formatValue(c.change, 1)}`}</span>
                </div>
              ))}
              <Link href="/economy/liquidity" style={{ fontSize: fontSize[11], color: themeColor.blue, textDecoration: 'none' }}>{t('economy.fullLiquidityBoard')}</Link>
            </div>
          )}
        </Card>

        <Card title={t('economy.policyRatesSnapshot')} subtitle={t('economy.policyRatesSnapshotSub')}>
          {!banks ? (
            <Loading what={t('economy.loadingBanks')} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
              {FEATURED_BANKS.map((slug) => {
                const b = banks.banks.find((x) => x.slug === slug);
                if (!b) return null;
                return (
                  <div key={slug} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Link href={`/economy/central-bank/${slug}`} style={{ color: themeColor.labelPrimary, textDecoration: 'none', fontSize: fontSize[12] }}>{b.short}</Link>
                    <span style={{ fontSize: fontSize[13], fontWeight: fontWeight.semibold, color: b.rate === null ? themeColor.labelTertiary : themeColor.labelPrimary }}>
                      {b.rate === null ? '—' : `${formatValue(b.rate, 2)}%`}
                    </span>
                  </div>
                );
              })}
              <Link href="/economy/central-bank" style={{ fontSize: fontSize[11], color: themeColor.blue, textDecoration: 'none' }}>{t('economy.allBanks', { n: banks.banks.length })}</Link>
            </div>
          )}
        </Card>

        <Card title={t('economy.majorEconomies')} subtitle={t('economy.majorEconomiesSub')}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(140px, 100%), 1fr))', gap: space[8] }}>
            {MAJORS.map((m) => (
              <Link key={m.iso2} href={`/economy/nation/${m.iso2}`} style={{ padding: `${space[8]}px ${space[8]}px`, border: `1px solid ${themeColor.separator}`, borderRadius: radius[8], color: themeColor.labelPrimary, fontSize: fontSize[12], textDecoration: 'none' }}>
                {m.name}
              </Link>
            ))}
          </div>
          <Link href="/economy/nation" style={{ display: 'inline-block', marginTop: space[8], fontSize: fontSize[11], color: themeColor.blue, textDecoration: 'none' }}>{t('economy.allCountries')}</Link>
        </Card>

        <Card title={t('economy.releaseLogSnapshot')} subtitle={t('economy.releaseLogSnapshotSub')}>
          {!calendar ? (
            <Loading what={t('economy.loadingReleases')} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
              {calendar.events.slice(0, 8).map((e, i) => (
                <div key={`${e.slug}-${i}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space[8] }}>
                  <div style={{ minWidth: 0 }}>
                    <Link href={`/economy/indicator/${e.slug}`} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: themeColor.labelPrimary, textDecoration: 'none', fontSize: fontSize[11] }}>{e.label}</Link>
                    <div style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>{formatDate(e.releaseAt)}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: space[8] }}>
                    <ImportanceDots level={e.importance} />
                    <span style={{ fontSize: fontSize[12], color: themeColor.labelPrimary }}>{e.actual === null ? '—' : formatValue(e.actual, 2)}</span>
                  </div>
                </div>
              ))}
              <Link href="/economy/calendar" style={{ fontSize: fontSize[11], color: themeColor.blue, textDecoration: 'none' }}>{t('economy.fullCalendar')}</Link>
            </div>
          )}
        </Card>
      </div>

      <p style={{ marginTop: space[16], fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal, letterSpacing: letterSpacing.xs }}>
        {t('economy.dashboardFootnote')}
      </p>
    </main>
  );
}

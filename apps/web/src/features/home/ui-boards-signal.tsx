'use client';

import Link from 'next/link';
import { color, fontSize, fontWeight, space } from '@/styles/tokens';
import { Banner } from '@/ui/banner';
import { Meter } from '@/ui/meter';
import { Loading } from '@/ui/feedback';
import {
  CR_HOME_URL,
  DASH,
  MARKETS_TOP_URL,
  NEWS_URL,
  SCOREBOARD_URL,
  fmtNum,
  fmtX,
  type CrHome,
  type MarketsEnvelope,
  type NewsEnvelope,
  type ScoreboardBucket,
  type ScoreboardCatch,
  type ScoreboardPayload,
} from './client';
import { h2Style, h4Style, noteStyle, useJson } from './ui-shared';

/**
 * Signal quality — the cohort scoreboard. `run`/`flat`/`dump` are the UPSTREAM's
 * outcome buckets over the cohort window, not our verdict on a token, so the
 * panel labels them as such rather than implying the board endorses a call.
 */
export function SignalQuality() {
  const { data, error, loading } = useJson<ScoreboardPayload>(SCOREBOARD_URL);
  const entries = data ? Object.entries(data.chains).filter(([, c]) => c.latest) : [];
  const catches: ScoreboardCatch[] = data ? Object.values(data.chains).flatMap(c => c.catches) : [];
  const best = catches.reduce<ScoreboardCatch | null>(
    (a, b) => ((b.x24h ?? -Infinity) > (a?.x24h ?? -Infinity) ? b : a),
    null
  );
  return (
    <section style={{ marginBottom: space[24] }}>
      <h2 style={h2Style}>Signal quality</h2>
      {error && (
        <Banner variant="error">
          signal quality unavailable — {error}. Section withheld rather than rendered empty.
        </Banner>
      )}
      {loading && !error && <Loading label="loading live figures…" />}
      {!error && data && (
        <>
          {entries.map(([chain, c]) => {
            const b = c.latest as ScoreboardBucket;
            return (
              <div key={`meter-${chain}`} style={{ marginBottom: space[12] }}>
                <h3 style={{ ...h4Style, marginTop: 0 }}>{chain} — {b.day}</h3>
                <Meter
                  parts={[
                    { label: 'ran', value: b.run, color: color.green },
                    { label: 'flat', value: b.flat, color: color.labelTertiary },
                    { label: 'dumped', value: b.dump, color: color.red },
                    { label: 'unknown', value: b.unknown, color: color.separator },
                  ]}
                />
              </div>
            );
          })}
          {entries.length === 0 && <p style={noteStyle}>no cohort read for this window</p>}
          {best && (
            <p style={noteStyle}>
              best cohort catch:{' '}
              <span style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>{best.symbol || DASH}</span>{' '}
              <span style={{ color: color.blue }}>{fmtX(best.x24h)}</span> peak 24h · score{' '}
              {fmtNum(best.score, 1)} · {best.decision || DASH} · {best.day}
            </p>
          )}
          <p style={noteStyle}>
            {data.cohortDays}-day cohort · run/flat/dump are the upstream&apos;s outcome buckets, not our verdict · {data.upstream}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Live-data proof strip (round-5 social proof).
 *
 * Honest numbers only: every figure comes from the same fetchers the sections
 * below already use — no hardcoded user counts, no testimonials, no logos.
 * Each stat withholds itself (renders nothing) when its source fetch fails or
 * is still loading, so the strip can only ever show verified live figures.
 * Internal links only, zero outbound.
 */
export function ProofStrip() {
  const cr = useJson<CrHome>(CR_HOME_URL);
  const mk = useJson<MarketsEnvelope>(MARKETS_TOP_URL);
  const sb = useJson<ScoreboardPayload>(SCOREBOARD_URL);
  const nw = useJson<NewsEnvelope>(NEWS_URL);
  const items: { label: string; value: string; href: string }[] = [];
  const tracked = cr.data?.global.allCurrencies;
  if (tracked != null && Number.isFinite(tracked)) {
    items.push({ label: 'Currencies tracked', value: fmtNum(tracked), href: '/market' });
  }
  if (mk.data != null && Number.isFinite(mk.data.pool)) {
    items.push({ label: 'Coins in live pool', value: fmtNum(mk.data.pool), href: '/market' });
  }
  if (sb.data?.chains) {
    const chains = Object.values(sb.data.chains);
    const n = chains.reduce((a, c) => a + (c.latest?.n ?? 0), 0);
    if (n > 0) items.push({ label: 'Wallets screened (latest cohort)', value: fmtNum(n), href: '/signals' });
  }
  if (nw.data != null && Number.isFinite(nw.data.total) && nw.data.total > 0) {
    items.push({ label: 'News items gated', value: fmtNum(nw.data.total), href: '/news' });
  }
  if (items.length === 0) return null;
  return (
    <p style={{ margin: `${space[12]}px 0 0`, color: color.labelTertiary, fontSize: fontSize[11] }}>
      live now:{' '}
      {items.map((it, i) => (
        <span key={it.label}>
          {i > 0 ? ' · ' : null}
          <Link href={it.href} style={{ color: color.blue, textDecoration: 'none', fontWeight: fontWeight.bold }}>
            {it.value} {it.label.toLowerCase()}
          </Link>
        </span>
      ))}
    </p>
  );
}

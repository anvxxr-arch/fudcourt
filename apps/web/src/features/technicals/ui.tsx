'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { alpha, fontSize, fontFamily, fontWeight, letterSpacing, radius, space, themeColor } from '@/styles/tokens';
import { Banner } from '@/ui/banner';
import { Loading } from '@/ui/feedback';
import {
  ASSET_CLASSES, INSTRUMENTS, MOVING_AVERAGES, OSCILLATORS, TIMEFRAMES, aboveBelow,
  summaryBand, type AssetClass, type BoardPayload, type Instrument, type Timeframe,
} from './model';

/**
 * The board.
 *
 * MOBILE-FIRST BY CONSTRUCTION: there is not one `@media` query here. The
 * summary is a `repeat(auto-fit, minmax(min(200px, 100%), 1fr))` grid, the
 * selectors are single scrolling rails (`flexWrap: nowrap` + `overflowX: auto`,
 * every pill `flexShrink: 0`), and the indicator table scrolls inside its own
 * box so the page itself never scrolls sideways.
 *
 * WHAT IT REFUSES TO DO:
 *  * print 0 for a figure the upstream did not publish — a missing value is `—`;
 *  * invent a Sell/Neutral/Buy split. The aggregates are means of -1/0/+1, so
 *    only the NET (buy − sell) is recoverable; the board prints the net and says
 *    it is a net;
 *  * present the word as upstream output. The upstream publishes a score; the
 *    band mapping is this board's and it is stated on screen.
 *  * render a timeframe the upstream withheld as an empty table — it is labelled
 *    `withheld by upstream` (crypto `1d` does this).
 */
const BOARD_TFS: Timeframe[] = ['15m', '1h', '4h', '1d', '1w'];
const DETAIL_TFS: Timeframe[] = [...TIMEFRAMES];

type Status = 'idle' | 'loading' | 'ready' | 'error';

const fmt = (v: number | null, digits = 2): string => {
  if (v === null || !Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: digits });
  if (abs >= 1) return v.toFixed(digits);
  return v.toFixed(Math.min(6, digits + 2));
};

const fmtScore = (v: number | null): string => (v === null ? '—' : v.toFixed(3));

/** Band colour — buy side green, sell side red, neutral plain label. */
function bandColor(word: ReturnType<typeof summaryBand>): string {
  if (word === 'BUY' || word === 'STRONG BUY') return themeColor.green;
  if (word === 'SELL' || word === 'STRONG SELL') return themeColor.red;
  return themeColor.labelSecondary;
}

const chip = (active: boolean): React.CSSProperties => ({
  background: active ? themeColor.blue : themeColor.bgSecondary,
  color: active ? themeColor.labelOnAccent : themeColor.labelPrimary,
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  padding: `${space[8]}px ${space[12]}px`,
  fontSize: fontSize[12],
  fontFamily: fontFamily.mono,
  cursor: 'pointer',
  flexShrink: 0,
  whiteSpace: 'nowrap',
});

export default function TechnicalsBoard() {
  const [cls, setCls] = useState<AssetClass>('crypto');
  const inClass = useMemo(() => INSTRUMENTS.filter((i) => i.cls === cls), [cls]);
  const [selected, setSelected] = useState<string>(inClass[0]?.id ?? '');
  const [detailTf, setDetailTf] = useState<Timeframe>('1h');
  const [board, setBoard] = useState<BoardPayload | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');

  // The class switch must move the selection with it, or the detail panel keeps
  // describing an instrument the board no longer lists.
  useEffect(() => {
    setSelected((prev) => (inClass.some((i) => i.id === prev) ? prev : (inClass[0]?.id ?? '')));
  }, [inClass]);

  const load = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    setStatus('loading');
    try {
      const qs = new URLSearchParams({ symbols: ids.join(','), tf: BOARD_TFS.join(',') });
      const res = await fetch(`/api/technicals?${qs.toString()}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setBoard(body as BoardPayload);
      setStatus('ready');
      setError('');
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void load(inClass.map((i) => i.id));
  }, [inClass, load]);

  const row = board?.instruments.find((r) => r.instrument.id === selected) ?? board?.instruments[0];
  const detail = row?.reads.find((r) => r.tf === detailTf) ?? null;
  const brokenInvariants = row?.reads.filter((r) => !r.withheld && !r.invariant) ?? [];
  const close = detail?.values['close'] ?? null;

  const readTime = board ? new Date(board.fetchedAt).toLocaleTimeString('id-ID', { hour12: false }) : '—';

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: space[16] }}>
      {/* Source line: which upstream, read when. A figure with no clock is not a reading. */}
      <p style={{ margin: 0, color: themeColor.labelSecondary, fontSize: fontSize[11], fontFamily: fontFamily.sans }}>
        source: {board?.source ?? 'TradingView scanner'} · read {readTime} · one request per class · bands ±0.1 / ±0.5 applied here, the score is verbatim
        {' '}and equal to the mean of the two means beside it, (MA + oscillators) / 2 — the board re-checks that on every read
      </p>

      <div style={{ display: 'flex', gap: space[8], flexWrap: 'nowrap', overflowX: 'auto' }}>
        {ASSET_CLASSES.map((c) => (
          <button key={c.id} type="button" onClick={() => setCls(c.id)} aria-pressed={cls === c.id} style={chip(cls === c.id)}>
            {c.label}
          </button>
        ))}
      </div>

      {/* Two selection affordances: a keyboard-reachable select AND the rail. */}
      <label style={{ display: 'flex', gap: space[8], alignItems: 'center', flexWrap: 'wrap', fontSize: fontSize[12], color: themeColor.labelSecondary }}>
        instrument
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          style={{
            background: themeColor.bgSecondary, color: themeColor.labelPrimary,
            border: `1px solid ${themeColor.separator}`, borderRadius: radius[8],
            padding: `${space[8]}px ${space[8]}px`, fontSize: fontSize[12], fontFamily: fontFamily.mono,
          }}
        >
          {inClass.map((i) => (
            <option key={i.id} value={i.id}>{i.label}</option>
          ))}
        </select>
      </label>

      <div style={{ display: 'flex', gap: space[8], flexWrap: 'nowrap', overflowX: 'auto' }}>
        {inClass.map((i: Instrument) => (
          <button key={i.id} type="button" onClick={() => setSelected(i.id)} aria-pressed={selected === i.id} style={chip(selected === i.id)}>
            {i.label}
          </button>
        ))}
      </div>

      {status === 'loading' && <Loading label="Reading the screener…" />}
      {status === 'error' && (
        <Banner>
          read failed: {error} · <button type="button" onClick={() => void load(inClass.map((i) => i.id))} style={{ ...chip(false), background: 'transparent' }}>retry</button>
        </Banner>
      )}
      {board && board.missing.length > 0 && (
        <Banner variant="warn">
          the upstream returned no row for: {board.missing.join(', ')} — they are omitted, not shown as empty
        </Banner>
      )}
      {brokenInvariants.length > 0 && (
        <Banner variant="warn">
          score invariant broken on {brokenInvariants.map((r) => r.tf).join(', ')}: the published score is not (MA + oscillators) / 2, so the upstream changed shape — the figures below are unverified
        </Banner>
      )}

      {row && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: space[12] }}>
            {row.reads.map((r) => {
              const word = summaryBand(r.all);
              return (
                <article
                  key={r.tf}
                  style={{
                    background: themeColor.bgSecondary, border: `1px solid ${themeColor.separator}`,
                    borderRadius: radius[12], padding: space[12], display: 'flex', flexDirection: 'column', gap: space[4],
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: space[8] }}>
                    <span style={{ color: themeColor.labelSecondary, fontSize: fontSize[11], letterSpacing: letterSpacing.sm }}>{r.tf.toUpperCase()}</span>
                    <span style={{ color: themeColor.labelSecondary, fontSize: fontSize[11] }}>close {fmt(close && r.tf === detailTf ? close : r.values['close'], 2)}</span>
                  </div>
                  {r.withheld ? (
                    <span style={{ color: themeColor.labelSecondary, fontSize: fontSize[11] }}>withheld by upstream</span>
                  ) : (
                    <>
                      <span style={{ color: bandColor(word), fontWeight: fontWeight.bold, fontSize: fontSize[13], letterSpacing: letterSpacing.xs }}>
                        {word ?? '—'}
                      </span>
                      <span style={{ color: themeColor.labelPrimary, fontSize: fontSize[12], fontFamily: fontFamily.mono }}>
                        score {fmtScore(r.all)}
                      </span>
                      <span style={{ color: themeColor.labelSecondary, fontSize: fontSize[11], fontFamily: fontFamily.mono }}>
                        MA {fmtScore(r.ma)} · osc {fmtScore(r.osc)}
                      </span>
                      <span style={{ color: themeColor.labelSecondary, fontSize: fontSize[11], fontFamily: fontFamily.mono }}>
                        net {r.netMa === null ? '—' : `${r.netMa > 0 ? '+' : ''}${r.netMa}/${r.maPresent}`} MA · {r.netOsc === null ? '—' : `${r.netOsc > 0 ? '+' : ''}${r.netOsc}/11`} osc
                      </span>
                      <button
                        type="button"
                        onClick={() => setDetailTf(r.tf)}
                        aria-pressed={detailTf === r.tf}
                        style={{ ...chip(detailTf === r.tf), alignSelf: 'flex-start', padding: `${space[4]}px ${space[8]}px`, fontSize: fontSize[11] }}
                      >
                        indicators
                      </button>
                    </>
                  )}
                </article>
              );
            })}
          </div>

          {detail && !detail.withheld && (
            <div style={{ background: themeColor.bgSecondary, border: `1px solid ${themeColor.separator}`, borderRadius: radius[12], padding: space[12] }}>
              <h2 style={{ margin: `0 0 ${space[8]}px`, color: themeColor.labelPrimary, fontSize: fontSize[13], letterSpacing: letterSpacing.sm, fontFamily: fontFamily.sans }}>
                {row.instrument.label} · {detail.tf.toUpperCase()} · values verbatim
              </h2>
              {/* The table scrolls in its own box: the page must never scroll sideways. */}
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: fontFamily.mono, fontSize: fontSize[12] }}>
                  <thead>
                    <tr style={{ color: themeColor.labelSecondary, textAlign: 'left' }}>
                      <th style={{ padding: space[4], fontWeight: fontWeight.semibold }}>indicator</th>
                      <th style={{ padding: space[4], fontWeight: fontWeight.semibold, textAlign: 'right' }}>value</th>
                      <th style={{ padding: space[4], fontWeight: fontWeight.semibold, textAlign: 'left' }}>close vs level</th>
                    </tr>
                  </thead>
                  {([['oscillators', OSCILLATORS, false], ['moving averages', MOVING_AVERAGES, true]] as const).map(
                    ([label, fields, isMa]) => (
                      <tbody key={label}>
                        {/* The two groups ARE the two means the score is built from; naming
                            them here is what lets a reader tell an oscillator row from a
                            moving-average row without reading colours. */}
                        <tr>
                          <td
                            colSpan={3}
                            style={{ padding: `${space[8]}px ${space[4]}px`, color: themeColor.labelSecondary, fontSize: fontSize[11], letterSpacing: letterSpacing.sm, fontFamily: fontFamily.sans }}
                          >
                            {label} ({fields.length})
                          </td>
                        </tr>
                        {fields.map((f) => {
                          const side = isMa ? aboveBelow(close, detail.values[f] ?? null) : null;
                          return (
                            <tr key={f} style={{ borderTop: `1px solid ${themeColor.separator}` }}>
                              <td style={{ padding: space[4], color: themeColor.labelPrimary }}>{f}</td>
                              <td style={{ padding: space[4], textAlign: 'right', color: themeColor.labelPrimary }}>{fmt(detail.values[f] ?? null)}</td>
                              <td style={{ padding: space[4], color: side === 'above' ? themeColor.green : side === 'below' ? themeColor.red : themeColor.labelSecondary }}>
                                {side ?? '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    ),
                  )}
                </table>
              </div>
              <p style={{ margin: `${space[8]}px 0 0`, color: themeColor.labelSecondary, fontSize: fontSize[11], fontFamily: fontFamily.sans }}>
                “close vs level” is arithmetic on the two values beside it; the oscillator rating column is deliberately absent because those rules are evaluated upstream and are not public.
              </p>
            </div>
          )}
        </>
      )}

      {status === 'ready' && !row && <Banner variant="warn">the upstream returned rows for none of this class’s instruments</Banner>}
    </section>
  );
}

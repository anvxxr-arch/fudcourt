'use client';

/**
 * The insights boards (F-insights) — `/insights`: the quarterly-returns table for
 * BTC and ETH, and CryptoRank's own AI market digest.
 *
 * WHAT THIS BOARD MUST NOT DO.
 *  - It must never print a return the upstream did not make. CryptoRank ships an
 *    open and a close; every percentage is COMPUTED here and is labelled so at the
 *    column and in the footnote — it is the same arithmetic on the same numbers,
 *    not a figure the upstream published.
 *  - It must never dress a running quarter as a finished one. A cell with
 *    `isFull:false` is marked "in progress" and its move is the move so far; a
 *    cell with no close renders `—`, never a return of 0.
 *  - It must never print 0 where the upstream published nothing. Every absent
 *    metric renders `—`; a metric the upstream did not make is not a zero.
 *  - It must never pass CryptoRank's generated words off as its own or as
 *    independent findings. The AI summary, news, funding and the drop-hunting /
 *    vesting sections are attributed to CryptoRank, quoted.
 *  - It must never render the literal "No Data Available" as if it were a summary.
 *    It is a STATED ABSENCE and is shown as "CryptoRank states no summary here".
 *  - It must never render an empty-but-successful payload as an empty board. A
 *    quarterly table with no rows, or an envelope with no `aiOverview` at all, is
 *    reported as a failure.
 *
 * The reading itself lives in `./model.ts` and is pure, so every refusal above is
 * unit-tested offline against fixed rows.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { themeColor, fontSize, fontWeight, lineHeight, radius, space, letterSpacing } from '@/styles/tokens';
import { dash, fmtPct } from '@/lib/format';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { EmptyState, ErrorState, Loading } from '@/ui/feedback';
import { Stat } from '@/ui/stat';
import {
  fetchAiOverview,
  fetchQuarterly,
  type AiOverviewEnvelope,
  type QuarterlyEnvelope,
  type Source,
} from './client';
import {
  readAiDigest,
  readQuarterlyBoard,
  type AiDigest,
  type AiNewsItem,
  type AiUnlock,
  type QuarterRead,
  type QuarterlyBoard,
  type YearRead,
} from './model';

// ---------------------------------------------------------------------------
// Small display helpers — every one null-tolerant, every one ending in `—`.
// ---------------------------------------------------------------------------

/** A compact USD magnitude; null/undefined -> the em dash, never 0. */
function usd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return dash;
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

/** A string field; absent or '' -> the em dash. */
function text(v: string | null | undefined): string {
  return v === null || v === undefined || v === '' ? dash : v;
}

/** The date part of an upstream ISO instant; null -> the em dash. */
function dateOf(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : dash;
}

/** An age in seconds, as a compact human string; null -> the em dash. */
function age(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return dash;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 172800) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

/** A signed change colour: null and 0 are neutral, never up. */
function changeColor(v: number | null): string {
  if (v === null || !Number.isFinite(v) || v === 0) return themeColor.labelTertiary;
  return v > 0 ? themeColor.green : themeColor.red;
}

/** A percentage the upstream itself reported (unlock %), no sign; null -> dash. */
function plainPct(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? dash : `${v.toFixed(2)}%`;
}

/**
 * One read, keyed by a selector string. The loader closure is re-created each
 * render, but the effect depends on `key` — the SELECTION the read was made for —
 * so an unrelated re-render does not refetch.
 */
function useSource<T>(load: (signal: AbortSignal) => Promise<Source<T>>, key: string): Source<T> | null {
  const [state, setState] = useState<Source<T> | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    setState(null);
    load(ac.signal).then((s) => {
      if (!ac.signal.aborted) setState(s);
    });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/** The failure panel for a read that returned nothing — never an empty board. */
function ReadFailure({ title, error }: { title: string; error: string | null }) {
  return <ErrorState title={title} detail={error ?? 'the upstream returned no rows and named no reason'} />;
}

/** The amber-ish note line the board uses for a named caveat. */
function Note({ children }: { children: ReactNode }) {
  return (
    <p style={{ margin: 0, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>{children}</p>
  );
}

// ---------------------------------------------------------------------------
// (1) Quarterly returns — mode=quarterly
// ---------------------------------------------------------------------------

/** One quarter cell: the computed return, with an explicit in-progress marker. */
function QuarterCellView({ q }: { q: QuarterRead }) {
  if (q.status === 'absent') {
    return (
      <span style={{ color: themeColor.labelTertiary }} title={q.note ?? undefined}>
        {dash}
      </span>
    );
  }
  const ret = q.returnPct;
  const inProgress = q.status === 'in-progress';
  return (
    <span>
      <span style={{ color: ret === null ? themeColor.labelTertiary : changeColor(ret) }} title={q.note ?? undefined}>
        {fmtPct(ret)}
      </span>
      {inProgress ? (
        <span style={{ color: themeColor.orange, fontWeight: fontWeight.regular, fontSize: fontSize[10] }}> · in progress</span>
      ) : null}
    </span>
  );
}

/** The full-year cell: the computed first-open → last-close move, marked YTD when running. */
function FullYearCell({ y }: { y: YearRead }) {
  const ret = y.fullYearReturnPct;
  return (
    <span>
      <span style={{ color: ret === null ? themeColor.labelTertiary : changeColor(ret), fontWeight: fontWeight.semibold }} title={y.note}>
        {fmtPct(ret)}
      </span>
      {y.fullYearStatus === 'in-progress' ? (
        <span style={{ color: themeColor.orange, fontWeight: fontWeight.regular, fontSize: fontSize[10] }}> · YTD</span>
      ) : null}
    </span>
  );
}

/** One asset's quarterly table: a row per year, Q1..Q4 + a computed full-year figure. */
function QuarterlyTable({ board }: { board: QuarterlyBoard }) {
  return (
    <div style={{ marginTop: space[12] }}>
      <h3
        style={{
          margin: 0,
          fontSize: fontSize[12],
          fontWeight: fontWeight.semibold,
          color: themeColor.labelPrimary,
          letterSpacing: letterSpacing.xs,
        }}
      >
        {board.asset} — {board.count} years
      </h3>
      <DataTable
        head={['Year', 'Q1', 'Q2', 'Q3', 'Q4', 'Full year (computed)']}
        rows={board.rows.map((y) => ({
          cells: [
            <span key="y" style={{ fontWeight: fontWeight.semibold }}>
              {y.year}
              {!y.complete ? <span style={{ color: themeColor.orange, fontWeight: fontWeight.regular, fontSize: fontSize[10] }}> · running</span> : null}
            </span>,
            <span key="q1">
              <QuarterCellView q={y.quarters[0]} />
            </span>,
            <span key="q2">
              <QuarterCellView q={y.quarters[1]} />
            </span>,
            <span key="q3">
              <QuarterCellView q={y.quarters[2]} />
            </span>,
            <span key="q4">
              <QuarterCellView q={y.quarters[3]} />
            </span>,
            <span key="fy">
              <FullYearCell y={y} />
            </span>,
          ],
        }))}
      />
    </div>
  );
}

function QuarterlySection({
  src,
  btcBoard,
  ethBoard,
}: {
  src: Source<QuarterlyEnvelope> | null;
  btcBoard: QuarterlyBoard | null;
  ethBoard: QuarterlyBoard | null;
}) {
  return (
    <Card
      title="Quarterly returns"
      subtitle="BTC and ETH, one row per year. Every percentage is COMPUTED by this board from CryptoRank's open/close prices — the upstream ships no return% at all."
    >
      {src === null ? (
        <Loading what="the quarterly tables" />
      ) : src.data === null ? (
        <ReadFailure title="Could not load the quarterly tables" error={src.error} />
      ) : btcBoard === null && ethBoard === null ? (
        <ErrorState
          title="The quarterly tables came back empty"
          detail="the upstream answered successfully with no rows — an empty board is not a valid read, so this is reported as a failure, not an empty table"
        />
      ) : (
        <>
          {btcBoard ? <QuarterlyTable board={btcBoard} /> : null}
          {ethBoard ? <QuarterlyTable board={ethBoard} /> : null}
          <div style={{ marginTop: space[8] }}>
            <Note>
              A quarter marked <span style={{ color: themeColor.orange }}>in progress</span> is still open upstream
              (<code>isFull:false</code>): its move is what the quarter has done so far, never a completed return. A
              quarter with no <code>closeUsd</code> renders {dash}; an absent cell is a quarter before the asset
              existed. The full-year figure spans the first present open to the last present close and is marked{' '}
              <span style={{ color: themeColor.orange }}>YTD</span> while the year is still running.
            </Note>
          </div>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// (2) CryptoRank's AI market overview — mode=aioverview
// ---------------------------------------------------------------------------

function NewsRow({ item }: { item: AiNewsItem }) {
  return (
    <li
      style={{
        listStyle: 'none',
        display: 'flex',
        gap: space[8],
        alignItems: 'baseline',
        padding: `${space[8]}px 0`,
        borderBottom: `1px solid ${themeColor.separator}`,
      }}
    >
      <span style={{ flex: '1 1 auto', fontSize: fontSize[12], color: themeColor.labelPrimary }}>{text(item.title)}</span>
      <span style={{ flex: '0 0 auto', fontSize: fontSize[11], color: themeColor.labelTertiary }}>{dateOf(item.date)}</span>
      <span
        style={{
          flex: '0 0 auto',
          fontSize: fontSize[10],
          fontWeight: fontWeight.medium,
          color: item.isBullish ? themeColor.green : themeColor.red,
        }}
      >
        {item.isBullish ? 'bullish' : 'bearish'}
      </span>
    </li>
  );
}

function UnlockRow({ u }: { u: AiUnlock }) {
  return (
    <li
      style={{
        listStyle: 'none',
        display: 'flex',
        gap: space[8],
        justifyContent: 'space-between',
        padding: `${space[4]}px 0`,
      }}
    >
      <span style={{ fontSize: fontSize[12], color: themeColor.labelPrimary }}>{text(u.coinName)}</span>
      <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>
        {dateOf(u.date)} · {plainPct(u.unlockPercent)} of supply
      </span>
    </li>
  );
}

function AiOverviewSection({ src, digest }: { src: Source<AiOverviewEnvelope> | null; digest: AiDigest | null }) {
  return (
    <Card
      title="AI market overview"
      subtitle="CryptoRank's own generated market summary, news, funding and drop-hunting / vesting digests — its words, quoted and attributed, not our analysis."
    >
      {src === null ? (
        <Loading what="CryptoRank's AI digest" />
      ) : src.data === null ? (
        <ReadFailure title="Could not load CryptoRank's AI digest" error={src.error} />
      ) : digest === null ? (
        <ErrorState
          title="The AI digest came back empty"
          detail="the envelope answered successfully but carried no aiOverview — reported as a failure, not an empty digest"
        />
      ) : (
        <>
          {/* The market summary — CryptoRank's words, with its own timestamp. */}
          <Note>
            CryptoRank&apos;s digest, updated {dateOf(digest.updatedAt)}
            {digest.updatedAgeSec !== null ? ` (${age(digest.updatedAgeSec)} ago)` : ''}. The text below is
            CryptoRank&apos;s own generated wording.
          </Note>
          <div style={{ marginTop: space[8] }}>
            {digest.marketSummary.absent ? (
              <EmptyState>{digest.marketSummary.reason ?? 'no market summary'}</EmptyState>
            ) : (
              <p style={{ margin: 0, fontSize: fontSize[12], color: themeColor.labelPrimary, lineHeight: lineHeight.normal, whiteSpace: 'pre-wrap' }}>
                {digest.marketSummary.text}
              </p>
            )}
          </div>

          {/* The digest's news list. */}
          <div style={{ marginTop: space[16] }}>
            <h3 style={{ margin: 0, fontSize: fontSize[12], fontWeight: fontWeight.semibold, color: themeColor.labelPrimary, letterSpacing: letterSpacing.xs }}>
              Digest headlines
            </h3>
            {digest.news.length === 0 ? (
              <EmptyState>CryptoRank&apos;s digest carried no headlines.</EmptyState>
            ) : (
              <ul style={{ margin: `${space[4]}px 0 0`, padding: 0 }}>
                {digest.news.map((n) => (
                  <NewsRow key={n.id} item={n} />
                ))}
              </ul>
            )}
          </div>

          {/* Funding rollup — the summary is a STATED ABSENCE when it says so, the rounds are data. */}
          <div style={{ marginTop: space[16] }}>
            <h3 style={{ margin: 0, fontSize: fontSize[12], fontWeight: fontWeight.semibold, color: themeColor.labelPrimary, letterSpacing: letterSpacing.xs }}>
              Funding rounds
            </h3>
            <div style={{ marginTop: space[4] }}>
              {digest.funding.summary.absent ? (
                <Note>
                  {digest.funding.summary.reason ?? 'no funding summary'} — read as a stated absence, not as data.
                </Note>
              ) : (
                <p style={{ margin: 0, fontSize: fontSize[12], color: themeColor.labelPrimary, lineHeight: lineHeight.normal, whiteSpace: 'pre-wrap' }}>
                  {digest.funding.summary.text}
                </p>
              )}
            </div>
            <div style={{ marginTop: space[8] }}>
              {digest.funding.rounds.length === 0 ? (
                <EmptyState>The digest carried no structured funding rounds.</EmptyState>
              ) : (
                <DataTable
                  head={['Name', 'Stage', 'Raised']}
                  rows={digest.funding.rounds.map((r) => ({
                    cells: [
                      <span key="n" style={{ fontWeight: fontWeight.semibold }}>{text(r.name)}</span>,
                      <span key="s" style={{ color: themeColor.labelTertiary }}>{text(r.stage)}</span>,
                      <span key="r">{usd(r.raisedUsd)}</span>,
                    ],
                  }))}
                />
              )}
              <div style={{ marginTop: space[4] }}>
                <Note>
                  {digest.funding.rounds.length} round(s) on the digest; {digest.funding.raisedStated} state a raise.
                  {digest.funding.raisedTotalUsd !== null
                    ? ` Total ${usd(digest.funding.raisedTotalUsd)} (every round states one).`
                    : ' No total is shown — a partial sum under a total label would understate by the rows it skipped.'}
                </Note>
              </div>
            </div>
          </div>

          {/* Drop-hunting — present or stated absent. */}
          <div style={{ marginTop: space[16] }}>
            <h3 style={{ margin: 0, fontSize: fontSize[12], fontWeight: fontWeight.semibold, color: themeColor.labelPrimary, letterSpacing: letterSpacing.xs }}>
              Drop hunting
            </h3>
            {!digest.dropHunting.present ? (
              <EmptyState>CryptoRank&apos;s digest carried no drop-hunting section.</EmptyState>
            ) : (
              <>
                {digest.dropHunting.summary.absent ? (
                  <Note>{digest.dropHunting.summary.reason ?? 'no drop-hunting summary'}</Note>
                ) : (
                  <p style={{ margin: `${space[4]}px 0 0`, fontSize: fontSize[12], color: themeColor.labelPrimary, lineHeight: lineHeight.normal, whiteSpace: 'pre-wrap' }}>
                    {digest.dropHunting.summary.text}
                  </p>
                )}
                {digest.dropHunting.activities.length === 0 ? (
                  <EmptyState>No drop-hunting activities listed.</EmptyState>
                ) : (
                  <ul style={{ margin: `${space[8]}px 0 0`, padding: 0, border: `1px solid ${themeColor.separator}`, borderRadius: radius[8] }}>
                    {digest.dropHunting.activities.map((a) => (
                      <li
                        key={a.key}
                        style={{ listStyle: 'none', display: 'flex', gap: space[8], justifyContent: 'space-between', padding: `${space[4]}px ${space[8]}px` }}
                      >
                        <span style={{ fontSize: fontSize[12], color: themeColor.labelPrimary }}>{text(a.coinName)}</span>
                        <span style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>{text(a.type)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>

          {/* Vesting — present or stated absent. */}
          <div style={{ marginTop: space[16] }}>
            <h3 style={{ margin: 0, fontSize: fontSize[12], fontWeight: fontWeight.semibold, color: themeColor.labelPrimary, letterSpacing: letterSpacing.xs }}>
              Vesting / unlocks
            </h3>
            {!digest.vesting.present ? (
              <EmptyState>CryptoRank&apos;s digest carried no vesting section.</EmptyState>
            ) : (
              <>
                {digest.vesting.summary.absent ? (
                  <Note>{digest.vesting.summary.reason ?? 'no vesting summary'}</Note>
                ) : (
                  <p style={{ margin: `${space[4]}px 0 0`, fontSize: fontSize[12], color: themeColor.labelPrimary, lineHeight: lineHeight.normal, whiteSpace: 'pre-wrap' }}>
                    {digest.vesting.summary.text}
                  </p>
                )}
                {digest.vesting.unlocks.length === 0 ? (
                  <EmptyState>No unlocks listed.</EmptyState>
                ) : (
                  <ul style={{ margin: `${space[8]}px 0 0`, padding: `0 ${space[8]}px` }}>
                    {digest.vesting.unlocks.map((u, i) => (
                      <UnlockRow key={`${text(u.coinName)}-${i}`} u={u} />
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The route surface — two independent reads; one failing never blanks the other.
// ---------------------------------------------------------------------------

export default function InsightsBoard() {
  const quarterly = useSource<QuarterlyEnvelope>((s) => fetchQuarterly(s), 'quarterly');
  const ai = useSource<AiOverviewEnvelope>((s) => fetchAiOverview(s), 'aioverview');
  const nowSec = useMemo(() => Math.floor(Date.now() / 1000), []);

  const btcBoard = useMemo(
    () => (quarterly?.data ? readQuarterlyBoard(quarterly.data.quarterlyBtc ?? [], 'BTC') : null),
    [quarterly],
  );
  const ethBoard = useMemo(
    () => (quarterly?.data ? readQuarterlyBoard(quarterly.data.quarterlyEth ?? [], 'ETH') : null),
    [quarterly],
  );
  const digest = useMemo(() => (ai?.data ? readAiDigest(ai.data.aiOverview ?? null, nowSec) : null), [ai, nowSec]);

  /** The headline current-quarter hint, naming the quarter and whether it is running. */
  const currentHint = (board: QuarterlyBoard | null): string => {
    if (quarterly === null) return 'loading…';
    if (board === null || board.current === null) return 'no current quarter in the payload';
    const { year, quarter } = board.current;
    return `${quarter.label} ${year} · ${quarter.isFull ? 'complete' : 'in progress'}`;
  };

  const btcCurrent = btcBoard?.current?.quarter ?? null;
  const ethCurrent = ethBoard?.current?.quarter ?? null;

  /** A signed return paints positive/negative; a MISSING return is neutral — never a fake 0. */
  const quarterTone = (q: { returnPct: number | null } | null): 'positive' | 'negative' | 'neutral' =>
    q?.returnPct == null ? 'neutral' : q.returnPct >= 0 ? 'positive' : 'negative';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: space[16] }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
        <Stat
          label="BTC current-quarter"
          value={fmtPct(btcCurrent ? btcCurrent.returnPct : null)}
          tone={quarterTone(btcCurrent)}
          hint={currentHint(btcBoard)}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 150px' }}
        />
        <Stat
          label="ETH current-quarter"
          value={fmtPct(ethCurrent ? ethCurrent.returnPct : null)}
          tone={quarterTone(ethCurrent)}
          hint={currentHint(ethBoard)}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 150px' }}
        />
        <Stat
          label="AI digest updated"
          value={digest ? dateOf(digest.updatedAt) : dash}
          hint={digest ? `CryptoRank's digest${digest.updatedAgeSec !== null ? ` · ${age(digest.updatedAgeSec)} ago` : ''}` : ai === null ? 'loading…' : 'not available'}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 150px' }}
        />
        <Stat
          label="Funding rounds"
          value={digest ? String(digest.funding.rounds.length) : dash}
          hint={digest ? `${digest.funding.raisedStated} state a raise · CryptoRank's digest` : ai === null ? 'loading…' : 'not available'}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 150px' }}
        />
      </div>

      <QuarterlySection src={quarterly} btcBoard={btcBoard} ethBoard={ethBoard} />
      <AiOverviewSection src={ai} digest={digest} />

      <Note>
        Two upstream tables, one rule: a metric CryptoRank did not publish renders {dash}, never 0. The quarterly
        returns are ours to compute and are labelled so; the AI overview is CryptoRank&apos;s own generated wording,
        quoted and attributed. Nothing here is a recommendation.
      </Note>
    </div>
  );
}

'use client';

/**
 * The treasury's exposure to the macro regime (plan Phase 13, stages 16–17) —
 * the overlay rendered under the regime board on `/economy/regime`.
 *
 * WHAT THIS SECTION MUST NOT DO. It must never turn a refusal into a number.
 * The overlay withholds the book total when a holding could not be valued, and
 * withholds every share with it; this view prints the em dash and the reason
 * rather than a zero, because a share over a partial total is a lie about the
 * book's composition. For the same reason a holding whose class came from the
 * fallback rule is MARKED as assumed, in its own column: the board shows the
 * assumption instead of hiding it behind a confident class label.
 *
 * A 401 IS NOT AN ERROR. The route is team-gated because it reads private
 * holdings. An anonymous reader gets the regime (which is public) and a quiet
 * line here; the section only shouts when the read actually broke.
 *
 * The classification rule is printed verbatim from the payload, so the reading
 * and the rule that produced it cannot drift apart.
 */
import { useEffect, useState } from 'react';
import { themeColor, fontSize, fontWeight, lineHeight, space } from '@/styles/tokens';
import { fetchExposure, formatCompact, type ExposureRead } from '@/features/economy/model';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { ErrorState, Loading } from '@/ui/feedback';
import { Stat } from '@/ui/stat';

const STANCE_COLOR: Record<string, string> = {
  'strongly bullish': themeColor.green,
  bullish: themeColor.green,
  neutral: themeColor.labelTertiary,
  bearish: themeColor.red,
  'strongly bearish': themeColor.red,
};

/** A share as a percentage, or the em dash when it was withheld. */
function pct(share: number | null): string {
  return share === null ? '—' : `${(share * 100).toFixed(1)}%`;
}

/** A score with its sign, to the table's own two decimals. */
function score(n: number): string {
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
}

export function ExposureSection({ country }: { country?: string }) {
  const [read, setRead] = useState<ExposureRead | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setRead(null);
    fetchExposure(country, ac.signal).then((r) => !ac.signal.aborted && setRead(r));
    return () => ac.abort();
  }, [country]);

  const shell = (children: React.ReactNode) => (
    <div style={{ marginTop: space[12] }}>
      <Card title="Your exposure to this regime" subtitle="the treasury's holdings, classified by the weight table above — a reading, not advice">
        {children}
      </Card>
    </div>
  );

  if (read === null) return shell(<Loading what="treasury exposure" />);

  if (read.unauthorized) {
    return shell(
      <p style={{ margin: 0, fontSize: fontSize[13], color: themeColor.labelSecondary, lineHeight: lineHeight.normal }}>
        The overlay reads the treasury&apos;s own holdings, so it is visible to signed-in team members only. Sign in to see
        how the book is positioned against this regime.
      </p>
    );
  }

  if (read.error) {
    return shell(<ErrorState title="Could not load the exposure overlay" detail={read.error} />);
  }

  const data = read.data;
  const ex = data?.exposure ?? null;
  if (!data || !ex) {
    const failures = (data?.failed ?? []).map((f) => `${f.symbol}: ${f.reason}`).join(' · ');
    return shell(
      <ErrorState
        title="The holdings read failed"
        detail={failures || 'the exposure overlay was not returned, and no reason was named'}
      />
    );
  }

  const total = ex.total_usd;
  const assumed = ex.holdings.filter((h) => h.assumed);

  return shell(
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[8] }}>
        <Stat
          label="Value-weighted alignment"
          value={ex.alignment === null ? '—' : score(ex.alignment)}
          tone={ex.alignment === null ? 'neutral' : ex.alignment > 0 ? 'positive' : ex.alignment < 0 ? 'negative' : 'neutral'}
          hint="mean class score over the valued holdings"
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 150px' }}
        />
        <Stat
          label="Coverage"
          value={pct(ex.coverage)}
          hint="share of the book that maps to a scored class"
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 150px' }}
        />
        <Stat
          label="Book total"
          value={total === null ? '—' : `$${formatCompact(total)}`}
          hint={total === null ? 'unknown — a holding could not be valued' : 'sum of every valued holding'}
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 150px' }}
        />
        <Stat
          label="Mapped"
          value={`$${formatCompact(ex.mapped_usd)}`}
          hint="value scored by the weight table"
          valueSize={fontSize[17]}
          style={{ padding: `${space[8]}px ${space[8]}px`, flex: '1 1 150px' }}
        />
      </div>

      <div style={{ marginTop: space[12] }}>
        <DataTable
          head={['Asset class', 'Stance', 'Score', 'Value', 'Share', 'Holdings']}
          rows={ex.classes.map((c) => ({
            cells: [
              <span key="l" style={{ fontWeight: fontWeight.semibold }}>{c.label}</span>,
              <span key="s" style={{ color: STANCE_COLOR[c.stance] ?? themeColor.labelTertiary, fontWeight: fontWeight.semibold }}>{c.stance}</span>,
              <span key="sc" style={{ color: c.score > 0 ? themeColor.green : c.score < 0 ? themeColor.red : themeColor.labelTertiary }}>{score(c.score)}</span>,
              <span key="v">{c.value_usd > 0 ? `$${formatCompact(c.value_usd)}` : '—'}</span>,
              <span key="sh" style={{ color: c.share === null ? themeColor.labelTertiary : themeColor.labelPrimary }}>{pct(c.share)}</span>,
              <span key="h" style={{ color: themeColor.labelTertiary }}>{c.holdings.length === 0 ? '—' : c.holdings.join(', ')}</span>,
            ],
          }))}
        />
      </div>

      {ex.holdings.length > 0 && (
        <div style={{ marginTop: space[12] }}>
          <DataTable
            head={['Holding', 'Class', 'Class source', 'Value', 'Stance', 'Score']}
            rows={ex.holdings.map((h) => ({
              cells: [
                <span key="a" style={{ fontWeight: fontWeight.semibold }}>{h.asset}</span>,
                <span key="c">{h.klassLabel}</span>,
                <span key="cs" style={{ color: h.assumed ? themeColor.orange : themeColor.labelTertiary }}>
                  {h.assumed ? 'assumed (fallback rule)' : 'explicit binding'}
                </span>,
                <span key="v">${formatCompact(h.value_usd)}</span>,
                <span key="s" style={{ color: STANCE_COLOR[h.stance] ?? themeColor.labelTertiary }}>{h.stance}</span>,
                <span key="sc" style={{ color: h.score > 0 ? themeColor.green : h.score < 0 ? themeColor.red : themeColor.labelTertiary }}>{score(h.score)}</span>,
              ],
            }))}
          />
          {assumed.length > 0 && (
            <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.orange, lineHeight: lineHeight.normal }}>
              {assumed.length} holding(s) matched no explicit binding and are scored as the crypto-risk class:{' '}
              {assumed.map((h) => h.asset).join(', ')}. The class is shown as assumed rather than guessed at.
            </p>
          )}
        </div>
      )}

      {ex.skipped.length > 0 && (
        <div style={{ marginTop: space[12] }}>
          <ErrorState
            title={`${ex.skipped.length} holding(s) left out of the maths`}
            detail={ex.skipped.map((s) => `${s.asset}: ${s.reason}`).join(' · ')}
          />
        </div>
      )}

      <p style={{ margin: `${space[12]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        Classification rule: {ex.rule}
      </p>
      <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
        The alignment is the value-weighted mean of the class scores over the holdings that could be valued. It reads the
        regime against the book — it is not advice, and not a position size.
      </p>
    </>
  );
}

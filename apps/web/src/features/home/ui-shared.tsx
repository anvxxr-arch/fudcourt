'use client';

import { useEffect, useState } from 'react';
import { alpha, themeColor, fontSize, fontWeight, letterSpacing, radius, space } from '@/styles/tokens';
import { Banner } from '@/ui/banner';
import { Loading } from '@/ui/feedback';
import { imgSrc } from '@/lib/img';
import {
  DASH,
  fmtPct,
  fetchJson,
  toneOf,
} from './client';
/**
 * One reserved line of a list/table row, in px. Sourced from the 11px row type
 * plus its leading — the figure the CLS fix needs and the only number that
 * appears in both the loading and the loaded state. Exported so the panels that
 * size their own containers (the movers columns, the news list) use the SAME
 * value instead of each inventing one.
 */
export const ROW_MIN_HEIGHT = 18;
/**
 * The provenance note's reserved height: two wrapped lines at the 11px note
 * size. Reserved because the note is part of every panel's body and its wrap is
 * what makes the loaded height differ from a bare row count.
 */
export const NOTE_MIN_HEIGHT = 40;
// ---- shared styles (token-only; the design gate forbids literals here) ------

export const cardStyle: React.CSSProperties = {
  background: themeColor.bgSecondary,
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  padding: space[12],
};
export const h2Style: React.CSSProperties = {
  margin: `0 0 ${space[8]}px`,
  color: themeColor.blue,
  fontSize: fontSize[15],
  fontWeight: fontWeight.bold,
  letterSpacing: letterSpacing.wide,
};
export const h3Style: React.CSSProperties = {
  margin: `0 0 ${space[8]}px`,
  color: themeColor.blue,
  fontSize: fontSize[12],
  fontWeight: fontWeight.bold,
  letterSpacing: letterSpacing.wide,
};
/** Sub-heading inside a card, for a block that sits under the card's own h3. */
export const h4Style: React.CSSProperties = {
  margin: `${space[12]}px 0 ${space[8]}px`,
  color: themeColor.labelPrimary,
  fontSize: fontSize[11],
  fontWeight: fontWeight.bold,
  letterSpacing: letterSpacing.wide,
};
/** A `<summary>` that reads as a control, not as body copy. */
export const summaryStyle: React.CSSProperties = {
  cursor: 'pointer',
  color: themeColor.blue,
  fontSize: fontSize[11],
  fontWeight: fontWeight.bold,
  letterSpacing: letterSpacing.wide,
  marginTop: space[12],
};
/**
 * The provenance note under a board's rows. Every caller interpolates the RAW
 * upstream URL (`{d.upstream}`) into this line, and a URL is ONE unbreakable
 * token: the CoinGecko markets URL is 148 characters / 669px, which at a 390px
 * viewport set `documentElement.scrollWidth` to 690 and made the WHOLE home page
 * scroll sideways on a phone. `overflowWrap: 'anywhere'` lets the URL break so
 * the note costs no page-level overflow.
 */
export const noteStyle: React.CSSProperties = {
  margin: `${space[8]}px 0 0`,
  color: themeColor.labelTertiary,
  fontSize: fontSize[11],
  overflowWrap: 'anywhere',
};
export const listRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  gap: space[8],
  fontSize: fontSize[11],
  // Reserve the line box. A row is ~18px tall once it holds figures; without a
  // floor the loading state (a 49px panel) and the loaded state (up to 727px)
  // differ, and every panel above the arrival point shifts the ones below it —
  // measured CLS 0.064 on `/` and 0.235 on `/market/crypto`, all of it these
  // panels. `minHeight` + the same `lineHeight` in both states means the panel
  // occupies its final height before the first figure exists.
  minHeight: ROW_MIN_HEIGHT,
  lineHeight: `${ROW_MIN_HEIGHT}px`,
};
export const theadRowStyle: React.CSSProperties = {
  color: themeColor.labelTertiary,
  textAlign: 'left',
  borderBottom: `1px solid ${themeColor.separator}`,
};
export const rowStyle: React.CSSProperties = { borderBottom: `1px solid ${alpha(themeColor.separator, 0.4)}` };

// ---- primitives -------------------------------------------------------------

/** One fetch, one state machine. `alive` guards a setState after unmount. */
export function useJson<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    fetchJson<T>(url)
      .then(j => { if (alive) { setData(j); setLoading(false); } })
      .catch(e => { if (alive) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { alive = false; };
  }, [url]);
  return { data, error, loading };
}

/** A titled section whose body is withheld on error and never zero-filled. */
export function Panel<T>({
  title,
  url,
  label,
  rows,
  rowHeight,
  render,
}: {
  title: string;
  url: string;
  label?: string;
  /** How many rows the loaded body renders, so the loading state can reserve
   *  its exact height. Omit only when the body's height does not depend on a
   *  row count (a single prose block, a chart). */
  rows?: number;
  /** One of those rows' loaded height. Defaults to `ROW_MIN_HEIGHT` (a single
   *  line of figures); a panel whose rows are cards (news) passes its own. */
  rowHeight?: number;
  render: (d: T) => React.ReactNode;
}) {
  const { data, error, loading } = useJson<T>(url);
  return (
    <section style={{ marginBottom: space[24] }}>
      <h2 style={h2Style}>{title}</h2>
      {error && (
        <Banner variant="error">
          {title} unavailable — {error}. Section withheld rather than rendered empty.
        </Banner>
      )}
      {loading && !error && (
        // The loading state must already be the height the body will be, or
        // every panel below it moves when the figures land — measured CLS 0.064
        // on `/` before this. Two things set that height and BOTH are mirrored
        // here: the `rows` list rows (each a reserved `ROW_MIN_HEIGHT` line) and
        // the provenance note, which wraps to two lines on a phone because the
        // raw upstream URL is one unbreakable 148-character token
        // (`overflowWrap: 'anywhere'`). Sizing from the panel's own `rows`
        // contract rather than a per-section magic number is what keeps it
        // correct when a board changes its row count.
        <div style={{ minHeight: (rows ?? 0) * (rowHeight ?? ROW_MIN_HEIGHT) + NOTE_MIN_HEIGHT }}>
          <Loading label={label ?? `loading live figures…`} />
        </div>
      )}
      {!error && data != null && render(data)}
    </section>
  );
}

/** A signed percent, coloured by sign; absent -> `—` in the muted tone. */
export function Change({ v, digits = 2 }: { v: number | null | undefined; digits?: number }) {
  const t = toneOf(v);
  const c = t === 'negative' ? themeColor.red : t === 'positive' ? themeColor.green : themeColor.labelTertiary;
  return <span style={{ color: c }}>{fmtPct(v, digits)}</span>;
}

/**
 * Symbol + optional name, with the coin icon (or a neutral disc when absent).
 *
 * A venue sometimes lists a coin with no ticker yet (pre-launch): the symbol is
 * the empty string and every metric is null. The label falls back to the name so
 * the row is identifiable, and the absent metrics stay `—` — the row is not
 * dropped, because "trending, price unpublished" is real information.
 */
export function CoinCell({ image, symbol, name }: { image: string | null; symbol: string | null; name?: string | null }) {
  const label = symbol || name || DASH;
  const sub = symbol && name ? name : null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: space[8] }}>
      {image
        ? <img src={imgSrc(image)} alt="" width={16} height={16} loading="lazy" decoding="async" style={{ width: space[16], height: space[16], borderRadius: radius.circle }} />
        : <span style={{ width: space[16], height: space[16], borderRadius: radius.circle, background: themeColor.separator, display: 'inline-block' }} />}
      <span style={{ color: themeColor.labelPrimary, fontWeight: fontWeight.bold }}>{label}</span>
      {sub ? <span style={{ color: themeColor.labelTertiary }}>{sub}</span> : null}
    </span>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { alpha, color, fontSize, fontWeight, letterSpacing, radius, space } from '@/styles/tokens';
import { Banner } from '@/ui/banner';
import { Loading } from '@/ui/feedback';
import { imgSrc } from '@/lib/img';
import {
  DASH,
  fmtPct,
  fetchJson,
  toneOf,
} from './client';
// ---- shared styles (token-only; the design gate forbids literals here) ------

export const cardStyle: React.CSSProperties = {
  background: color.bgSecondary,
  border: `1px solid ${color.separator}`,
  borderRadius: radius[8],
  padding: space[12],
};
export const h2Style: React.CSSProperties = {
  margin: `0 0 ${space[8]}px`,
  color: color.blue,
  fontSize: fontSize[15],
  fontWeight: fontWeight.bold,
  letterSpacing: letterSpacing.wide,
};
export const h3Style: React.CSSProperties = {
  margin: `0 0 ${space[8]}px`,
  color: color.blue,
  fontSize: fontSize[12],
  fontWeight: fontWeight.bold,
  letterSpacing: letterSpacing.wide,
};
/** Sub-heading inside a card, for a block that sits under the card's own h3. */
export const h4Style: React.CSSProperties = {
  margin: `${space[12]}px 0 ${space[8]}px`,
  color: color.labelPrimary,
  fontSize: fontSize[11],
  fontWeight: fontWeight.bold,
  letterSpacing: letterSpacing.wide,
};
/** A `<summary>` that reads as a control, not as body copy. */
export const summaryStyle: React.CSSProperties = {
  cursor: 'pointer',
  color: color.blue,
  fontSize: fontSize[11],
  fontWeight: fontWeight.bold,
  letterSpacing: letterSpacing.wide,
  marginTop: space[12],
};
export const noteStyle: React.CSSProperties = {
  margin: `${space[8]}px 0 0`,
  color: color.labelTertiary,
  fontSize: fontSize[11],
};
export const listRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  gap: space[8],
  fontSize: fontSize[11],
};
export const theadRowStyle: React.CSSProperties = {
  color: color.labelTertiary,
  textAlign: 'left',
  borderBottom: `1px solid ${color.separator}`,
};
export const rowStyle: React.CSSProperties = { borderBottom: `1px solid ${alpha(color.separator, 0.4)}` };

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
  render,
}: {
  title: string;
  url: string;
  label?: string;
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
      {loading && !error && <Loading label={label ?? `loading live figures…`} />}
      {!error && data != null && render(data)}
    </section>
  );
}

/** A signed percent, coloured by sign; absent -> `—` in the muted tone. */
export function Change({ v, digits = 2 }: { v: number | null | undefined; digits?: number }) {
  const t = toneOf(v);
  const c = t === 'negative' ? color.red : t === 'positive' ? color.green : color.labelTertiary;
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
        ? <img src={imgSrc(image)} alt="" style={{ width: space[16], height: space[16], borderRadius: radius.circle }} />
        : <span style={{ width: space[16], height: space[16], borderRadius: radius.circle, background: color.separator, display: 'inline-block' }} />}
      <span style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>{label}</span>
      {sub ? <span style={{ color: color.labelTertiary }}>{sub}</span> : null}
    </span>
  );
}

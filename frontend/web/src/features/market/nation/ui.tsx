'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { alpha, color, fontSize, fontWeight, letterSpacing, lineHeight, radius, space } from '@/styles/tokens';
import { Banner } from '@/components/ui/banner';
import { Loading } from '@/components/ui/feedback';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { fmtDateTime, fmtIndicator, fmtIndicatorDelta, fmtRate, tone } from '@/features/market/format';
import { NATION_INDEX_PATH } from '@/features/market/nation/client';

// ---- the payload /api/market/nation/<code> emits ---------------------------

type Prior = { value: number; year: string };

type Row = {
  id: string;
  name: string;
  kind: string;
  decimals: number;
  note: string;
  source: string;
  value: number | null;
  year: string | null;
  prior: Prior | null;
};

type Payload = {
  nation: {
    code: string;
    iso2: string;
    name: string;
    region: string;
    currency: string;
    income: string;
    capital: string;
  };
  fx: { currency: string; base: string; rate: number | null; inverse: number | null; updated: number | null } | null;
  policy: { area: string; bank: string; region: string; rate: number | null; date: string | null; note: string } | null;
  blocks: { theme: string; rows: Row[] }[];
  droppedThemes: string[];
  fiscal: { vintage: string; published: string; actualThrough: number; droppedProjections: number } | null;
  fiscalRows: Row[];
  failed: { symbol: string; reason: string }[];
  upstream: string[];
  asOf: number;
  derived: string;
  error?: string;
  detail?: string;
};

// ---- shared styles ---------------------------------------------------------

const cardStyle: CSSProperties = {
  border: `1px solid ${color.border}`,
  borderRadius: radius[8],
  padding: space[16],
  marginBottom: space[16],
  background: alpha(color.bg ?? color.border, 0.2),
};
const groupRowStyle: CSSProperties = {
  padding: `${space[6]}px ${space[8]}px`,
  color: color.textMuted,
  fontSize: fontSize[9],
  fontWeight: fontWeight.semibold,
  letterSpacing: letterSpacing.wider,
  borderBottom: `1px solid ${color.border}`,
  background: alpha(color.border, 0.25),
};
const noteStyle: CSSProperties = {
  color: color.textMuted,
  fontSize: fontSize[10],
  lineHeight: lineHeight.normal,
  margin: `${space[8]}px 0 0`,
};
const metaStyle: CSSProperties = { color: color.textMuted, fontSize: fontSize[11], margin: `${space[4]}px 0 0` };

/** A signed change, coloured by sign; absent -> muted '—'. */
function Delta({ prior, latest, kind, decimals }: { prior: Prior | null; latest: number | null; kind: string; decimals: number }) {
  if (!prior || latest === null) return <span style={{ color: color.textMuted }}>—</span>;
  const d = latest - prior.value;
  const t = tone(d);
  const c = t === 'up' ? color.positive : t === 'down' ? color.negative : color.textMuted;
  return (
    <span style={{ color: c }} title={`vs ${prior.year}: ${fmtIndicator(prior.value, kind, decimals)}`}>
      {fmtIndicatorDelta(d, kind, decimals)}
    </span>
  );
}

/** One themed block of the structural profile. */
function Block({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div style={{ overflowX: 'auto', marginBottom: space[16] }}>
      <Table style={{ fontSize: fontSize[11] }}>
        <THead>
          <TR>
            <TH>{title}</TH>
            <TH align="right">Value</TH>
            <TH align="right">Year</TH>
            <TH align="right">Δ ~10y</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r) => (
            <TR key={r.id}>
              <TD>
                <span title={`${r.note} — ${r.source}`} style={{ color: color.text }}>
                  {r.name}
                </span>
              </TD>
              <TD align="right">{fmtIndicator(r.value, r.kind, r.decimals)}</TD>
              <TD align="right" style={{ color: color.textMuted }}>
                {r.year ?? '—'}
              </TD>
              <TD align="right">
                <Delta prior={r.prior} latest={r.value} kind={r.kind} decimals={r.decimals} />
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

/**
 * One country's economy profile.
 *
 * Every block states the upstream it came from and the horizon that upstream
 * belongs to, because they are NOT the same measurement on the same clock: the
 * currency and the policy rate are daily, the World Bank profile is annual and
 * lags by design, and the IMF fiscal block is an actuals-only slice of one
 * published vintage. Folding them into one undated table would make a 2023 GDP
 * figure read as if it were as current as today's FX rate.
 */
export default function NationBoard({ code }: { code: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    fetch(`/api/market/nation/${encodeURIComponent(code)}`, { cache: 'no-store' })
      .then(async (r) => {
        const body = (await r.json().catch(() => ({}))) as Payload;
        if (!r.ok) throw new Error(body.error ? `${body.error}${body.detail ? ` — ${body.detail}` : ''}` : `HTTP ${r.status}`);
        return body;
      })
      .then((b) => {
        if (alive) {
          setData(b);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [code]);

  const n = data?.nation;

  return (
    <main style={{ maxWidth: 1080, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
      <nav style={{ fontSize: fontSize[11], color: color.textMuted, marginBottom: space[12] }}>
        <Link href="/" style={{ color: color.textMuted }}>
          FUDCOURT
        </Link>
        {' / '}
        <Link href={NATION_INDEX_PATH} style={{ color: color.textMuted }}>
          economy
        </Link>
        {' / nation'}
      </nav>

      {error && <Banner variant="error">{error}</Banner>}
      {loading && !error && <Loading label="reading the country profile…" />}

      {!error && data && n && (
        <>
          <header style={{ marginBottom: space[16] }}>
            <h1 style={{ fontSize: fontSize[32], fontWeight: fontWeight.heavy, margin: 0, color: color.text }}>
              {n.name}
            </h1>
            <p style={metaStyle}>
              <span style={{ color: color.text }}>{n.iso2}</span> · {n.code} · {n.region} · {n.income}
              {n.capital ? ` · capital ${n.capital}` : ''}
            </p>
          </header>

          <div style={{ display: 'flex', gap: space[16], flexWrap: 'wrap' }}>
            <div style={{ ...cardStyle, flex: '1 1 240px' }}>
              <h2 style={{ fontSize: fontSize[12], letterSpacing: letterSpacing.sm, color: color.textMuted, margin: 0 }}>
                CURRENCY
              </h2>
              {data.fx ? (
                <>
                  <p style={{ fontSize: fontSize[20], fontWeight: fontWeight.bold, margin: `${space[6]}px 0 0`, color: color.text }}>
                    1 {data.fx.base} = {fmtRate(data.fx.rate)} {data.fx.currency}
                  </p>
                  <p style={noteStyle} title="the inverse of the same feed rate">
                    1 {data.fx.currency} = {fmtRate(data.fx.inverse)} {data.fx.base}
                    {data.fx.updated !== null ? ` · as of ${fmtDateTime(data.fx.updated)}` : ''}
                  </p>
                </>
              ) : (
                <p style={noteStyle}>withheld — the feed did not return {n.currency}</p>
              )}
            </div>

            <div style={{ ...cardStyle, flex: '1 1 240px' }}>
              <h2 style={{ fontSize: fontSize[12], letterSpacing: letterSpacing.sm, color: color.textMuted, margin: 0 }}>
                POLICY RATE
              </h2>
              {data.policy ? (
                <>
                  <p
                    style={{ fontSize: fontSize[20], fontWeight: fontWeight.bold, margin: `${space[6]}px 0 0`, color: color.text }}
                    title={data.policy.note}
                  >
                    {data.policy.rate === null ? '—' : `${data.policy.rate.toFixed(2)}%`}
                  </p>
                  <p style={noteStyle}>
                    {data.policy.bank}
                    {data.policy.date ? ` · as of ${data.policy.date}` : ''}
                  </p>
                </>
              ) : (
                <p style={noteStyle}>not carried by BIS — this country has no policy-rate series on WS_CBPOL</p>
              )}
            </div>
          </div>

          <h2 style={{ fontSize: fontSize[16], fontWeight: fontWeight.bold, margin: `${space[24]}px 0 ${space[8]}px`, color: color.text }}>
            Structural profile <span style={{ color: color.textMuted, fontWeight: fontWeight.regular, fontSize: fontSize[11] }}>· World Bank, annual — each row carries its own year</span>
          </h2>
          {data.blocks.map((b) => (
            <Block key={b.theme} title={b.theme.toUpperCase()} rows={b.rows} />
          ))}
          {data.droppedThemes.length > 0 && (
            <p style={noteStyle}>
              withheld rather than rendered empty — the World Bank publishes no observation for: {data.droppedThemes.join(', ')}.
            </p>
          )}

          <h2 style={{ fontSize: fontSize[16], fontWeight: fontWeight.bold, margin: `${space[24]}px 0 ${space[8]}px`, color: color.text }}>
            Government finance{' '}
            <span style={{ color: color.textMuted, fontWeight: fontWeight.regular, fontSize: fontSize[11] }}>
              · IMF Fiscal Monitor{data.fiscal ? `, ${data.fiscal.vintage}` : ''}
            </span>
          </h2>
          {data.fiscal ? (
            <>
              <Block title="GOVERNMENT FINANCE" rows={data.fiscalRows} />
              <p style={noteStyle}>
                vintage {data.fiscal.vintage}, published {data.fiscal.published.slice(0, 10)} · actuals through{' '}
                {data.fiscal.actualThrough}
                {data.fiscal.droppedProjections > 0
                  ? ` · ${data.fiscal.droppedProjections} projection observation(s) withheld, because a vintage cannot contain an actual for a fiscal year that had not ended when it was published`
                  : ''}
                . General government (S13), GFS basis — not the national budget presentation.
              </p>
            </>
          ) : (
            <p style={noteStyle}>withheld — the IMF vintage could not be read for this country.</p>
          )}

          <p style={noteStyle}>
            Sources: {data.upstream.join(' · ')} · {data.derived}
          </p>
          {data.failed.length > 0 && (
            <p style={noteStyle}>
              withheld, not zero-filled: {data.failed.map((f) => `${f.symbol} (${f.reason})`).join(', ')}
            </p>
          )}
        </>
      )}
    </main>
  );
}

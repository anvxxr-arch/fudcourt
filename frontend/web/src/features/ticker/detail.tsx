'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { color, fontFamily, fontSize, fontWeight, motion, radius, space } from '@/styles/tokens';
import { Loading } from '@/ui/feedback';
import { fetchTickerInstrument, fetchTickerInstruments } from './client';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';

/**
 * Detail view for one coin across all four CEX market types.
 *
 * Strike and expiry are chosen by the reader and resolved per venue by
 * /api/ticker/instrument, which matches on (expiry, strike, kind) against each
 * venue's own market list. That matters because the same option is spelled
 * differently per venue — `BTC/USD:BTC-260929-84250-C` on OKX versus
 * `BTC/USDT:USDT-260929-84250-C` on Bybit — so a symbol built by hand would be
 * rejected by the venue it was wrong for.
 */

type TickerType = 'spot' | 'swap' | 'future' | 'option';

type TypeSummary = {
  venues: string[];
  expiries: string[];
  /** Strikes keyed by expiry date; the ladder genuinely differs by date. */
  strikesByExpiry: Record<string, number[]>;
  default: { symbol: string; expiry: string | null; strike: number | null; optionKind: string | null } | null;
};
type InstrumentsEnvelope = {
  symbol: string;
  types: Record<TickerType, TypeSummary>;
  venuesForType: Record<TickerType, string[]>;
  typeLabels: Record<TickerType, string>;
};

type Instrument = {
  symbol: string;
  type: string;
  settle: string | null;
  expiry: number | null;
  strike: number | null;
  optionKind: 'call' | 'put' | null;
  contractSize: number | null;
};

type Quote = {
  exchange: string;
  symbol: string;
  /**
   * What this venue's price is denominated in. Venues list the same contract
   * in different units — OKX quotes BTC options coin-margined, Bybit quotes
   * them USDT-settled — so the unit belongs to the quote, not to the coin.
   */
  settle: string | null;
  last: number | null;
  bid: number | null;
  ask: number | null;
  baseVolume: number | null;
  quoteVolume: number | null;
  high24h: number | null;
  low24h: number | null;
  change24h: number | null;
  openInterest: number | null;
  fundingRate: number | null;
  at: number | null;
  error: string | null;
};

type QuoteEnvelope = {
  base: string;
  type: TickerType;
  instruments: Instrument[];
  settlements: string[];
  quotes: Quote[];
  price: number | null;
  notListed: string[];
  failed: string[];
};

const TYPES: TickerType[] = ['spot', 'swap', 'future', 'option'];

export default function TickerDetailPage() {
  const params = useParams<{ ticker: string }>();
  // The URL carries the base coin ("BTC"), not the full pair: the quote
  // currency is a property of a venue's listing, not of the coin.
  const base = (params?.ticker ?? '').toUpperCase();

  const [meta, setMeta] = useState<InstrumentsEnvelope | null>(null);
  const [metaError, setMetaError] = useState('');
  const [type, setType] = useState<TickerType>('spot');
  const [expiry, setExpiry] = useState('');
  const [strike, setStrike] = useState('');
  const [kind, setKind] = useState<'call' | 'put'>('call');
  const [data, setData] = useState<QuoteEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);

  // Which expiries, strikes and venues exist for this coin.
  useEffect(() => {
    if (!base) return;
    let cancelled = false;
    setMeta(null);
    setMetaError('');
    fetchTickerInstruments<InstrumentsEnvelope>(base)
      .then((body) => {
        if (cancelled) return;
        setMeta(body);
        // Land on the first type with any instrument, rather than always spot:
        // some coins are listed only as derivatives.
        const first = TYPES.find(t => body.types[t]?.venues.length);
        if (first) setType(first);
      })
      .catch((e) => { if (!cancelled) setMetaError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [base]);

  // Seed the selectors from the chosen type's default instrument.
  useEffect(() => {
    const d = meta?.types[type]?.default;
    if (!d) return;
    setExpiry(d.expiry ?? '');
    setStrike(d.strike === null ? '' : String(d.strike));
    setKind((d.optionKind as 'call' | 'put' | null) ?? 'call');
  }, [meta, type]);

  /**
   * Prices for the selected instrument, across every venue that lists it.
   *
   * Responses are applied only if they are still the newest request. Changing
   * the strike fires a new fetch while the previous one is usually still in
   * flight, and without this guard the slower earlier response can land last
   * and overwrite the newer one — which showed a 78,000 call beside a
   * 84,250 selection and a median computed across two different contracts.
   */
  const requestId = useRef(0);
  const load = useCallback(async () => {
    if (!base) return;
    const id = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const body = await fetchTickerInstrument<QuoteEnvelope>(base, type, { expiry, strike, kind });
      // A superseded request must not write state, including its error state.
      if (id !== requestId.current) return;
      setData(body);
      setStale(false);
    } catch (e) {
      if (id !== requestId.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setStale(true);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [base, type, expiry, strike, kind]);

  // Strikes are a function of the chosen expiry, so changing the date has to
  // re-pick a strike that date actually lists. Keeping the old one would leave
  // the reader on an instrument their chosen month does not have, and the
  // table would honestly report that nobody prices it — confusing rather than
  // wrong, which is still a defect worth not shipping.
  useEffect(() => {
    if (type !== 'option') return;
    const forDate = meta?.types.option.strikesByExpiry[expiry];
    if (!forDate || forDate.length === 0) return;
    if (forDate.includes(Number(strike))) return;
    // Prefer the strike closest to the previously selected one, so moving
    // along the ladder feels continuous.
    const prev = Number(strike);
    const nearest = forDate.reduce((best, s) =>
      Math.abs(s - prev) < Math.abs(best - prev) ? s : best, forDate[0]);
    setStrike(String(nearest));
  }, [expiry, meta, strike, type]);

  // Re-fetch whenever the coin, market type, expiry, strike or kind changes.
  // `load` closes over exactly those, so its identity is the dependency.
  useEffect(() => { load(); }, [load]);

  const summary = meta?.types[type];
  // Strikes belong to the chosen expiry, so this is read after that summary.
  const strikes = summary?.strikesByExpiry[expiry] ?? [];
  const quotes = data?.quotes ?? [];
  const priced = quotes.filter(q => q.last !== null);
  // Cross-venue divergence across the venues that priced it.
  const spread = priced.length < 2 ? null : (() => {
    const prices = priced.map(q => q.last as number);
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    if (mean <= 0) return null;
    return (Math.max(...prices.map(p => Math.abs(p - mean) / mean)) * 100);
  })();

  /**
   * A price is shown in the currency it is actually denominated in.
   *
   * A coin-margined option premium is denominated in the coin: OKX's
   * BTC-settled 260929-84000 call quotes 0.001, which is 0.001 *BTC* (~$83),
   * and rendering that as "$0.001" is wrong by five orders of magnitude. So
   * each quote carries its own settlement and labels itself with it.
   *
   * The headline figure only gets a unit when every priced venue agrees on
   * one. For spot, swaps and futures the same contract is listed by different
   * venues in different units (OKX coin-margined BTC, Bybit USDT, Coinbase
   * USDC) — those are the same money, so a single "83,485 BTC" label on the
   * median would be nonsense. Where they disagree, prices are shown as USD.
   */
  const fmtPrice = (p: number | null, unit: string | null) => {
    if (p === null) return '—';
    const body = p < 0.01 ? p.toExponential(4) : p < 1000 ? p.toFixed(3) : p.toLocaleString('en-US', { minimumFractionDigits: 2 });
    return unit === 'USD' ? `$${body}` : unit ? `${body} ${unit}` : `$${body}`;
  };
  // The headline median's unit, used only when all priced venues agree on it.
  const settle = (() => {
    const units = [...new Set(priced.map(q => q.settle).filter((s): s is string => typeof s === 'string'))];
    return units.length === 1 ? units[0] : 'USD';
  })();
  const fmtVol = (v: number | null) =>
    v === null ? '—' : v < 1e6 ? `$${(v / 1e3).toFixed(0)}K` : v < 1e9 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e9).toFixed(2)}B`;
  const fmtPct = (p: number | null) => (p === null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`);
  const fmtSpread = (s: number | null) => (s === null ? '—' : s === 0 ? '0%' : s < 0.0001 ? `${s.toExponential(1)}%` : `${s.toFixed(4)}%`);
  // Funding is a fraction; shown in basis points, which is how it is quoted.
  const fmtFunding = (f: number | null) => (f === null ? '—' : `${(f * 10000).toFixed(3)} bps`);
  const fmtOi = (o: number | null) => (o === null ? '—' : o.toLocaleString('en-US', { maximumFractionDigits: 0 }));

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: radius[8], fontSize: fontSize[11], cursor: 'pointer',
    background: active ? color.blue : color.bgSecondary, color: active ? color.labelOnAccent : color.labelPrimary,
    border: `1px solid ${color.separator}`, fontWeight: active ? fontWeight.bold : fontWeight.regular,
  });
  const selectStyle: React.CSSProperties = {
    background: color.bgSecondary, color: color.labelPrimary, border: `1px solid ${color.separator}`,
    padding: `5px ${space[8]}px`, borderRadius: radius[8], fontSize: fontSize[11],
  };

  if (!base) return <p style={{ color: color.red, fontSize: fontSize[12] }}>No coin in the URL.</p>;
  if (metaError) return <p style={{ color: color.red, fontSize: fontSize[12] }}>{metaError}</p>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: space[12], flexWrap: 'wrap', gap: space[8] }}>
        <div>
          <h3 style={{ color: color.blue, margin: 0 }}>
            <Link href="/market/crypto" style={{ color: color.labelTertiary, textDecoration: 'none', fontSize: fontSize[13] }}>← </Link>
            {base} · centralized exchange instruments
          </h3>
          <p style={{ color: color.labelTertiary, fontSize: fontSize[11], margin: `${space[4]}px 0 0` }}>
            {summary
              ? `${summary.venues.length} venue${summary.venues.length === 1 ? '' : 's'} list ${meta?.typeLabels[type].toLowerCase() ?? type} for this coin`
              : 'Loading venues…'}
          </p>
        </div>
        <button onClick={load} style={{ background: color.bgSecondary, color: color.labelPrimary, border: `1px solid ${color.separator}`, padding: `${space[8]}px ${space[12]}px`, borderRadius: radius[8], fontSize: fontSize[11], cursor: 'pointer' }}>
          ↻ Refresh
        </button>
      </div>

      <div style={{ display: 'flex', gap: space[8], marginBottom: space[8], flexWrap: 'wrap' }}>
        {TYPES.map(t => {
          const count = meta?.types[t]?.venues.length ?? 0;
          return (
            <button
              key={t}
              onClick={() => setType(t)}
              style={{ ...tabStyle(type === t), opacity: count ? 1 : 0.4 }}
              title={count ? '' : 'No venue lists this type for this coin'}
            >
              {meta?.typeLabels[t] ?? t} ({count})
            </button>
          );
        })}
      </div>

      {summary && (summary.expiries.length > 0 || type === 'option') && (
        <div style={{ display: 'flex', gap: space[12], marginBottom: space[12], alignItems: 'center', flexWrap: 'wrap' }}>
          {summary.expiries.length > 0 && (
            <label style={{ fontSize: fontSize[11], color: color.labelTertiary, display: 'flex', gap: space[8], alignItems: 'center' }}>
              Expiry
              <select value={expiry} onChange={e => setExpiry(e.target.value)} style={selectStyle} aria-label="Expiry">
                {summary.expiries.map(e => <option key={e} value={e}>{e}</option>)}
              </select>
            </label>
          )}
          {type === 'option' && (
            <>
              <label style={{ fontSize: fontSize[11], color: color.labelTertiary, display: 'flex', gap: space[8], alignItems: 'center' }}>
                Strike
                <select value={strike} onChange={e => setStrike(e.target.value)} style={selectStyle} aria-label="Strike">
                  {strikes.length === 0 && <option value="">—</option>}
                  {strikes.map(s => <option key={s} value={String(s)}>{s.toLocaleString('en-US')}</option>)}
                </select>
              </label>
              <label style={{ fontSize: fontSize[11], color: color.labelTertiary }}>
                <select value={kind} onChange={e => setKind(e.target.value as 'call' | 'put')} style={selectStyle} aria-label="Option kind">
                  <option value="call">Call</option>
                  <option value="put">Put</option>
                </select>
              </label>
            </>
          )}
        </div>
      )}

      {error && (
        <p style={{ color: color.red, fontSize: fontSize[12] }}>
          {error}
          {stale && data && ' — showing the last successful read; these prices are stale.'}
        </p>
      )}

      {loading ? (
        <Loading label="Loading..." />
      ) : !data || priced.length === 0 ? (
        <p style={{ color: color.labelTertiary, fontSize: fontSize[12] }}>
          No venue is currently pricing this instrument.
          {data && data.notListed.length > 0 && ` Not listed by: ${data.notListed.join(', ')}.`}
        </p>
      ) : (
        <div style={{ opacity: stale ? 0.45 : 1, transition: 'opacity ' + motion.quick }}>
          <div style={{ display: 'flex', gap: space[20], marginBottom: space[12], flexWrap: 'wrap' }}>
            <Stat label={`Price (median of ${priced.length})`} value={fmtPrice(data.price, settle)} tone={color.blue} />
            <Stat label="Cross-venue spread" value={fmtSpread(spread)} />
            <Stat label="24h change" value={fmtPct(medianOf(priced.map(q => q.change24h)))} tone={chgColor(medianOf(priced.map(q => q.change24h)))} />
            <Stat label="24h volume" value={fmtVol(medianOf(priced.map(q => q.quoteVolume)))} />
            {type === 'swap' && <Stat label="Funding" value={fmtFunding(priced.find(q => q.fundingRate !== null)?.fundingRate ?? null)} />}
            {(type === 'swap' || type === 'future' || type === 'option') && (
              <Stat label="Open interest" value={fmtOi(priced.find(q => q.openInterest !== null)?.openInterest ?? null)} />
            )}
          </div>

          {/* Settlements differ between venues and the prices therefore are not
              directly comparable. Saying so is the honest framing; a reader
              who wants comparable prices can read the settlement column. */}
          {data.settlements.length > 1 && (
            <p style={{ color: color.labelTertiary, fontSize: fontSize[11], margin: `0 0 ${space[8]}px` }}>
              These venues settle in different currencies ({data.settlements.join(', ')}), so the prices are comparable only up to the basis between them.
            </p>
          )}

          <Table>
            <THead>
              <TR style={{ borderBottom: `1px solid ${color.separator}`, color: color.labelTertiary }}>
                <TH style={{ padding: space[8] }}>Venue</TH>
                <TH style={{ padding: space[8] }}>Instrument</TH>
                <TH align="right" style={{ padding: space[8] }}>Last</TH>
                <TH align="right" style={{ padding: space[8] }}>Bid</TH>
                <TH align="right" style={{ padding: space[8] }}>Ask</TH>
                <TH align="right" style={{ padding: space[8] }}>24h %</TH>
                <TH align="right" style={{ padding: space[8] }}>Volume</TH>
                {type !== 'spot' && <TH align="right" style={{ padding: space[8] }}>Open interest</TH>}
                {type === 'swap' && <TH align="right" style={{ padding: space[8] }}>Funding</TH>}
              </TR>
            </THead>
            <TBody>
              {quotes.map(q => (
                <TR key={q.exchange} style={{ borderBottom: `1px solid ${color.separator}`, opacity: q.last === null ? 0.55 : 1 }}>
                  <TD style={{ padding: space[8], color: color.labelPrimary, fontWeight: fontWeight.bold }}>{q.exchange}</TD>
                  <TD mono style={{ padding: space[8], color: color.labelTertiary, fontSize: fontSize[11] }}>{q.symbol}</TD>
                  <TD align="right" mono style={{ padding: space[8], color: q.last === null ? color.labelTertiary : color.blue }}>{fmtPrice(q.last, q.settle)}</TD>
                  <TD align="right" mono style={{ padding: space[8], color: color.labelPrimary }}>{fmtPrice(q.bid, q.settle)}</TD>
                  <TD align="right" mono style={{ padding: space[8], color: color.labelPrimary }}>{fmtPrice(q.ask, q.settle)}</TD>
                  <TD align="right" mono style={{ padding: space[8], color: chgColor(q.change24h) }}>{fmtPct(q.change24h)}</TD>
                  <TD align="right" mono style={{ padding: space[8], color: color.labelPrimary }}>{fmtVol(q.quoteVolume)}</TD>
                  {type !== 'spot' && <TD align="right" mono style={{ padding: space[8], color: color.labelPrimary }}>{fmtOi(q.openInterest)}</TD>}
                  {type === 'swap' && <TD align="right" mono style={{ padding: space[8], color: color.labelPrimary }}>{fmtFunding(q.fundingRate)}</TD>}
                </TR>
              ))}
            </TBody>
          </Table>

          {data.notListed.length > 0 && (
            <p style={{ color: color.labelTertiary, fontSize: fontSize[11], marginTop: space[8] }}>
              Not listed on this instrument: {data.notListed.join(', ')}. That is a fact about the market, not a failed venue.
            </p>
          )}
          {data.failed.length > 0 && (
            <p style={{ color: color.red, fontSize: fontSize[11], marginTop: space[8] }}>
              Listed but did not answer: {data.failed.join(', ')}. Shown as missing rather than filled from another venue.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function chgColor(p: number | null): string | undefined {
  if (p === null) return color.labelTertiary;
  return p >= 0 ? color.blue : color.red;
}

/** Median of the non-null values, or null when there are none. */
function medianOf(values: (number | null)[]): number | null {
  const clean = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div style={{ color: color.labelTertiary, fontSize: fontSize[11] }}>{label}</div>
      <div style={{ color: tone ?? color.labelPrimary, fontSize: fontSize[15], fontWeight: fontWeight.bold }}>{value}</div>
    </div>
  );
}

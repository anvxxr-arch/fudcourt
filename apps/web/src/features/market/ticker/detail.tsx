'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { themeColor, fontSize, fontWeight, motion, radius, space } from '@/styles/tokens';
import { Loading } from '@/ui/feedback';
import { fetchTickerInstrument, fetchTickerInstruments } from './client';
import { TYPES, type InstrumentsEnvelope, type QuoteEnvelope, type TickerType } from './detail-shared';
import { DetailStats } from './detail-stats';
import { DetailTable } from './detail-table';

export type { InstrumentsEnvelope, Instrument, Quote, QuoteEnvelope, TickerType, TypeSummary } from './detail-shared';
export { TYPES } from './detail-shared';
export { chgColor, medianOf, fmtPrice, fmtVol, fmtPct, fmtSpread, fmtFunding, fmtOi, headlineSettle, crossVenueSpread } from './detail-format';
export { DetailStats, Stat } from './detail-stats';
export { DetailTable } from './detail-table';

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
  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: radius[8], fontSize: fontSize[11], cursor: 'pointer',
    background: active ? themeColor.blue : themeColor.bgSecondary, color: active ? themeColor.labelOnAccent : themeColor.labelPrimary,
    border: `1px solid ${themeColor.separator}`, fontWeight: active ? fontWeight.bold : fontWeight.regular,
  });
  const selectStyle: React.CSSProperties = {
    background: themeColor.bgSecondary, color: themeColor.labelPrimary, border: `1px solid ${themeColor.separator}`,
    padding: `5px ${space[8]}px`, borderRadius: radius[8], fontSize: fontSize[11],
  };
  if (!base) return <p style={{ color: themeColor.red, fontSize: fontSize[12] }}>No coin in the URL.</p>;
  if (metaError) return <p style={{ color: themeColor.red, fontSize: fontSize[12] }}>{metaError}</p>;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: space[12], flexWrap: 'wrap', gap: space[8] }}>
        <div>
          <h3 style={{ color: themeColor.blue, margin: 0 }}>
            <Link href="/market/crypto" style={{ color: themeColor.labelTertiary, textDecoration: 'none', fontSize: fontSize[13] }}>← </Link>
            {base} · centralized exchange instruments
          </h3>
          <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], margin: `${space[4]}px 0 0` }}>
            {summary
              ? `${summary.venues.length} venue${summary.venues.length === 1 ? '' : 's'} list ${meta?.typeLabels[type].toLowerCase() ?? type} for this coin`
              : 'Loading venues…'}
          </p>
        </div>
        <button onClick={load} style={{ background: themeColor.bgSecondary, color: themeColor.labelPrimary, border: `1px solid ${themeColor.separator}`, padding: `${space[8]}px ${space[12]}px`, borderRadius: radius[8], fontSize: fontSize[11], cursor: 'pointer' }}>
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
            <label style={{ fontSize: fontSize[11], color: themeColor.labelTertiary, display: 'flex', gap: space[8], alignItems: 'center' }}>
              Expiry
              <select value={expiry} onChange={e => setExpiry(e.target.value)} style={selectStyle} aria-label="Expiry">
                {summary.expiries.map(e => <option key={e} value={e}>{e}</option>)}
              </select>
            </label>
          )}
          {type === 'option' && (
            <>
              <label style={{ fontSize: fontSize[11], color: themeColor.labelTertiary, display: 'flex', gap: space[8], alignItems: 'center' }}>
                Strike
                <select value={strike} onChange={e => setStrike(e.target.value)} style={selectStyle} aria-label="Strike">
                  {strikes.length === 0 && <option value="">—</option>}
                  {strikes.map(s => <option key={s} value={String(s)}>{s.toLocaleString('en-US')}</option>)}
                </select>
              </label>
              <label style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>
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
        <p style={{ color: themeColor.red, fontSize: fontSize[12] }}>
          {error}
          {stale && data && ' — showing the last successful read; these prices are stale.'}
        </p>
      )}
      {loading ? (
        <Loading label="Loading..." />
      ) : !data || priced.length === 0 ? (
        <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>
          No venue is currently pricing this instrument.
          {data && data.notListed.length > 0 && ` Not listed by: ${data.notListed.join(', ')}.`}
        </p>
      ) : (
        <div style={{ opacity: stale ? 0.45 : 1, transition: 'opacity ' + motion.quick }}>
          <DetailStats data={data} type={type} />
          {/* Settlements differ between venues and the prices therefore are not
              directly comparable. Saying so is the honest framing; a reader
              who wants comparable prices can read the settlement column. */}
          {data.settlements.length > 1 && (
            <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], margin: `0 0 ${space[8]}px` }}>
              These venues settle in different currencies ({data.settlements.join(', ')}), so the prices are comparable only up to the basis between them.
            </p>
          )}
          <DetailTable data={data} type={type} />
        </div>
      )}
    </div>
  );
}

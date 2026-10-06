'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { color, fontFamily, fontSize, fontWeight, motion, radius, space } from '@/styles/tokens';
import { Loading } from '@/ui/feedback';
import { fetchTickerBoard } from './client';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';
import { TICKER_TYPES as TYPES, TICKER_TYPE_LABELS as TYPE_LABELS, type TickerType } from './markets';

// Mirrors the /api/ticker envelope (app/api/ticker/route.ts). Prices are
// relayed from each exchange directly, never from an aggregator, and every
// row is cross-checked between venues -- see lib/ticker.ts for why.
type VenueQuote = {
  exchange: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  openInterest: number | null;
  fundingRate: number | null;
};

type TickerInstrument = {
  symbol: string;
  type: string;
  settle: string | null;
  expiry: number | null;
  strike: number | null;
  optionKind: 'call' | 'put' | null;
  contractSize: number | null;
};

type TickerRow = {
  symbol: string;
  base: string;
  quote: string;
  type: TickerType;
  instrument: TickerInstrument;
  price: number | null;
  change24h: number | null;
  quoteVolume: number | null;
  venues: VenueQuote[];
  /** Cross-venue divergence in percent; null when fewer than two venues answered. */
  spread: number | null;
  /** Venues that did not answer for this instrument, by name. */
  failed: string[];
};

type Sort = 'symbol' | 'price' | 'change' | 'volume' | 'spread';
type Order = 'asc' | 'desc';


export default function TickerPage() {
  const [rows, setRows] = useState<TickerRow[]>([]);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('volume');
  const [order, setOrder] = useState<Order>('desc');
  const [type, setType] = useState<TickerType | 'all'>('all');
  const [venues, setVenues] = useState<string[]>([]);
  const [typeCounts, setTypeCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // When a refresh fails the previous rows are kept, but they are stale: the
  // board says so instead of letting old numbers pass for current ones.
  const [stale, setStale] = useState(false);

  /**
   * Responses are applied only if they are still the newest request. Switching
   * market type or sort fires a new fetch while the previous one is usually
   * still in flight, and without this guard the slower earlier response can
   * land last and replace the newer one — showing one market type's rows under
   * another type's heading.
   */
  const requestId = useRef(0);
  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      // Loud failure with the route's real status, never a silent empty table.
      const data = await fetchTickerBoard<TickerRow>(sort, order, type);
      if (id !== requestId.current) return;
      setRows(data.rows || []);
      setVenues(data.exchanges || []);
      setTypeCounts(data.typeCounts || {});
      setStale(false);
    } catch (e) {
      if (id !== requestId.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setStale(true);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [sort, order, type]);

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  /**
   * A price always carries its settlement currency. An option premium settles
   * in the coin on OKX, so its 0.001 means 0.001 BTC — printing that as "$0.001"
   * would be wrong by five orders of magnitude. Rows are grouped by settlement
   * precisely so this label is never ambiguous.
   */
  const fmtPrice = (p: number | null, settle?: string | null) => {
    if (p === null) return '—';
    const unit = settle ?? 'USD';
    const body = p < 0.01 ? p.toExponential(2) : p < 1000 ? p.toFixed(2) : p.toLocaleString('en-US', { minimumFractionDigits: 2 });
    return unit === 'USD' ? `$${body}` : `${body} ${unit}`;
  };
  const fmtVol = (v: number | null) =>
    v === null ? '—' : v < 1e6 ? `$${(v / 1e3).toFixed(0)}K` : v < 1e9 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e9).toFixed(2)}B`;
  // Null = upstream did not report it -> '--', never a fake 0.00%.
  const fmtPct = (p: number | null) => (p === null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`);

  // Cross-venue spreads are fractions of a percent and are usually far below
  // 0.0001% for liquid pairs, so a fixed-decimal percent would print
  // "0.0000%" for most of the board. Significant digits convey the number.
  const fmtSpread = (s: number | null) => {
    if (s === null) return '—';
    if (s === 0) return '0%';
    if (s < 0.0001) return `${s.toExponential(1)}%`;
    return `${s.toFixed(4)}%`;
  };

  /**
   * What a row is actually quoting, in words. A perpetual and a spot BTC are
   * both labelled "BTC/USDT" upstream, so the board says which one this is —
   * without it, a reader would be comparing a spot price against a futures
   * price and calling the difference noise.
   *
   * The settlement currency is shown because it is why two rows of the same
   * type and coin are not comparable: a USD-settled contract and a
   * USDT-settled one legitimately trade at different prices, and the board
   * keeps them apart rather than reporting that basis as venue disagreement.
   */
  const instrumentLabel = (r: TickerRow) => {
    const i = r.instrument;
    if (r.type === 'option' && i.strike !== null) {
      const kind = i.optionKind === 'put' ? 'P' : 'C';
      const exp = i.expiry ? new Date(i.expiry).toISOString().slice(0, 10) : '—';
      return `${exp} ${i.strike.toLocaleString('en-US')} ${kind} · settles ${i.settle ?? '?'}`;
    }
    if (r.type === 'future' && i.expiry) {
      return `${new Date(i.expiry).toISOString().slice(0, 10)} · settles ${i.settle ?? '?'}`;
    }
    if (r.type === 'swap') return `perp · settles ${i.settle ?? '?'}`;
    return '';
  };

  // The route filters/paginates; the search is applied here on the rows we
  // already hold, so typing never refetches.
  const q = search.trim().toUpperCase();
  const shown = q ? rows.filter(r => r.symbol.includes(q) || r.base.includes(q)) : rows;

  // A pair is only cross-checked when two independent venues answered, and a
  // blank spread is dimmed to say so. Thresholds are in percent: under 0.01%
  // the venues agree for practical purposes, over 0.1% is a real divergence
  // worth looking at before trusting the displayed median.
  const spreadColor = (r: TickerRow) => {
    if (r.spread === null) return color.labelTertiary;
    if (r.spread < 0.01) return color.blue;
    if (r.spread < 0.1) return color.labelPrimary;
    return color.red;
  };

  const toggleSort = (key: Sort) => {
    if (key === sort) setOrder(o => (o === 'desc' ? 'asc' : 'desc'));
    else { setSort(key); setOrder(key === 'symbol' ? 'asc' : 'desc'); }
  };
  const arrow = (key: Sort) => (sort !== key ? '' : order === 'desc' ? ' ↓' : ' ↑');

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: radius[8], fontSize: fontSize[11], cursor: 'pointer',
    background: active ? color.blue : color.bgSecondary,
    color: active ? color.labelOnAccent : color.labelPrimary,
    border: `1px solid ${color.separator}`,
    fontWeight: active ? fontWeight.bold : fontWeight.regular,
  });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: space[12], flexWrap: 'wrap', gap: space[8] }}>
        <div>
          <h3 style={{ color: color.blue, margin: 0 }}>Exchange Ticker</h3>
          <p style={{ color: color.labelTertiary, fontSize: fontSize[11], margin: `${space[4]}px 0 0` }}>
            Centralized-exchange instruments relayed from {venues.join(', ') || '—'} and cross-checked between venues. Not a market-cap ranking.
          </p>
        </div>
        <div style={{ display: 'flex', gap: space[8], alignItems: 'center' }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter symbol"
            aria-label="Filter symbol"
            style={{ background: color.bgSecondary, color: color.labelPrimary, border: `1px solid ${color.separator}`, padding: `${space[8]}px ${space[8]}px`, borderRadius: radius[8], fontSize: fontSize[11], width: 120 }}
          />
          <button onClick={load} style={{ background: color.bgSecondary, color: color.labelPrimary, border: `1px solid ${color.separator}`, padding: `${space[8]}px ${space[12]}px`, borderRadius: radius[8], fontSize: fontSize[11], cursor: 'pointer' }}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Market type is a first-class filter, not a column: a spot price and a
          perpetual price are different instruments, so they are listed apart. */}
      <div style={{ display: 'flex', gap: space[8], marginBottom: space[8], flexWrap: 'wrap' }}>
        <button onClick={() => setType('all')} style={tabStyle(type === 'all')}>
          All ({Object.values(typeCounts).reduce((a, b) => a + b, 0)})
        </button>
        {TYPES.map(t => (
          <button key={t} onClick={() => setType(t)} style={tabStyle(type === t)}>
            {TYPE_LABELS[t]} ({typeCounts[t] ?? 0})
          </button>
        ))}
      </div>

      {error && (
        <p style={{ color: color.red, fontSize: fontSize[12] }}>
          {error}
          {stale && rows.length > 0 && ' — showing the last successful read; these prices are stale.'}
        </p>
      )}

      {loading ? (
        <Loading label="Loading..." />
      ) : (
        <div style={{ opacity: stale ? 0.45 : 1, transition: 'opacity ' + motion.quick }}>
          <Table>
            <THead>
              <TR style={{ borderBottom: `1px solid ${color.separator}`, color: color.labelTertiary }}>
                <TH style={{ padding: space[8] }}><span onClick={() => toggleSort('symbol')} style={{ cursor: 'pointer' }}>Pair{arrow('symbol')}</span></TH>
                <TH style={{ padding: space[8] }}>Instrument</TH>
                <TH align="right" style={{ padding: space[8] }}><span onClick={() => toggleSort('price')} style={{ cursor: 'pointer' }}>Price{arrow('price')}</span></TH>
                <TH align="right" style={{ padding: space[8] }}><span onClick={() => toggleSort('change')} style={{ cursor: 'pointer' }}>24h %{arrow('change')}</span></TH>
                <TH align="right" style={{ padding: space[8] }}><span onClick={() => toggleSort('volume')} style={{ cursor: 'pointer' }}>Volume{arrow('volume')}</span></TH>
                <TH align="right" style={{ padding: space[8] }}><span onClick={() => toggleSort('spread')} style={{ cursor: 'pointer' }}>Spread{arrow('spread')}</span></TH>
                <TH align="right" style={{ padding: space[8] }}>Venues</TH>
              </TR>
            </THead>
            <TBody>
              {shown.map((r) => (
                <TR key={`${r.type}|${r.symbol}`} style={{ borderBottom: `1px solid ${color.separator}` }}>
                  <TD style={{ padding: space[8] }}>
                    <Link
                      href={`/market/crypto/${r.base}`}
                      style={{ fontWeight: fontWeight.bold, color: color.blue, textDecoration: 'none' }}
                      title={`Open ${r.base} detail`}
                    >
                      {r.base}
                    </Link>
                    <div style={{ fontSize: fontSize[11], color: color.labelTertiary }}>{r.quote}</div>
                  </TD>
                  <TD style={{ padding: space[8] }}>
                    <div style={{ color: color.labelPrimary, fontSize: fontSize[11] }}>{TYPE_LABELS[r.type]}</div>
                    {instrumentLabel(r) && (
                      <div style={{ fontSize: fontSize[11], color: color.labelTertiary, fontFamily: fontFamily.mono }}>{instrumentLabel(r)}</div>
                    )}
                  </TD>
                  <TD align="right" mono style={{ padding: space[8], color: color.blue, fontWeight: fontWeight.bold }}>{fmtPrice(r.price, r.instrument.settle)}</TD>
                  <TD align="right" mono style={{ padding: space[8], color: r.change24h === null ? color.labelTertiary : r.change24h >= 0 ? color.blue : color.red }}>
                    {fmtPct(r.change24h)}
                  </TD>
                  <TD align="right" mono style={{ padding: space[8], color: color.labelPrimary }}>{fmtVol(r.quoteVolume)}</TD>
                  <TD align="right" mono style={{ padding: space[8], color: spreadColor(r), fontFamily: fontFamily.mono }}>
                    <span title="Cross-venue divergence in percent, relative to the median of the venues that answered">{fmtSpread(r.spread)}</span>
                  </TD>
                  <TD align="right" style={{ padding: space[8] }}>
                    <div style={{ color: color.labelPrimary }}>{r.venues.map(v => v.exchange).join(' · ')}</div>
                    {r.failed.length > 0 && (
                      <div style={{ fontSize: fontSize[11], color: color.red }}>no quote: {r.failed.join(', ')}</div>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}

      {!loading && shown.length === 0 && !error && (
        <p style={{ color: color.labelTertiary, fontSize: fontSize[12] }}>No pair matches “{search}”.</p>
      )}
    </div>
  );
}

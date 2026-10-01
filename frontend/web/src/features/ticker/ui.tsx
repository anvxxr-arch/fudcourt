'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { C } from '@/styles/shared';

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

type TickerType = 'spot' | 'swap' | 'future' | 'option';
type Sort = 'symbol' | 'price' | 'change' | 'volume' | 'spread';
type Order = 'asc' | 'desc';

const TYPE_LABELS: Record<TickerType, string> = {
  spot: 'Spot',
  swap: 'Perpetual',
  future: 'Dated future',
  option: 'Option',
};
const TYPES: TickerType[] = ['spot', 'swap', 'future', 'option'];

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
      const res = await fetch(`/api/ticker?sort=${sort}&order=${order}&type=${type}`, { cache: 'no-store' });
      if (!res.ok) {
        // Loud failure with the route's real error, never a silent empty table.
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ? `${body.error}: ${body.detail ?? ''}`.trim() : `HTTP ${res.status}`);
      }
      const data = await res.json();
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
    if (r.spread === null) return C.dim;
    if (r.spread < 0.01) return C.green;
    if (r.spread < 0.1) return C.white;
    return C.red;
  };

  const toggleSort = (key: Sort) => {
    if (key === sort) setOrder(o => (o === 'desc' ? 'asc' : 'desc'));
    else { setSort(key); setOrder(key === 'symbol' ? 'asc' : 'desc'); }
  };
  const arrow = (key: Sort) => (sort !== key ? '' : order === 'desc' ? ' ↓' : ' ↑');

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
    background: active ? C.accent : C.card,
    color: active ? '#06281c' : C.white,
    border: `1px solid ${C.border}`,
    fontWeight: active ? 700 : 400,
  });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 style={{ color: C.accent, margin: 0 }}>Exchange Ticker</h3>
          <p style={{ color: C.dim, fontSize: 11, margin: '4px 0 0' }}>
            Centralized-exchange instruments relayed from {venues.join(', ') || '—'} and cross-checked between venues. Not a market-cap ranking.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter symbol"
            aria-label="Filter symbol"
            style={{ background: C.card, color: C.white, border: `1px solid ${C.border}`, padding: '6px 10px', borderRadius: 6, fontSize: 11, width: 120 }}
          />
          <button onClick={load} style={{ background: C.card, color: C.white, border: `1px solid ${C.border}`, padding: '6px 14px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Market type is a first-class filter, not a column: a spot price and a
          perpetual price are different instruments, so they are listed apart. */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
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
        <p style={{ color: C.red, fontSize: 12 }}>
          {error}
          {stale && rows.length > 0 && ' — showing the last successful read; these prices are stale.'}
        </p>
      )}

      {loading ? (
        <p style={{ color: C.dim, fontSize: 12 }}>Loading...</p>
      ) : (
        <div style={{ opacity: stale ? 0.45 : 1, transition: 'opacity 150ms' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.border}`, color: C.dim }}>
                <th style={{ textAlign: 'left', padding: 6, cursor: 'pointer' }} onClick={() => toggleSort('symbol')}>Pair{arrow('symbol')}</th>
                <th style={{ textAlign: 'left', padding: 6 }}>Instrument</th>
                <th style={{ textAlign: 'right', padding: 6, cursor: 'pointer' }} onClick={() => toggleSort('price')}>Price{arrow('price')}</th>
                <th style={{ textAlign: 'right', padding: 6, cursor: 'pointer' }} onClick={() => toggleSort('change')}>24h %{arrow('change')}</th>
                <th style={{ textAlign: 'right', padding: 6, cursor: 'pointer' }} onClick={() => toggleSort('volume')}>Volume{arrow('volume')}</th>
                <th style={{ textAlign: 'right', padding: 6, cursor: 'pointer' }} onClick={() => toggleSort('spread')}>Spread{arrow('spread')}</th>
                <th style={{ textAlign: 'right', padding: 6 }}>Venues</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={`${r.type}|${r.symbol}`} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: 6 }}>
                    <Link
                      href={`/ticker/${r.base}`}
                      style={{ fontWeight: 700, color: C.accent, textDecoration: 'none' }}
                      title={`Open ${r.base} detail`}
                    >
                      {r.base}
                    </Link>
                    <div style={{ fontSize: 10, color: C.dim }}>{r.quote}</div>
                  </td>
                  <td style={{ padding: 6 }}>
                    <div style={{ color: C.white, fontSize: 11 }}>{TYPE_LABELS[r.type]}</div>
                    {instrumentLabel(r) && (
                      <div style={{ fontSize: 10, color: C.dim, fontFamily: 'monospace' }}>{instrumentLabel(r)}</div>
                    )}
                  </td>
                  <td style={{ padding: 6, textAlign: 'right', color: C.accent, fontWeight: 700 }}>{fmtPrice(r.price, r.instrument.settle)}</td>
                  <td style={{ padding: 6, textAlign: 'right', color: r.change24h === null ? C.dim : r.change24h >= 0 ? C.green : C.red }}>
                    {fmtPct(r.change24h)}
                  </td>
                  <td style={{ padding: 6, textAlign: 'right', color: C.white }}>{fmtVol(r.quoteVolume)}</td>
                  <td style={{ padding: 6, textAlign: 'right', color: spreadColor(r), fontFamily: 'monospace' }} title="Cross-venue divergence in percent, relative to the median of the venues that answered">
                    {fmtSpread(r.spread)}
                  </td>
                  <td style={{ padding: 6, textAlign: 'right' }}>
                    <div style={{ color: C.white }}>{r.venues.map(v => v.exchange).join(' · ')}</div>
                    {r.failed.length > 0 && (
                      <div style={{ fontSize: 10, color: C.red }}>no quote: {r.failed.join(', ')}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && shown.length === 0 && !error && (
        <p style={{ color: C.dim, fontSize: 12 }}>No pair matches “{search}”.</p>
      )}
    </div>
  );
}

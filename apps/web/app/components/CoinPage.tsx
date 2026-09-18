'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { C } from '../../lib/ui/shared';

type Coin = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  name?: string;
  image?: string;
  lastPrice: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  quoteVolume: number;
  marketCap: number;
  rank: number;
  count: number;
};

type MarketsResponse = {
  coins: Coin[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  timestamp: number;
};

export default function CoinPage() {
  const [data, setData] = useState<MarketsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('volume');
  const [order, setOrder] = useState('desc');
  const [page, setPage] = useState(1);

  const limit = 50;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        search, sort, order, limit: String(limit), page: String(page),
      });
      const res = await fetch(`/api/markets?${params}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('API error');
      const json: MarketsResponse = await res.json();
      setData(json);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [search, sort, order, page, limit]);

  useEffect(() => { load(); }, [load]);

  const sortedCoins = useMemo(() => data?.coins || [], [data]);

  const fmtPrice = (p: number) => {
    if (p === 0) return '$0.00';
    if (p < 0.001) return `$${p.toExponential(2)}`;
    if (p < 1) return `$${p.toFixed(6)}`;
    if (p < 1000) return `$${p.toFixed(2)}`;
    return `$${p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const fmtVol = (v: number) => {
    if (v === 0) return '$0';
    if (v < 1000) return `$${v.toFixed(0)}`;
    if (v < 1e6) return `$${(v / 1e3).toFixed(0)}K`;
    if (v < 1e9) return `$${(v / 1e6).toFixed(1)}M`;
    return `$${(v / 1e9).toFixed(2)}B`;
  };

  const fmtMcap = (m: number) => {
    if (m === 0) return '$0';
    if (m < 1e6) return `$${(m / 1e3).toFixed(0)}K`;
    if (m < 1e9) return `$${(m / 1e6).toFixed(0)}M`;
    return `$${(m / 1e9).toFixed(2)}B`;
  };

  const fmtPct = (p: number) => {
    if (!p) return '0.00%';
    const sign = p >= 0 ? '+' : '';
    return `${sign}${p.toFixed(2)}%`;
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h3 style={{ color: C.accent, margin: 0 }}>Coin Explorer — CoinGecko</h3>
        <div style={{ fontSize: 11, color: C.dim }}>
          {data ? `${data.total.toLocaleString()} coins · Top by market cap` : 'Top coins by market cap'}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, margin: '12px 0', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Search coin (e.g. BTC, ETH, Solana)..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          style={{
            background: C.bg, color: C.white, border: `1px solid ${C.border}`,
            padding: '6px 10px', borderRadius: 6, fontSize: 12, flex: 1, minWidth: 160,
          }}
        />
        <select
          value={sort}
          onChange={(e) => { setSort(e.target.value); setPage(1); }}
          style={{ background: C.bg, color: C.white, border: `1px solid ${C.border}`, padding: '6px 10px', borderRadius: 6, fontSize: 12 }}
        >
          <option value="volume">Volume</option>
          <option value="price">Price</option>
          <option value="change">24h Change</option>
          <option value="name">Name</option>
        </select>
        <button
          onClick={() => { setOrder(order === 'desc' ? 'asc' : 'desc'); setPage(1); }}
          style={{ background: C.card, color: C.white, border: `1px solid ${C.border}`, padding: '6px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}
        >
          {order === 'desc' ? '↓ Desc' : '↑ Asc'}
        </button>
      </div>

      {error && <p style={{ color: C.red, fontSize: 12 }}>{error}</p>}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${C.border}`, color: C.dim }}>
            <th style={{ textAlign: 'left', padding: 6, width: 30 }}>#</th>
            <th style={{ textAlign: 'left', padding: 6 }}>Coin</th>
            <th style={{ textAlign: 'right', padding: 6 }}>Price</th>
            <th style={{ textAlign: 'right', padding: 6 }}>24h %</th>
            <th style={{ textAlign: 'right', padding: 6 }}>High</th>
            <th style={{ textAlign: 'right', padding: 6 }}>Low</th>
            <th style={{ textAlign: 'right', padding: 6 }}>Volume</th>
            <th style={{ textAlign: 'right', padding: 6 }}>Mkt Cap</th>
          </tr>
        </thead>
        <tbody>
          {sortedCoins.map((coin, i) => (
            <tr
              key={coin.symbol + coin.rank}
              style={{ borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}
              onClick={() => window.open(`https://www.coingecko.com/en/coins/${coin.name?.toLowerCase().replace(/ /g, '-') || coin.baseAsset.toLowerCase()}`, '_blank')}
            >
              <td style={{ padding: 6, color: C.dim }}>{coin.rank || (page - 1) * limit + i + 1}</td>
              <td style={{ padding: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {coin.image && (
                    <img src={coin.image} alt={coin.baseAsset} style={{ width: 16, height: 16 }} />
                  )}
                  <div>
                    <div style={{ fontWeight: 700, color: C.white }}>{coin.baseAsset}</div>
                    <div style={{ fontSize: 10, color: C.dim }}>{coin.name || coin.baseAsset}</div>
                  </div>
                </div>
              </td>
              <td style={{ padding: 6, textAlign: 'right', color: C.accent }}>{fmtPrice(coin.lastPrice)}</td>
              <td style={{ padding: 6, textAlign: 'right', color: coin.priceChangePercent >= 0 ? C.green : C.red }}>
                {fmtPct(coin.priceChangePercent)}
              </td>
              <td style={{ padding: 6, textAlign: 'right', color: C.dim }}>{fmtPrice(coin.highPrice)}</td>
              <td style={{ padding: 6, textAlign: 'right', color: C.dim }}>{fmtPrice(coin.lowPrice)}</td>
              <td style={{ padding: 6, textAlign: 'right', color: C.white }}>{fmtVol(coin.quoteVolume)}</td>
              <td style={{ padding: 6, textAlign: 'right', color: C.dim }}>{fmtMcap(coin.marketCap)}</td>
            </tr>
          ))}
          {loading && (
            <tr><td colSpan={8} style={{ padding: 20, textAlign: 'center', color: C.dim }}>Loading...</td></tr>
          )}
          {!loading && sortedCoins.length === 0 && (
            <tr><td colSpan={8} style={{ padding: 20, textAlign: 'center', color: C.dim }}>No coins found</td></tr>
          )}
        </tbody>
      </table>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
        <button
          onClick={() => setPage(Math.max(1, page - 1))}
          disabled={page === 1}
          style={{
            background: page === 1 ? C.bg : C.card, color: page === 1 ? C.dim : C.white,
            border: `1px solid ${C.border}`, padding: '6px 16px', borderRadius: 6,
            cursor: page === 1 ? 'not-allowed' : 'pointer', fontSize: 12,
          }}
        >
          ← Prev
        </button>
        <span style={{ color: C.dim, fontSize: 12 }}>
          Page {page}{data ? ` of ${Math.ceil(data.total / limit)}` : ''} · {data?.total || 0} coins
        </span>
        <button
          onClick={() => setPage(page + 1)}
          disabled={!data?.hasMore}
          style={{
            background: !data?.hasMore ? C.bg : C.card, color: !data?.hasMore ? C.dim : C.white,
            border: `1px solid ${C.border}`, padding: '6px 16px', borderRadius: 6,
            cursor: !data?.hasMore ? 'not-allowed' : 'pointer', fontSize: 12,
          }}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

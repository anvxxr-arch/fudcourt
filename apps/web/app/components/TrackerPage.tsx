'use client';

import { useState, useEffect, useCallback } from 'react';
import { C } from '../../lib/ui/shared';

type Coin = {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  price_change_percentage_24h: number;
  market_cap: number;
  total_volume: number;
};

export default function TrackerPage() {
  const [coins, setCoins] = useState<Coin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(
        'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1',
        { cache: 'no-store' }
      );
      if (!res.ok) throw new Error('API error');
      const data = await res.json();
      setCoins(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  const fmtPrice = (p: number) => p < 0.01 ? `$${p.toExponential(2)}` : p < 1000 ? `$${p.toFixed(2)}` : `$${p.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  const fmtVol = (v: number) => v < 1e6 ? `$${(v/1e3).toFixed(0)}K` : v < 1e9 ? `$${(v/1e6).toFixed(1)}M` : `$${(v/1e9).toFixed(2)}B`;
  const fmtPct = (p: number) => `${p >= 0 ? '+' : ''}${p?.toFixed(2) || '0.00'}%`;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ color: C.accent, margin: 0 }}>Price Tracker</h3>
        <button onClick={load} style={{ background: C.card, color: C.white, border: `1px solid ${C.border}`, padding: '6px 14px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
          ↻ Refresh
        </button>
      </div>

      {error && <p style={{ color: C.red, fontSize: 12 }}>{error}</p>}

      {loading ? (
        <p style={{ color: C.dim, fontSize: 12 }}>Loading...</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.border}`, color: C.dim }}>
              <th style={{ textAlign: 'left', padding: 6 }}>Coin</th>
              <th style={{ textAlign: 'right', padding: 6 }}>Price</th>
              <th style={{ textAlign: 'right', padding: 6 }}>24h %</th>
              <th style={{ textAlign: 'right', padding: 6 }}>Volume</th>
              <th style={{ textAlign: 'right', padding: 6 }}>Mkt Cap</th>
            </tr>
          </thead>
          <tbody>
            {coins.map((c) => (
              <tr key={c.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                <td style={{ padding: 6 }}>
                  <div style={{ fontWeight: 700, color: C.white }}>{c.symbol?.toUpperCase()}</div>
                  <div style={{ fontSize: 10, color: C.dim }}>{c.name}</div>
                </td>
                <td style={{ padding: 6, textAlign: 'right', color: C.accent }}>{fmtPrice(c.current_price)}</td>
                <td style={{ padding: 6, textAlign: 'right', color: c.price_change_percentage_24h >= 0 ? C.green : C.red }}>
                  {fmtPct(c.price_change_percentage_24h)}
                </td>
                <td style={{ padding: 6, textAlign: 'right', color: C.white }}>{fmtVol(c.total_volume)}</td>
                <td style={{ padding: 6, textAlign: 'right', color: C.dim }}>{fmtVol(c.market_cap)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

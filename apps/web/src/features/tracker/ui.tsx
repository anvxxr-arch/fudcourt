'use client';

import { useState, useEffect, useCallback } from 'react';
import { C } from '@/styles/shared';

// Same family shape as /api/markets (lib/markets.ts) -- the tracker used to
// call api.coingecko.com directly from the browser (ungated, hammering CG
// every 30s with no cache or limiter). Re-aligned 2026-09-28: every CoinGecko
// read now goes through the gated, cached, rate-limited proxy.
type Coin = {
  baseAsset: string;
  name?: string;
  lastPrice: number;
  priceChangePercent: number | null;
  quoteVolume: number | null;
  marketCap: number;
};

export default function TrackerPage() {
  const [coins, setCoins] = useState<Coin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/markets?sort=mcap&order=desc&limit=50', { cache: 'no-store' });
      if (!res.ok) {
        // Loud failure with the route's real error, never a silent empty table.
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ? `${body.error}` : `HTTP ${res.status}`);
      }
      const data = await res.json();
      setCoins(data.coins || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  const fmtPrice = (p: number) => p < 0.01 ? `$${p.toExponential(2)}` : p < 1000 ? `$${p.toFixed(2)}` : `$${p.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  const fmtVol = (v: number) => v < 1e6 ? `$${(v/1e3).toFixed(0)}K` : v < 1e9 ? `$${(v/1e6).toFixed(1)}M` : `$${(v/1e9).toFixed(2)}B`;
  // Null = upstream did not report it -> '--', never a fake 0.00%.
  const fmtPct = (p: number | null) => p === null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;

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
              <tr key={c.baseAsset} style={{ borderBottom: `1px solid ${C.border}` }}>
                <td style={{ padding: 6 }}>
                  <div style={{ fontWeight: 700, color: C.white }}>{c.baseAsset?.toUpperCase()}</div>
                  <div style={{ fontSize: 10, color: C.dim }}>{c.name}</div>
                </td>
                <td style={{ padding: 6, textAlign: 'right', color: C.accent }}>{fmtPrice(c.lastPrice)}</td>
                <td style={{ padding: 6, textAlign: 'right', color: c.priceChangePercent === null ? C.dim : c.priceChangePercent >= 0 ? C.green : C.red }}>
                  {fmtPct(c.priceChangePercent)}
                </td>
                <td style={{ padding: 6, textAlign: 'right', color: C.white }}>{c.quoteVolume === null ? '—' : fmtVol(c.quoteVolume)}</td>
                <td style={{ padding: 6, textAlign: 'right', color: C.dim }}>{fmtVol(c.marketCap)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

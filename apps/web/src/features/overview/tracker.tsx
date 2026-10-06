'use client';

import { useState, useEffect, useCallback } from 'react';
import { themeColor, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { Loading } from '@/ui/feedback';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';
import { fetchTrackerCoins, type TrackerCoin as Coin } from './client';

// Same family shape as /api/markets (lib/markets.ts) -- the tracker used to
// call api.coingecko.com directly from the browser (ungated, hammering CG
// every 30s with no cache or limiter). Re-aligned 2026-09-28: every CoinGecko
// read now goes through the gated, cached, rate-limited proxy.

export default function TrackerPage() {
  const [coins, setCoins] = useState<Coin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchTrackerCoins();
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: space[12] }}>
        <h3 style={{ color: themeColor.blue, margin: 0 }}>Price Tracker</h3>
        <button onClick={load} style={{ background: themeColor.bgSecondary, color: themeColor.labelPrimary, border: `1px solid ${themeColor.separator}`, padding: `${space[8]}px ${space[12]}px`, borderRadius: radius[8], fontSize: fontSize[11], cursor: 'pointer' }}>
          ↻ Refresh
        </button>
      </div>

      {error && <p style={{ color: themeColor.red, fontSize: fontSize[12] }}>{error}</p>}

      {loading ? (
        <Loading label="Loading..." />
      ) : (
        <Table>
          <THead>
            <TR style={{ color: themeColor.labelTertiary }}>
              <TH style={{ padding: space[8], fontWeight: fontWeight.regular }}>Coin</TH>
              <TH align="right" style={{ padding: space[8], fontWeight: fontWeight.regular }}>Price</TH>
              <TH align="right" style={{ padding: space[8], fontWeight: fontWeight.regular }}>24h %</TH>
              <TH align="right" style={{ padding: space[8], fontWeight: fontWeight.regular }}>Volume</TH>
              <TH align="right" style={{ padding: space[8], fontWeight: fontWeight.regular }}>Mkt Cap</TH>
            </TR>
          </THead>
          <TBody>
            {coins.map((c) => (
              <TR key={c.baseAsset}>
                <TD style={{ padding: space[8] }}>
                  <div style={{ fontWeight: fontWeight.bold, color: themeColor.labelPrimary }}>{c.baseAsset?.toUpperCase()}</div>
                  <div style={{ fontSize: fontSize[11], color: themeColor.labelTertiary }}>{c.name}</div>
                </TD>
                <TD align="right" mono style={{ padding: space[8], color: themeColor.blue }}>{fmtPrice(c.lastPrice)}</TD>
                <TD align="right" mono style={{ padding: space[8], color: c.priceChangePercent === null ? themeColor.labelTertiary : c.priceChangePercent >= 0 ? themeColor.blue : themeColor.red }}>
                  {fmtPct(c.priceChangePercent)}
                </TD>
                <TD align="right" mono style={{ padding: space[8], color: themeColor.labelPrimary }}>{c.quoteVolume === null ? '—' : fmtVol(c.quoteVolume)}</TD>
                <TD align="right" mono style={{ padding: space[8], color: themeColor.labelTertiary }}>{fmtVol(c.marketCap)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}

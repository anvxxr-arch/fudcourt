'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { color, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { fmtRate, fmtTime } from '@/features/market/format';
import type { ForexPair } from '@/features/market/forex/client';

type Envelope = {
  pairs?: ForexPair[];
  base?: string;
  updated?: number | null;
  derived?: string;
  error?: string;
  detail?: string;
};

/** Forex board: curated major pairs from /api/market/forex. */
export default function ForexBoard() {
  const [pairs, setPairs] = useState<ForexPair[]>([]);
  const [base, setBase] = useState('USD');
  const [updated, setUpdated] = useState<number | null>(null);
  const [derived, setDerived] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/market/forex', { cache: 'no-store' });
      const body: Envelope = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error ? `${body.error}${body.detail ? ` — ${body.detail}` : ''}` : `HTTP ${res.status}`);
      }
      setPairs(body.pairs ?? []);
      setBase(body.base ?? 'USD');
      setUpdated(body.updated ?? null);
      setDerived(body.derived ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const th = (align: 'left' | 'right'): CSSProperties => ({
    textAlign: align,
    padding: space[6],
    color: color.textMuted,
    fontWeight: fontWeight.regular,
  });
  const td = (align: 'left' | 'right'): CSSProperties => ({ textAlign: align, padding: space[6] });

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: space[8],
          flexWrap: 'wrap',
          marginBottom: space[12],
        }}
      >
        <h3 style={{ color: color.accent, margin: 0 }}>
          Forex — major pairs
          <span style={{ color: color.textMuted, fontSize: fontSize[11], fontWeight: fontWeight.regular }}>
            {' '}
            · base {base}
            {updated ? ` · updated ${fmtTime(updated)}` : ''}
          </span>
        </h3>
        <button
          onClick={load}
          style={{
            background: color.surface,
            color: color.text,
            border: `1px solid ${color.border}`,
            padding: `${space[6]}px ${space[14]}px`,
            borderRadius: radius[6],
            fontSize: fontSize[11],
            cursor: 'pointer',
          }}
        >
          ↻ Refresh
        </button>
      </div>

      {error && <p style={{ color: color.negative, fontSize: fontSize[12] }}>{error}</p>}

      {loading ? (
        <p style={{ color: color.textMuted, fontSize: fontSize[12] }}>Loading…</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: fontSize[12] }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${color.border}` }}>
              <th style={th('left')}>Pair</th>
              <th style={th('right')}>Rate</th>
              <th style={th('right')}>Inverse</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((p) => (
              <tr key={p.pair} style={{ borderBottom: `1px solid ${color.border}` }}>
                <td style={{ ...td('left'), fontWeight: fontWeight.bold, color: color.text }}>{p.pair}</td>
                <td style={{ ...td('right'), color: color.accent }}>{fmtRate(p.rate)}</td>
                <td style={{ ...td('right'), color: color.textMuted }}>{fmtRate(p.inverse)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {derived && <p style={{ color: color.textMuted, fontSize: fontSize[10], marginTop: space[10] }}>{derived}</p>}
    </div>
  );
}

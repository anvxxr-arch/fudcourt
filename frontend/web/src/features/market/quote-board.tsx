'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { color, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { dash, fmtCurrency, fmtPct, fmtPrice, fmtVolume, tone } from '@/features/market/format';
import type { MarketQuote } from '@/features/market/quotes';

type Envelope = {
  quotes?: MarketQuote[];
  failed?: { symbol: string; reason: string }[];
  derived?: string;
  error?: string;
  detail?: string;
};

/**
 * One Yahoo-quote board. The stock and commodity sections render the same
 * columns against different endpoints, so the table lives here once.
 */
export default function QuoteBoard({
  endpoint,
  title,
  unitHint,
}: {
  endpoint: string;
  title: string;
  unitHint?: string;
}) {
  const [quotes, setQuotes] = useState<MarketQuote[]>([]);
  const [failed, setFailed] = useState<{ symbol: string; reason: string }[]>([]);
  const [derived, setDerived] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(endpoint, { cache: 'no-store' });
      const body: Envelope = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error ? `${body.error}${body.detail ? ` — ${body.detail}` : ''}` : `HTTP ${res.status}`);
      }
      setQuotes(body.quotes ?? []);
      setFailed(body.failed ?? []);
      setDerived(body.derived ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const toneColor = (v: number | null): string =>
    tone(v) === 'up' ? color.accent : tone(v) === 'down' ? color.negative : color.textMuted;
  const th = (align: 'left' | 'right'): CSSProperties => ({
    textAlign: align,
    padding: space[6],
    color: color.textMuted,
    fontWeight: fontWeight.regular,
    whiteSpace: 'nowrap',
  });
  const td = (align: 'left' | 'right'): CSSProperties => ({
    textAlign: align,
    padding: space[6],
    whiteSpace: 'nowrap',
  });

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
          {title}
          {unitHint ? (
            <span style={{ color: color.textMuted, fontSize: fontSize[11], fontWeight: fontWeight.regular }}>
              {' '}
              · {unitHint}
            </span>
          ) : null}
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
              <th style={th('left')}>Instrument</th>
              <th style={th('right')}>Last</th>
              <th style={th('right')}>Chg</th>
              <th style={th('right')}>Chg %</th>
              <th style={th('right')}>Day range</th>
              <th style={th('right')}>Volume</th>
            </tr>
          </thead>
          <tbody>
            {quotes.map((q) => (
              <tr key={q.symbol} style={{ borderBottom: `1px solid ${color.border}` }}>
                <td style={td('left')}>
                  <div style={{ fontWeight: fontWeight.bold, color: color.text }}>{q.symbol}</div>
                  <div style={{ fontSize: fontSize[10], color: color.textMuted }}>
                    {q.name}
                    {q.exchange ? ` · ${q.exchange}` : ''}
                  </div>
                </td>
                <td style={{ ...td('right'), color: color.accent }}>
                  {fmtPrice(q.price)}
                  {q.currency ? (
                    <span style={{ color: color.textMuted, fontSize: fontSize[10] }}> {fmtCurrency(q.currency)}</span>
                  ) : null}
                </td>
                <td style={{ ...td('right'), color: toneColor(q.change) }}>
                  {q.change === null ? dash : `${q.change >= 0 ? '+' : ''}${fmtPrice(q.change)}`}
                </td>
                <td style={{ ...td('right'), color: toneColor(q.changePercent) }}>{fmtPct(q.changePercent)}</td>
                <td style={{ ...td('right'), color: color.textMuted }}>
                  {q.dayLow === null || q.dayHigh === null ? dash : `${fmtPrice(q.dayLow)} – ${fmtPrice(q.dayHigh)}`}
                </td>
                <td style={{ ...td('right'), color: color.text }}>{fmtVolume(q.volume)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ marginTop: space[10], color: color.textMuted, fontSize: fontSize[10] }}>
        {derived}
        {failed.length > 0 && (
          <span style={{ color: color.warn }}>
            {' '}
            · {failed.length} failed: {failed.map((f) => `${f.symbol} (${f.reason})`).join(', ')}
          </span>
        )}
      </div>
    </div>
  );
}

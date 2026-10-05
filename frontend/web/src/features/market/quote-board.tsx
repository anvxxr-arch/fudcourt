'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { color, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { Loading } from '@/ui/feedback';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';
import { Toolbar } from '@/ui/toolbar';
import { dash, fmtCurrency, fmtPct, fmtPrice, fmtVolume, tone } from '@/lib/format';
import { fetchQuotes, type MarketQuote } from '@/features/market/clients';

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
      const body = await fetchQuotes(endpoint);
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
    tone(v) === 'up' ? color.blue : tone(v) === 'down' ? color.red : color.labelTertiary;
  // `TH` already defaults `color` to `color.labelTertiary` and takes `align` as a prop; the
  // padding / weight / nowrap are this board's own and ride the atom's last-wins spread.
  const thStyle: CSSProperties = {
    padding: space[8],
    fontWeight: fontWeight.regular,
    whiteSpace: 'nowrap',
  };
  const tdStyle: CSSProperties = { padding: space[8], whiteSpace: 'nowrap' };

  return (
    <div>
      <Toolbar
        style={{ alignItems: 'baseline', gap: space[8], flexWrap: 'wrap', marginBottom: space[12] }}
        actions={
          <button
            onClick={load}
            style={{
              background: color.bgSecondary,
              color: color.labelPrimary,
              border: `1px solid ${color.separator}`,
              padding: `${space[8]}px ${space[12]}px`,
              borderRadius: radius[8],
              fontSize: fontSize[11],
              cursor: 'pointer',
            }}
          >
            ↻ Refresh
          </button>
        }
      >
        <h3 style={{ color: color.blue, margin: 0 }}>
          {title}
          {unitHint ? (
            <span style={{ color: color.labelTertiary, fontSize: fontSize[11], fontWeight: fontWeight.regular }}>
              {' '}
              · {unitHint}
            </span>
          ) : null}
        </h3>
      </Toolbar>

      {error && <p style={{ color: color.red, fontSize: fontSize[12] }}>{error}</p>}

      {loading ? (
        <Loading />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH style={thStyle}>Instrument</TH>
              <TH align="right" style={thStyle}>Last</TH>
              <TH align="right" style={thStyle}>Chg</TH>
              <TH align="right" style={thStyle}>Chg %</TH>
              <TH align="right" style={thStyle}>Day range</TH>
              <TH align="right" style={thStyle}>Volume</TH>
            </TR>
          </THead>
          <TBody>
            {quotes.map((q) => (
              <TR key={q.symbol}>
                <TD style={tdStyle}>
                  <div style={{ fontWeight: fontWeight.bold, color: color.labelPrimary }}>{q.symbol}</div>
                  <div style={{ fontSize: fontSize[11], color: color.labelTertiary }}>
                    {q.name}
                    {q.exchange ? ` · ${q.exchange}` : ''}
                  </div>
                </TD>
                <TD align="right" style={{ ...tdStyle, color: color.blue }}>
                  {fmtPrice(q.price)}
                  {q.currency ? (
                    <span style={{ color: color.labelTertiary, fontSize: fontSize[11] }}> {fmtCurrency(q.currency)}</span>
                  ) : null}
                </TD>
                <TD align="right" style={{ ...tdStyle, color: toneColor(q.change) }}>
                  {q.change === null ? dash : `${q.change >= 0 ? '+' : ''}${fmtPrice(q.change)}`}
                </TD>
                <TD align="right" style={{ ...tdStyle, color: toneColor(q.changePercent) }}>{fmtPct(q.changePercent)}</TD>
                <TD align="right" style={{ ...tdStyle, color: color.labelTertiary }}>
                  {q.dayLow === null || q.dayHigh === null ? dash : `${fmtPrice(q.dayLow)} – ${fmtPrice(q.dayHigh)}`}
                </TD>
                <TD align="right" style={{ ...tdStyle, color: color.labelPrimary }}>{fmtVolume(q.volume)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <div style={{ marginTop: space[8], color: color.labelTertiary, fontSize: fontSize[11] }}>
        {derived}
        {failed.length > 0 && (
          <span style={{ color: color.orange }}>
            {' '}
            · {failed.length} failed: {failed.map((f) => `${f.symbol} (${f.reason})`).join(', ')}
          </span>
        )}
      </div>
    </div>
  );
}

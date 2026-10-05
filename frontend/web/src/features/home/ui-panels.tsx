'use client';

import { color, fontWeight, space } from '@/styles/tokens';
import { Banner } from '@/ui/banner';
import { Loading } from '@/ui/feedback';
import {
  FOREX_URL,
  fmtPrice,
  fmtRate,
  type CrMovers,
  type ForexEnvelope,
  type QuotesEnvelope,
} from './client';
import { Change, CoinCell, cardStyle, h3Style, listRowStyle, noteStyle, useJson } from './ui-shared';
import { Sparkline } from '@/ui/sparkline';

// ---- sections that need more than a single fetch ----------------------------

/** One column of the gainers/losers pair. */
export function MoversColumn({ title, url }: { title: string; url: string }) {
  const { data, error, loading } = useJson<CrMovers>(url);
  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>{title}</h3>
      {error && <Banner variant="error">{error}</Banner>}
      {loading && !error && <Loading label={`loading live figures…`} />}
      {!error && data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
          {data.rows.slice(0, 6).map((r, i) => (
            <div key={`${r.key ?? r.symbol ?? 'row'}-${i}`} style={listRowStyle}>
              <CoinCell image={r.image} symbol={r.symbol} />
              <span style={{ color: color.labelPrimary, whiteSpace: 'nowrap' }}>{fmtPrice(r.priceUsd)}</span>
              <Change v={r.change24h} />
            </div>
          ))}
        </div>
      )}
      {!error && data && <p style={noteStyle}>{data.changeSource} · {data.upstream}</p>}
    </div>
  );
}

/** FX majors. The upstream carries no change, so none is shown — never a fake 0%. */
export function FxColumn() {
  const { data, error, loading } = useJson<ForexEnvelope>(FOREX_URL);
  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>FX majors</h3>
      {error && <Banner variant="error">{error}</Banner>}
      {loading && !error && <Loading label="loading live figures…" />}
      {!error && data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
          {data.pairs.slice(0, 5).map(p => (
            <div key={p.pair} style={listRowStyle}>
              <span style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>{p.pair}</span>
              <span style={{ color: color.labelPrimary }}>{fmtRate(p.rate)}</span>
            </div>
          ))}
        </div>
      )}
      {!error && data && <p style={noteStyle}>base {data.base} · {data.derived}</p>}
    </div>
  );
}

/** Commodities or stock indices — the same Yahoo shape, one column each. */
export function QuoteColumn({ title, url }: { title: string; url: string }) {
  const { data, error, loading } = useJson<QuotesEnvelope>(url);
  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>{title}</h3>
      {error && <Banner variant="error">{error}</Banner>}
      {loading && !error && <Loading label={`loading live figures…`} />}
      {!error && data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
          {data.quotes.slice(0, 5).map(q => (
            <div key={q.symbol} style={listRowStyle}>
              <span style={{ color: color.labelPrimary, fontWeight: fontWeight.bold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.name}</span>
              <Sparkline points={q.trend ?? []} width={64} height={16} />
              <span style={{ color: color.labelPrimary, whiteSpace: 'nowrap' }}>{fmtPrice(q.price)}</span>
              <Change v={q.changePercent} />
            </div>
          ))}
        </div>
      )}
      {!error && data && (
        <p style={noteStyle}>
          {data.derived}{data.failed.length > 0 ? ` · failed: ${data.failed.join(', ')}` : ''}
        </p>
      )}
    </div>
  );
}

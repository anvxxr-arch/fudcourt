'use client';
import { Fragment } from 'react';
import Link from 'next/link';
import { color, fontSize, fontWeight, space } from '@/styles/tokens';
import { Banner } from '@/ui/banner';
import { Loading } from '@/ui/feedback';
import { TBody, TD, TH, THead, TR, Table } from '@/ui/table';
import {
  INDONESIA_URL,
  MACRO_URL,
  fmtBpRaw,
  fmtNum,
  fmtPolicyRate,
  fmtYield,
  type IndonesiaEnvelope,
  type IndonesiaQuote,
  type MacroEnvelope,
} from './client';
import { cardStyle, h3Style, noteStyle, theadRowStyle, rowStyle, listRowStyle, useJson, Change } from './ui-shared';
import { Sparkline } from '@/ui/sparkline';
import { Bp, groupRowStyle } from './ui-boards-macro-policy';
/**
 * Macro — the US Treasury curve, the dollar index and the volatility indices.
 *
 * A yield is quoted in percent and its move is rendered in BASIS POINTS
 * (`Δ × 100`), the convention for a rate; the index rows keep the percent delta.
 * The curve spreads are the route's locally-derived series and are labelled as
 * such. Everything is a read of the macro family; nothing is recomputed here.
 */
export function MacroBoard() {
  const { data, error, loading } = useJson<MacroEnvelope>(MACRO_URL);
  const rates = data ? data.quotes.filter(q => q.unit === 'yield') : [];
  const idx = data ? data.quotes.filter(q => q.unit === 'index') : [];
  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>Rates · dollar · volatility</h3>
      {error && <Banner variant="error">{error}</Banner>}
      {loading && !error && <Loading label="loading live figures…" />}
      {!error && data && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
            {rates.map(q => (
              <div key={q.symbol} style={listRowStyle}>
                <span title={q.note} style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>{q.name}</span>
                <Sparkline points={q.trend ?? []} width={64} height={16} />
                <span style={{ color: color.labelPrimary, whiteSpace: 'nowrap' }}>{fmtYield(q.price)}</span>
                <Bp v={q.change} />
              </div>
            ))}
          </div>
          {data.spreads.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[12], marginTop: space[8] }}>
              {data.spreads.map(s => (
                <span key={s.label} style={{ fontSize: fontSize[11], color: color.labelTertiary }} title={s.note}>
                  {s.label}{' '}
                  <span style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>{fmtBpRaw(s.bp)}</span>
                </span>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: space[8], marginTop: space[12] }}>
            {idx.map(q => (
              <div key={q.symbol} style={listRowStyle}>
                <span title={q.note} style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>{q.name}</span>
                <Sparkline points={q.trend ?? []} width={64} height={16} />
                <span style={{ color: color.labelPrimary, whiteSpace: 'nowrap' }}>{fmtNum(q.price, 2)}</span>
                <Change v={q.changePercent} />
              </div>
            ))}
          </div>
          <p style={{ ...noteStyle, marginTop: space[12] }}>
            {data.policyRates.length} policy rates · {data.indicators.length} indicators · {data.economies.length} economies ×{' '}
            {data.worldIndicators.length} world indicators — full tables on the{' '}
            <Link href="/economy" style={{ color: color.blue }}>economy dashboard →</Link>
          </p>
          <p style={noteStyle}>
            each cell is value · reference year, over its change against the observation ~10 years earlier — a dash there means no
            comparable observation exists, not that nothing moved · a column a table cannot fill is dropped, not shown blank · yields
            in %, delta in basis points (Δ × 100) · curve spreads derived locally, not published upstream · {data.derived}
          </p>
          {data.failed.length > 0 && (
            <p style={noteStyle}>
              withheld, not zero-filled: {data.failed.map(f => f.symbol).join(', ')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
/** The live half of the Indonesia board: rupiah crosses and IDX indices. */
function IndonesiaLive({ quotes }: { quotes: IndonesiaQuote[] }) {
  const groups = Array.from(new Set(quotes.map(q => q.group)));
  return (
    <div style={{ overflowX: 'auto' }}>
      <Table style={{ fontSize: fontSize[11] }}>
        <THead>
          <TR style={theadRowStyle}>
            <TH>Rupiah &amp; IDX</TH>
            <TH align="right">Trend</TH>
            <TH align="right">Level</TH>
            <TH align="right">Δ</TH>
          </TR>
        </THead>
        <TBody>
          {groups.map(g => (
            <Fragment key={g}>
              <TR>
                <TD colSpan={4} style={groupRowStyle}>{g.toUpperCase()}</TD>
              </TR>
              {quotes.filter(q => q.group === g).map(q => (
                <TR key={q.symbol} style={rowStyle}>
                  <TD style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>
                    <span title={q.note}>{q.name}</span>
                  </TD>
                  <TD align="right" style={{ color: color.labelPrimary }}>
                    <Sparkline points={q.trend ?? []} width={64} height={16} />
                  </TD>
                  <TD align="right" style={{ color: color.labelPrimary }}>{fmtNum(q.price, 2)}</TD>
                  <TD align="right"><Change v={q.changePercent} /></TD>
                </TR>
              ))}
            </Fragment>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
/**
 * Indonesia — the rupiah and IDX (live), the BI-Rate, and the annual structure.
 *
 * Three horizons in one panel, each row labelled with the one it belongs to:
 * quotes are live, the BI-Rate carries its BIS observation date, and every World
 * Bank row prints the year it was published FOR. The annual block is deliberately
 * not folded into the live table — a 2025 GDP figure sitting next to a live FX
 * quote reads as if both were current, which is exactly the lie to avoid.
 */
export function IndonesiaBoard() {
  const { data, error, loading } = useJson<IndonesiaEnvelope>(INDONESIA_URL);
  const economyGroups = data ? Array.from(new Set(data.economy.map(e => e.group))) : [];
  return (
    <div style={cardStyle}>
      <h3 style={h3Style}>Rupiah · BI-Rate · economy</h3>
      {error && <Banner variant="error">{error}</Banner>}
      {loading && !error && <Loading label="loading live figures…" />}
      {!error && data && (
        <>
          {data.quotes.length > 0 && <IndonesiaLive quotes={data.quotes} />}
          <p style={{ ...noteStyle, marginTop: space[12] }} title={data.policy.note}>
            {data.policy.label}{' '}
            <span style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>{fmtPolicyRate(data.policy.rate)}</span>
            {data.policy.date ? <span> · as of {data.policy.date}</span> : null}
          </p>
          {economyGroups.length > 0 && (
            <p style={{ ...noteStyle, marginTop: space[12] }}>
              {data.economy.length} annual series across {economyGroups.length} groups (World Bank, IMF Fiscal Monitor) ·{' '}
              <Link href="/economy" style={{ color: color.blue }}>full Indonesia board →</Link>
            </p>
          )}
          <p style={noteStyle}>
            quotes live · BI-Rate from BIS (daily) · annual rows from the World Bank, each with its own year · government finance from the IMF Fiscal Monitor
            {data.apbn ? `, actuals through ${data.apbn.actualThrough}` : ''} · {data.derived}
          </p>
          {data.failed.length > 0 && (
            <p style={noteStyle}>withheld, not zero-filled: {data.failed.map(f => f.symbol).join(', ')}</p>
          )}
        </>
      )}
    </div>
  );
}

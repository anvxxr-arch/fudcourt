import { themeColor, fontSize, fontWeight, space } from '@/styles/tokens';
import type { QuoteEnvelope, TickerType } from './detail-shared';
import { chgColor, fmtFunding, fmtOi, fmtPct, fmtPrice, fmtVol } from './detail-format';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';

export function DetailTable({ data, type }: { data: QuoteEnvelope; type: TickerType }) {
  const quotes = data.quotes ?? [];
  return (
    <>
      <Table>
        <THead>
          <TR style={{ borderBottom: `1px solid ${themeColor.separator}`, color: themeColor.labelTertiary }}>
            <TH style={{ padding: space[8] }}>Venue</TH>
            <TH style={{ padding: space[8] }}>Instrument</TH>
            <TH align="right" style={{ padding: space[8] }}>Last</TH>
            <TH align="right" style={{ padding: space[8] }}>Bid</TH>
            <TH align="right" style={{ padding: space[8] }}>Ask</TH>
            <TH align="right" style={{ padding: space[8] }}>24h %</TH>
            <TH align="right" style={{ padding: space[8] }}>Volume</TH>
            {type !== 'spot' && <TH align="right" style={{ padding: space[8] }}>Open interest</TH>}
            {type === 'swap' && <TH align="right" style={{ padding: space[8] }}>Funding</TH>}
          </TR>
        </THead>
        <TBody>
          {quotes.map(q => (
            <TR key={q.exchange} style={{ borderBottom: `1px solid ${themeColor.separator}`, opacity: q.last === null ? 0.55 : 1 }}>
              <TD style={{ padding: space[8], color: themeColor.labelPrimary, fontWeight: fontWeight.bold }}>{q.exchange}</TD>
              <TD mono style={{ padding: space[8], color: themeColor.labelTertiary, fontSize: fontSize[11] }}>{q.symbol}</TD>
              <TD align="right" mono style={{ padding: space[8], color: q.last === null ? themeColor.labelTertiary : themeColor.blue }}>{fmtPrice(q.last, q.settle)}</TD>
              <TD align="right" mono style={{ padding: space[8], color: themeColor.labelPrimary }}>{fmtPrice(q.bid, q.settle)}</TD>
              <TD align="right" mono style={{ padding: space[8], color: themeColor.labelPrimary }}>{fmtPrice(q.ask, q.settle)}</TD>
              <TD align="right" mono style={{ padding: space[8], color: chgColor(q.change24h) }}>{fmtPct(q.change24h)}</TD>
              <TD align="right" mono style={{ padding: space[8], color: themeColor.labelPrimary }}>{fmtVol(q.quoteVolume)}</TD>
              {type !== 'spot' && <TD align="right" mono style={{ padding: space[8], color: themeColor.labelPrimary }}>{fmtOi(q.openInterest)}</TD>}
              {type === 'swap' && <TD align="right" mono style={{ padding: space[8], color: themeColor.labelPrimary }}>{fmtFunding(q.fundingRate)}</TD>}
            </TR>
          ))}
        </TBody>
      </Table>
      {data.notListed.length > 0 && (
        <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginTop: space[8] }}>
          Not listed on this instrument: {data.notListed.join(', ')}. That is a fact about the market, not a failed venue.
        </p>
      )}
      {data.failed.length > 0 && (
        <p style={{ color: themeColor.red, fontSize: fontSize[11], marginTop: space[8] }}>
          Listed but did not answer: {data.failed.join(', ')}. Shown as missing rather than filled from another venue.
        </p>
      )}
    </>
  );
}

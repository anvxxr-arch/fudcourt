import { color, fontSize, fontWeight, space } from '@/styles/tokens';
import { Meter } from '@/ui/meter';
import type { Quote, QuoteEnvelope, TickerType } from './detail-shared';
import { chgColor, crossVenueSpread, fmtFunding, fmtOi, fmtPct, fmtPrice, fmtSpread, fmtVol, headlineSettle, medianOf } from './detail-format';

export function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div style={{ color: color.labelTertiary, fontSize: fontSize[11] }}>{label}</div>
      <div style={{ color: tone ?? color.labelPrimary, fontSize: fontSize[15], fontWeight: fontWeight.bold }}>{value}</div>
    </div>
  );
}

export function DetailStats({ data, type }: { data: QuoteEnvelope; type: TickerType }) {
  const quotes = data.quotes ?? [];
  const priced: Quote[] = quotes.filter(q => q.last !== null);
  const spread = crossVenueSpread(priced);
  const settle = headlineSettle(priced);
  const chg = medianOf(priced.map(q => q.change24h));
  // Venues whose print sits within 0.1% of the median vs. the rest — the
  // divergence split the spread number compresses.
  const median = priced.length > 0 ? [...priced].map(q => q.last as number).sort((a, b) => a - b)[Math.floor(priced.length / 2)] : null;
  const agree = median === null ? 0 : priced.filter(q => Math.abs((q.last as number) - median) / median < 0.001).length;
  const diverge = priced.length - agree;
  return (
    <>
      {detailStatsMeter(agree, diverge)}
      <div style={{ display: 'flex', gap: space[20], marginBottom: space[12], flexWrap: 'wrap' }}>
      <Stat label={`Price (median of ${priced.length})`} value={fmtPrice(data.price, settle)} tone={color.blue} />
      <Stat label="Cross-venue spread" value={fmtSpread(spread)} />
      <Stat label="24h change" value={fmtPct(chg)} tone={chgColor(chg)} />
      <Stat label="24h volume" value={fmtVol(medianOf(priced.map(q => q.quoteVolume)))} />
      {type === 'swap' && <Stat label="Funding" value={fmtFunding(priced.find(q => q.fundingRate !== null)?.fundingRate ?? null)} />}
      {(type === 'swap' || type === 'future' || type === 'option') && (
        <Stat label="Open interest" value={fmtOi(priced.find(q => q.openInterest !== null)?.openInterest ?? null)} />
      )}
      </div>
    </>
  );
}
/** One Meter tallying venues that agree with the median vs. ones that diverge. */
function detailStatsMeter(agree: number, diverge: number): React.ReactNode {
  if (agree + diverge === 0) return null;
  return (
    <Meter
      parts={[
        { label: 'venues agreeing (≤0.1%)', value: agree, color: color.blue },
        { label: 'diverging (>0.1%)', value: diverge, color: color.orange },
      ]}
      style={{ marginBottom: space[12] }}
    />
  );
}

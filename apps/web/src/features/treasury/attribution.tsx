'use client';

import { useCallback, useEffect, useState } from 'react';
import { themeColor, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { Loading } from '@/ui/feedback';
import { Banner } from '@/ui/banner';
import { loadAttribution, type Attribution, type TreasuryDimension, type TreasuryRange } from './client';
import { DASH, pct, price, qty, shortTs, toneOf, usd } from './format';
import { Board, Segmented, SplitBar, Stat, Td, Th } from './parts';

/**
 * attribution.tsx — WHY the window's net worth moved, as a panel.
 *
 * The time machine already answers "did it move, and by how much". This panel
 * answers the question underneath: of that move, how much was the MARKET
 * repricing what we already held, and how much was the BOOK itself changing
 * (buys, sells, transfers in and out). `@/lib/attribution` owns the arithmetic;
 * this file only renders it.
 *
 * THE IDENTITY IS SHOWN, NOT ASSUMED. Δ = market + book holds by construction,
 * and the panel prints the residual so a reader can confirm it rather than take
 * it on faith — a split that does not add up to the move it explains would be
 * worse than no split at all.
 *
 * A price effect of 0 is NOT "the price did not move": a pair that opened in the
 * window had nothing to reprice, and one that closed has no end price to split
 * against. Both are flagged in the Movers table, and both are counted on the key
 * row, so the 0 is always read with its reason attached.
 *
 * The panel fetches independently of the time machine's four modes, so a failure
 * here cannot blank the chart beside it — the family's containment rule.
 */

const DIMENSIONS: readonly { key: TreasuryDimension; label: string }[] = [
  { key: 'asset', label: 'Asset' },
  { key: 'chain', label: 'Chain' },
  { key: 'wallet', label: 'Wallet' },
];

/** How many decomposed pairs the Movers table lists. The rest are counted. */
const MOVERS = 12;

export default function AttributionPanel({ range }: { range: TreasuryRange }) {
  const [dimension, setDimension] = useState<TreasuryDimension>('asset');
  const [data, setData] = useState<Attribution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await loadAttribution(dimension, range));
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [dimension, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const movers = data ? data.pairs.slice(0, MOVERS) : [];

  return (
    <Board
      title={`Why it moved — ${dimension} · ${range}`}
      right={<Segmented<TreasuryDimension> label="By" value={dimension} options={DIMENSIONS} onChange={setDimension} />}
    >
      {error && <Banner>Attribution unavailable: {error}</Banner>}

      {!data && loading && <Loading label="Splitting the move into market and book…" />}

      {data?.singleObservation && (
        <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>
          One observation in this window ({data.observations}) — a single point in time has no change to split. Widen the
          window and the split appears.
        </div>
      )}

      {data && !data.singleObservation && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[12] }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(170px, 100%), 1fr))', gap: space[8] }}>
            <Stat
              label={`Move (${range})`}
              value={usd(data.totalDeltaUsd)}
              sub={data.fromTs && data.toTs ? `${shortTs(data.fromTs)} → ${shortTs(data.toTs)}` : undefined}
              color={toneOf(data.totalDeltaUsd)}
            />
            <Stat
              label="Market — price moved"
              value={usd(data.totalPriceEffectUsd)}
              sub={data.marketSharePct === null ? 'the window did not move' : `${pct(data.marketSharePct, 1)} of the move`}
              color={themeColor.blue}
            />
            <Stat
              label="Book — quantity moved"
              value={usd(data.totalFlowEffectUsd)}
              sub={data.marketSharePct === null ? undefined : `${pct(100 - data.marketSharePct, 1)} of the move`}
              color={themeColor.orange}
            />
            <Stat
              label="Check: move − (market + book)"
              value={usd(data.residualUsd)}
              sub={`${data.observations.toLocaleString('en-US')} observations · ${data.pairs.length} pairs`}
            />
          </div>

          <div style={{ display: 'flex', gap: space[12], flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ color: themeColor.blue, fontSize: fontSize[11] }}>● Market (reprice of what we held)</span>
            <span style={{ color: themeColor.orange, fontSize: fontSize[11] }}>● Book (the holdings themselves changing)</span>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <Th>{dimension}</Th>
                  <Th right>Start</Th>
                  <Th right>End</Th>
                  <Th right>Move</Th>
                  <Th right>Market</Th>
                  <Th right>Book</Th>
                  <Th right>Split</Th>
                  <Th right>Pairs</Th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.key}>
                    <Td>{r.key}</Td>
                    <Td right color={themeColor.labelSecondary}>
                      {usd(r.startValueUsd)}
                    </Td>
                    <Td right>{usd(r.endValueUsd)}</Td>
                    <Td right color={toneOf(r.deltaUsd)}>
                      {usd(r.deltaUsd)}
                    </Td>
                    <Td right color={themeColor.blue}>
                      {usd(r.priceEffectUsd)}
                    </Td>
                    <Td right color={themeColor.orange}>
                      {usd(r.flowEffectUsd)}
                    </Td>
                    <Td right>
                      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <SplitBar left={r.priceEffectUsd} right={r.flowEffectUsd} />
                      </div>
                    </Td>
                    <Td right color={themeColor.labelTertiary}>
                      {r.assets}
                      {r.openedAssets > 0 ? ` · ${r.openedAssets} new` : ''}
                      {r.closedAssets > 0 ? ` · ${r.closedAssets} closed` : ''}
                    </Td>
                  </tr>
                ))}
                {data.rows.length === 0 && (
                  <tr>
                    <Td>No holding was recorded either side of this window.</Td>
                    <Td right>{DASH}</Td>
                    <Td right>{DASH}</Td>
                    <Td right>{DASH}</Td>
                    <Td right>{DASH}</Td>
                    <Td right>{DASH}</Td>
                    <Td right>{DASH}</Td>
                    <Td right>{DASH}</Td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>
            Every price is a real unit price: the split is computed per asset, then summed per key. A pair that opened in
            the window had nothing to reprice and one that closed has no end price, so each carries its whole value as a
            book effect — flagged below, never shown as a price that held still.
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <Th>Mover</Th>
                  <Th right>Qty</Th>
                  <Th right>Price</Th>
                  <Th right>Move</Th>
                  <Th right>Market</Th>
                  <Th right>Book</Th>
                  <Th>Note</Th>
                </tr>
              </thead>
              <tbody>
                {movers.map((p) => {
                  const note = p.opened
                    ? 'opened in window — nothing to reprice'
                    : p.closed
                      ? 'closed in window — no end price'
                      : '';
                  return (
                    <tr key={`${p.key}-${p.asset}`}>
                      <Td>
                        <span style={{ color: themeColor.labelSecondary }}>{p.key}</span> {p.asset}
                      </Td>
                      <Td right color={themeColor.labelSecondary}>
                        {qty(p.startQty)} → {qty(p.endQty)}
                      </Td>
                      <Td right color={themeColor.labelSecondary}>
                        {price(p.startPrice)} → {price(p.endPrice)}
                      </Td>
                      <Td right color={toneOf(p.deltaUsd)}>
                        {usd(p.deltaUsd)}
                      </Td>
                      <Td right color={themeColor.blue}>
                        {usd(p.priceEffectUsd)}
                      </Td>
                      <Td right color={themeColor.orange}>
                        {usd(p.flowEffectUsd)}
                      </Td>
                      <Td color={themeColor.labelTertiary}>{note || DASH}</Td>
                    </tr>
                  );
                })}
                {movers.length === 0 && (
                  <tr>
                    <Td>No pair moved in this window.</Td>
                    <Td right>{DASH}</Td>
                    <Td right>{DASH}</Td>
                    <Td right>{DASH}</Td>
                    <Td right>{DASH}</Td>
                    <Td right>{DASH}</Td>
                    <Td>{DASH}</Td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {data.pairs.length > movers.length && (
            <div style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>
              Showing the {movers.length} largest of {data.pairs.length} moved pairs.
            </div>
          )}
        </div>
      )}
    </Board>
  );
}

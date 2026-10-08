'use client';

/**
 * instrument.tsx — one instrument within a market type (plan Phase 1 + 4).
 *
 * `/trade/<marketType>/<instrument>` — the canonical instrument page. It reads
 * the ticker family's per-instrument endpoint (`/api/ticker/instrument`) for the
 * cross-venue quotes and reuses the composer for the trade intent. It builds no
 * native symbol and invents no aggregate (the `client.ts` rules).
 *
 * HONESTY. A market type the ticker cannot quote (margin) is a STATED gap: the
 * page renders that and the composer, never an empty quotes table pretending the
 * instrument has no price. A base no venue quotes is likewise stated, not shown
 * as a zero — the endpoint answers `price: null` and the page says so.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { alpha, themeColor, fontSize, fontWeight, letterSpacing, lineHeight, radius, space } from '@/styles/tokens';
import {
  errorMessage,
  fetchInstrumentDetail,
  formatPrice,
  formatUsd,
  NO_VALUE,
  TRADE_NAV,
  type InstrumentDetail,
} from '@/features/trade/client';
import { instrumentById, instrumentLabel } from '@/features/trade/model';
import { MARKET_TYPE_BY_ID, type MarketType } from '@/features/trade/model';
import { Card } from '@/ui/card';
import { ChangeChip } from '@/ui/change-chip';
import { DataTable } from '@/ui/data-table';
import { ErrorState } from '@/ui/feedback';
import { Loading } from '@/ui/feedback';
import { Notice } from '@/ui/notice';
import { PageHeader } from '@/ui/page-header';
import { Value } from '@/ui/value';
import { TradeComposer } from '@/features/trade/ui/composer';

type Panel<T> = { value: T; error: string | null; loading: boolean };

export function TradeInstrument({ marketType, instrumentId }: { marketType: MarketType; instrumentId: string }) {
  const entry = MARKET_TYPE_BY_ID[marketType];
  const instrument = instrumentById(instrumentId);
  const tickerType = entry.tickerType;

  const [detail, setDetail] = useState<Panel<InstrumentDetail | null>>({ value: null, error: null, loading: true });

  useEffect(() => {
    // A market type with no quotable instrument (margin) never calls the endpoint
    // — there is nothing to quote. The page states that instead of showing an
    // empty table for a question the market does not answer.
    if (tickerType === null || instrument === undefined) {
      setDetail({ value: null, error: null, loading: false });
      return;
    }
    const ac = new AbortController();
    setDetail({ value: null, error: null, loading: true });
    fetchInstrumentDetail(instrument.base, tickerType, ac.signal)
      .then((v) => !ac.signal.aborted && setDetail({ value: v, error: null, loading: false }))
      .catch((e) => !ac.signal.aborted && setDetail({ value: null, error: errorMessage(e), loading: false }));
    return () => ac.abort();
  }, [instrument, tickerType]);

  const label = instrumentLabel(instrumentId);
  const base = instrument?.base ?? instrumentId.toUpperCase();

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
      <PageHeader
        title={`${label} — ${entry.label}`}
        description={entry.note}
        nav={TRADE_NAV}
      />

      {/* The trail the plan's routes follow: type → instrument. */}
      <nav aria-label="Instrument trail" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[8], marginBottom: space[12] }}>
        <TrailLink href="/trade" label="Trade" />
        <span aria-hidden="true" style={{ color: alpha(themeColor.labelTertiary, 0.7) }}>/</span>
        <TrailLink href={`/trade/${marketType}`} label={entry.label} />
        <span aria-hidden="true" style={{ color: alpha(themeColor.labelTertiary, 0.7) }}>/</span>
        <span style={{ color: themeColor.labelPrimary, fontSize: fontSize[11] }}>{label}</span>
      </nav>

      {tickerType === null ? (
        <Card title="Cross-venue quotes" subtitle="this market type has no quotable instrument of its own">
          <Notice>
            {entry.label} is an account-level market: it has no quotable instrument of its own, so there is no quote
            board for {label}. It trades the spot pairs on the spot board against borrowed collateral — the composer
            below still works the intent through the executor.
          </Notice>
        </Card>
      ) : (
        <Card
          title="Cross-venue quotes"
          subtitle="each venue's own quote for this instrument, read live — never a built symbol"
          right={
            <Link href={`/market/crypto/${base}`} style={{ fontSize: fontSize[11], color: themeColor.blue, textDecoration: 'none' }}>
              full coin page →
            </Link>
          }
        >
          {detail.error ? (
            <ErrorState title="Quotes unavailable" detail={detail.error} />
          ) : detail.loading ? (
            <Loading what="quotes" />
          ) : detail.value === null || detail.value.quotes.length === 0 ? (
            <Notice>No venue returned a quote for {label} right now. An empty result is reported as empty, never padded with another instrument&apos;s price.</Notice>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(120px, 100%), 1fr))', gap: space[12], marginBottom: space[12] }}>
                <Value label="Median price" value={formatPrice(detail.value.price)} tone={detail.value.price === null ? 'muted' : 'default'} hint="Median of the venues that priced it; — when none did." />
                <Value label="Venues priced" value={`${detail.value.priced} / ${detail.value.quotes.length}`} />
                <Value label="Not listed" value={String(detail.value.notListed.length)} tone={detail.value.notListed.length > 0 ? 'muted' : 'default'} hint="Venues that list no such instrument — a fact about the market, not a failure." />
                <Value label="Failed" value={String(detail.value.failed.length)} tone={detail.value.failed.length > 0 ? 'negative' : 'default'} hint="Venues that should have answered and did not." />
              </div>
              <DataTable
                head={['Venue', 'Symbol', 'Last', 'Bid', 'Ask', '24h', 'Quote volume']}
                rows={detail.value.quotes.map((q) => ({
                  cells: [
                    q.exchange,
                    q.symbol,
                    formatPrice(q.last),
                    formatPrice(q.bid),
                    formatPrice(q.ask),
                    <ChangeChip key={`c-${q.exchange}`} percent={q.change24h} />,
                    formatUsd(q.quoteVolume),
                  ],
                }))}
              />
              {(detail.value.notListed.length > 0 || detail.value.failed.length > 0) && (
                <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
                  {detail.value.notListed.length > 0 && <>not listed: {detail.value.notListed.join(', ')}. </>}
                  {detail.value.failed.length > 0 && <>failed: {detail.value.failed.join(', ')}.</>}
                </p>
              )}
            </>
          )}
        </Card>
      )}

      <div style={{ marginTop: space[12] }}>
        <TradeComposer marketType={marketType} defaultBase={instrument?.base} defaultQuote={instrument?.quote} />
      </div>

      <div style={{ marginTop: space[12] }}>
        <Card title="Instrument" subtitle="the canonical identity — the venue's own symbol is a field, never the id">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))', gap: space[12] }}>
            <Value label="Canonical id" value={instrumentId} hint="What a route resolves and an order references." />
            <Value label="Base" value={base} />
            <Value label="Quote" value={instrument?.quote ?? NO_VALUE} />
            <Value label="Market type" value={entry.label} />
            <Value label="Ticker type" value={tickerType ?? '—'} tone={tickerType === null ? 'muted' : 'default'} hint="The vocabulary the public ticker board speaks, or — when it has none." />
          </div>
          <p style={{ margin: `${space[8]}px 0 0`, fontSize: fontSize[11], color: themeColor.labelTertiary, lineHeight: lineHeight.normal }}>
            A venue spells this instrument its own way ({detail.value?.quotes[0]?.symbol ?? 'e.g. BTCUSDT'}); the adapter resolves
            that form. No view builds a native symbol, and no route carries one.
          </p>
        </Card>
      </div>
    </main>
  );
}

function TrailLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      style={{
        padding: `${space[4]}px ${space[8]}px`,
        border: `1px solid ${themeColor.separator}`,
        borderRadius: radius[8],
        color: themeColor.labelTertiary,
        fontSize: fontSize[11],
        textDecoration: 'none',
      }}
    >
      {label}
    </Link>
  );
}

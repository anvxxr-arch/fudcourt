'use client';
import { Banner } from '@/ui/banner';
import QuoteBoard from '@/features/market/quote-board';
/**
 * Stock family (keyless, public) -- the contract behind the /market/stock
 * section.
 *
 * One Yahoo Finance chart call per symbol (the batch quote endpoint answers 401
 * without a crumb -- see features/market/quotes.ts). Each regional board is a
 * fixed, explicit allowlist -- indices first, then blue chips -- never a crawl,
 * so a board is a bounded, known set rather than "whatever the provider felt
 * like". `region` is OUR parameter: anything outside STOCK_REGIONS is a strict
 * 400, never clamped or silently defaulted.
 */
import { QUOTE_TTL_MS } from '@/features/market/clients';

/** Regional boards. `region` is OUR parameter (strict 400 on anything else). */
export const STOCK_REGIONS = ['us', 'asia', 'europe'] as const;
export type StockRegion = (typeof STOCK_REGIONS)[number];

/** What a bare /api/market/stock serves. */
export const DEFAULT_STOCK_REGION: StockRegion = 'us';

/**
 * Indices first, then blue chips, per region. Asia covers Indonesia (IDX, `.JK`
 * -- including the composite, IHSG) plus the major Asian indices and a blue chip
 * from each of Tokyo, Hong Kong, Korea, Taiwan and Shanghai. Europe covers the
 * FTSE/DAX/CAC/STOXX/IBEX/AEX/SMI/BEL/OMX indices plus blue chips from London,
 * Paris, Frankfurt, Amsterdam, Madrid, Milan, Lisbon, Zurich and the Nordics.
 */
export const STOCK_SYMBOLS: Readonly<Record<StockRegion, readonly string[]>> = {
  us: [
    '^GSPC', '^IXIC', '^DJI', '^RUT',
    'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO',
    'JPM', 'V', 'BRK-B', 'XOM',
  ],
  asia: [
    '^JKSE', '^N225', '^HSI', '^KS11', '^TWII', '^STI', '^AXJO',
    'BBCA.JK', 'BBRI.JK', 'BMRI.JK', 'TLKM.JK', 'ASII.JK', 'ICBP.JK',
    '7203.T', '0700.HK', '005930.KS', '2330.TW', '600519.SS',
  ],
  europe: [
    '^FTSE', '^GDAXI', '^FCHI', '^STOXX50E', '^IBEX', '^AEX', '^SSMI', '^BFX', '^OMX',
    'SHEL.L', 'AZN.L', 'HSBA.L', 'ULVR.L',
    'MC.PA', 'OR.PA', 'TTE.PA',
    'SAP.DE', 'SIE.DE', 'ALV.DE',
    'ASML.AS', 'ADYEN.AS',
    'SAN.MC', 'ITX.MC', 'ENI.MI', 'GALP.LS',
    'NESN.SW', 'NOVN.SW', 'UBSG.SW',
    'NOVO-B.CO', 'ERIC-B.ST', 'NOKIA.HE',
  ],
};

/** Preferred over Yahoo's long name; the board's exchange column still shows the venue. */
export const STOCK_LABELS: Readonly<Record<string, string>> = {
  '^GSPC': 'S&P 500',
  '^IXIC': 'Nasdaq Composite',
  '^DJI': 'Dow Jones Industrial Average',
  '^RUT': 'Russell 2000',
  AAPL: 'Apple',
  MSFT: 'Microsoft',
  NVDA: 'NVIDIA',
  GOOGL: 'Alphabet',
  AMZN: 'Amazon',
  META: 'Meta Platforms',
  TSLA: 'Tesla',
  AVGO: 'Broadcom',
  JPM: 'JPMorgan Chase',
  V: 'Visa',
  'BRK-B': 'Berkshire Hathaway',
  XOM: 'Exxon Mobil',
  '^JKSE': 'IDX Composite (IHSG)',
  '^N225': 'Nikkei 225',
  '^HSI': 'Hang Seng',
  '^KS11': 'KOSPI',
  '^TWII': 'Taiwan Weighted',
  '^STI': 'Straits Times',
  '^AXJO': 'S&P/ASX 200',
  'BBCA.JK': 'Bank Central Asia',
  'BBRI.JK': 'Bank Rakyat Indonesia',
  'BMRI.JK': 'Bank Mandiri',
  'TLKM.JK': 'Telkom Indonesia',
  'ASII.JK': 'Astra International',
  'ICBP.JK': 'Indofood CBP',
  '7203.T': 'Toyota Motor',
  '0700.HK': 'Tencent Holdings',
  '005930.KS': 'Samsung Electronics',
  '2330.TW': 'TSMC',
  '600519.SS': 'Kweichow Moutai',
  '^FTSE': 'FTSE 100',
  '^GDAXI': 'DAX',
  '^FCHI': 'CAC 40',
  '^STOXX50E': 'EURO STOXX 50',
  '^IBEX': 'IBEX 35',
  '^AEX': 'AEX',
  '^SSMI': 'SMI',
  '^BFX': 'BEL 20',
  '^OMX': 'OMX Stockholm 30',
  'SHEL.L': 'Shell',
  'AZN.L': 'AstraZeneca',
  'HSBA.L': 'HSBC Holdings',
  'ULVR.L': 'Unilever',
  'MC.PA': 'LVMH',
  'OR.PA': "L'Oréal",
  'TTE.PA': 'TotalEnergies',
  'SAP.DE': 'SAP',
  'SIE.DE': 'Siemens',
  'ALV.DE': 'Allianz',
  'ASML.AS': 'ASML Holding',
  'ADYEN.AS': 'Adyen',
  'SAN.MC': 'Banco Santander',
  'ITX.MC': 'Inditex',
  'ENI.MI': 'Eni',
  'GALP.LS': 'Galp Energia',
  'NESN.SW': 'Nestlé',
  'NOVN.SW': 'Novartis',
  'UBSG.SW': 'UBS Group',
  'NOVO-B.CO': 'Novo Nordisk',
  'ERIC-B.ST': 'Ericsson',
  'NOKIA.HE': 'Nokia',
};

/** Narrowing predicate for the request's `region` param. */
export function isStockRegion(value: string | null): value is StockRegion {
  return value !== null && (STOCK_REGIONS as readonly string[]).includes(value);
}

export const STOCK_TTL_MS = QUOTE_TTL_MS;

const TITLE: Record<StockRegion, string> = {
  us: 'Stock — US indices & mega-caps',
  asia: 'Stock — Asia indices & blue chips',
  europe: 'Stock — Europe indices & blue chips',
};
/**
 * Stock section: one Yahoo board per region (US / Asia / Europe).
 *
 * `region` is prop-typed `StockRegion`, but the section tables that feed it are
 * `string`-valued, so an index miss at runtime is possible. The house `Banner` is the
 * loud fallback — an honest error chrome beats rendering `title` undefined. The previous
 * shape dereferenced the record and would have thrown mid-render instead.
 */
export default function StockBoard({ region }: { region: StockRegion }) {
  const title = TITLE[region];
  if (!title) {
    return <Banner variant="error">{`market hub: unknown stock region '${region}'`}</Banner>;
  }
  return (
    <QuoteBoard
      endpoint={`/api/market/stock?region=${region}`}
      title={title}
      unitHint="Yahoo Finance · one chart call per symbol"
    />
  );
}

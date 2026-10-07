/**
 * The global market pulse's domain model — the whole-market read as one board.
 *
 * WHAT THIS IS. CoinMarketCap's `global` mode is a single object that answers
 * "how big is the market, who dominates it, where is the volume and what does
 * gas cost"; its `listing` and `exchanges` modes rank the coins and the venues.
 * This module reads those three payloads into display-shaped rows and states,
 * once, every place a figure can be ABSENT.
 *
 * THE NEVER-FAKE RULE, AND THE TWO SHAPES THAT MAKE IT BITTER.
 *  1. TOTAL market cap is NOT on `data` — it lives at `data.quotes[0].totalMarketCap`.
 *     `quotes` is CoinMarketCap's currency dimension, which collapses to a
 *     single USD entry, so in practice it is an array of ONE. It is still an
 *     array, and an array can be empty: `data.quotes[0]` read unguarded throws
 *     on a payload the contract calls valid-but-empty. `primaryQuote()` is that
 *     guard; when it returns null the market-cap and volume figures are null
 *     (rendered `—`) and `quoteMissing` is set so the board can say the quote
 *     block was absent rather than print a 0 it never received.
 *  2. `data.totalCount` arrives as a STRING (`'8138'`), not a number — and so
 *     does the gas oracle's block number (`'26143371'`) and every confirmation
 *     time (`'45'`). Parsed once in `readNumeric()`, so no caller writes
 *     `Number(x)` inline and none can print `NaN`; a value that is neither a
 *     finite number nor a finite numeric string is ABSENT (null) and renders
 *     `—`. A string-encoded number is read for its own value — dropping it to
 *     `—` would under-report a figure the upstream DID state.
 *
 * Every other figure passes through `readNumber()`, which turns `undefined`, a
 * non-number and a non-finite number into null — so "missing" can never
 * silently become 0 anywhere on this board.
 *
 * PURE: no network, no clock (`nowSec` is a parameter), no I/O — so it
 * unit-tests offline against fixed global/listing/exchange payloads.
 */

/** One entry of CoinMarketCap's `quotes` currency dimension (USD only). */
export type CmcQuote = {
  name?: string;
  price?: number;
  totalMarketCap?: number;
  totalVolume24H?: number;
  totalMarketCapYesterday?: number;
  totalMarketCapYesterdayPercentageChange?: number;
  altcoinMarketCap?: number;
  altcoinVolume24H?: number;
  last_updated?: string;
};

/**
 * The Etherscan gas oracle CoinMarketCap relays: prices in gwei, times in seconds.
 * The block number and confirmation times come string-encoded from upstream
 * (`'26143371'`, `'45'`), so they are typed as the union and read tolerantly.
 */
export type GasOracle = {
  lastBlock?: number | string;
  slowPriceDecimal?: number | string;
  standardPriceDecimal?: number | string;
  fastPriceDecimal?: number | string;
  slowConfirmationTime?: number | string;
  standardConfirmationTime?: number | string;
  fastConfirmationTime?: number | string;
};

/** `mode=global` — `data` is this object. Only the fields the board reads are typed. */
export type CmcGlobalData = {
  btcDominance?: number;
  ethDominance?: number;
  btcDominance24hPercentageChange?: number;
  ethDominance24hPercentageChange?: number;
  btcDominanceYesterday?: number;
  ethDominanceYesterday?: number;
  activeCryptoCurrencies?: number;
  totalCryptoCurrencies?: number;
  activeMarketPairs?: number;
  activeExchanges?: number;
  totalExchanges?: number;
  defiVolume24h?: number;
  defiVolume24hReported?: number;
  defiMarketCap?: number;
  defi24hPercentageChange?: number;
  stablecoinVolume24h?: number;
  stablecoinVolume24hReported?: number;
  stablecoinMarketCap?: number;
  stablecoin24hPercentageChange?: number;
  derivativesVolume24h?: number;
  derivativesVolume24hReported?: number;
  derivatives24hPercentageChange?: number;
  quotes?: CmcQuote[];
  etherscanGas?: GasOracle;
  totalCryptoDexCurrencies?: number;
  past24hIncrementalCryptoNumber?: number;
  past7dIncrementalCryptoNumber?: number;
  past30dIncrementalCryptoNumber?: number;
  todayChangePercent?: number;
};

/** One row of `mode=listing`'s `cryptoCurrencyList`. */
export type CmcListingRow = {
  id?: number;
  name?: string;
  symbol?: string;
  slug?: string;
  tags?: string[];
  marketPairCount?: number;
  circulatingSupply?: number;
  selfReportedCirculatingSupply?: number;
  totalSupply?: number;
  isActive?: number;
  lastUpdated?: string;
  dateAdded?: string;
  /** Also an array of one — the USD quote; read with `primaryQuote()`. */
  quotes?: CmcListingQuote[];
  platform?: unknown;
  isAudited?: number;
};

/** The USD quote hanging off a listing row. */
export type CmcListingQuote = {
  name?: string;
  price?: number;
  volume24h?: number;
  marketCap?: number;
  percentChange1h?: number;
  percentChange24h?: number;
  percentChange7d?: number;
  percentChange30d?: number;
  percentChange60d?: number;
  percentChange90d?: number;
  fullyDilluttedMarketCap?: number;
  dominance?: number;
  turnover?: number;
  ytdPriceChangePercentage?: number;
  volumePercentChange?: number;
};

/** `mode=listing` — `data` wraps the rows and the upstream's own total (a STRING). */
export type CmcListingData = {
  cryptoCurrencyList?: CmcListingRow[];
  /** A STRING like `'8138'` — see `readNumeric()`. */
  totalCount?: string | number;
};

/** One row of `mode=exchanges`'s `exchanges` array. */
export type CmcExchangeRow = {
  id?: number;
  name?: string;
  slug?: string;
  status?: string;
  score?: number;
  trafficScore?: number;
  totalVol24h?: number;
  totalVolAdjusted24h?: number;
  totalVol7d?: number;
  totalVol30d?: number;
  spotVol24h?: number;
  totalVolChgPct24h?: number;
  totalVolChgPct7d?: number;
  totalVolChgPct30d?: number;
  numMarkets?: number;
  numCoins?: number;
  marketSharePct?: number;
  type?: string;
  dateLaunched?: string;
  lastUpdated?: string;
  makerFee?: number;
  takerFee?: number;
  porAuditStatus?: string;
};

/** `mode=exchanges` — `data` wraps the rows and a numeric count. */
export type CmcExchangesData = {
  exchanges?: CmcExchangeRow[];
  count?: number;
};

/** A figure the upstream may not have stated. `null` means ABSENT, never zero. */
export type Reading = number | null;

/**
 * A number read off a payload, or null when the payload stated none.
 * `undefined`, a non-number and a non-finite number are each ABSENT — the board
 * renders `—`. This is the one gate every figure in this module passes through.
 */
export function readNumber(value: unknown): Reading {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The first element of a currency array, or null when there is none.
 *
 * `quotes` is an array of ONE on every CoinMarketCap mode here (the USD quote),
 * but it is still an array and can be empty — this is the guard that keeps
 * `quotes[0].totalMarketCap` from throwing, and keeps an absent quote from
 * reading as a zero-dollar market.
 */
export function primaryQuote<T>(quotes: readonly T[] | null | undefined): T | null {
  if (!quotes || quotes.length === 0) return null;
  const first = quotes[0];
  return first ?? null;
}

/**
 * A number the upstream may have written as a JSON number OR as a numeric
 * STRING, or null when it is neither.
 *
 * CoinMarketCap string-encodes several metrics that are plainly numbers. Two
 * were confirmed live (2026-10-07): `data.totalCount` is `'8138'`, and the gas
 * oracle ships `lastBlock: '26143371'` with every `*ConfirmationTime` as a
 * string (`'45'`) while the `*PriceDecimal` gwei values are real JSON numbers.
 * A string-encoded number is NOT a missing value — rendering `—` for one would
 * under-report a figure the upstream DID state, the mirror-image of printing a
 * 0 it did not. So this reads the string's own value, and only a value that is
 * neither a finite number nor a finite numeric string is ABSENT (null).
 *
 * Centralised so a caller never writes `Number(x)` inline and never prints `NaN`.
 */
export function readNumeric(value: unknown): Reading {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** The whole-market figures the board's header stats read, each possibly absent. */
export type GlobalRead = {
  totalMarketCap: Reading;
  totalVolume24h: Reading;
  marketCap24hChangePct: Reading;
  btcDominance: Reading;
  btcDominanceChange24h: Reading;
  ethDominance: Reading;
  ethDominanceChange24h: Reading;
  activeExchanges: Reading;
  totalExchanges: Reading;
  activeCurrencies: Reading;
  totalCurrencies: Reading;
  activeMarketPairs: Reading;
  /** The USD quote's own stamp, verbatim, or null. */
  quoteUpdated: string | null;
  /** True when the payload carried no `quotes[0]` — the board says so, not 0. */
  quoteMissing: boolean;
};

/** Read the `mode=global` object into the header figures. Pure; null-safe. */
export function readGlobal(data: CmcGlobalData | null | undefined): GlobalRead {
  const quote = primaryQuote<CmcQuote>(data?.quotes);
  return {
    totalMarketCap: readNumber(quote?.totalMarketCap),
    totalVolume24h: readNumber(quote?.totalVolume24H),
    marketCap24hChangePct: readNumber(quote?.totalMarketCapYesterdayPercentageChange),
    btcDominance: readNumber(data?.btcDominance),
    btcDominanceChange24h: readNumber(data?.btcDominance24hPercentageChange),
    ethDominance: readNumber(data?.ethDominance),
    ethDominanceChange24h: readNumber(data?.ethDominance24hPercentageChange),
    activeExchanges: readNumber(data?.activeExchanges),
    totalExchanges: readNumber(data?.totalExchanges),
    activeCurrencies: readNumber(data?.activeCryptoCurrencies),
    totalCurrencies: readNumber(data?.totalCryptoCurrencies),
    activeMarketPairs: readNumber(data?.activeMarketPairs),
    quoteUpdated: typeof quote?.last_updated === 'string' ? quote.last_updated : null,
    quoteMissing: quote === null,
  };
}

/** A segment of the market — DeFi, stablecoins or derivatives. */
export type SegmentRead = {
  key: 'defi' | 'stablecoin' | 'derivatives';
  label: string;
  volume24h: Reading;
  changePct24h: Reading;
  /** DeFi and stablecoins carry a market cap; derivatives does not. */
  marketCap: Reading;
};

/**
 * The three segment volumes, read verbatim from `mode=global`. Each volume and
 * its 24h change is stated independently, so a missing change is `—` beside a
 * volume that is present, never a fabricated 0%.
 */
export function readSegments(data: CmcGlobalData | null | undefined): SegmentRead[] {
  return [
    {
      key: 'defi',
      label: 'DeFi',
      volume24h: readNumber(data?.defiVolume24h),
      changePct24h: readNumber(data?.defi24hPercentageChange),
      marketCap: readNumber(data?.defiMarketCap),
    },
    {
      key: 'stablecoin',
      label: 'Stablecoins',
      volume24h: readNumber(data?.stablecoinVolume24h),
      changePct24h: readNumber(data?.stablecoin24hPercentageChange),
      marketCap: readNumber(data?.stablecoinMarketCap),
    },
    {
      key: 'derivatives',
      label: 'Derivatives',
      volume24h: readNumber(data?.derivativesVolume24h),
      changePct24h: readNumber(data?.derivatives24hPercentageChange),
      marketCap: null,
    },
  ];
}

/** The Etherscan gas oracle, read into the three tiers plus the block. */
export type GasRead = {
  block: Reading;
  slowGwei: Reading;
  standardGwei: Reading;
  fastGwei: Reading;
  slowSeconds: Reading;
  standardSeconds: Reading;
  fastSeconds: Reading;
};

/** Read `etherscanGas` into the three tiers. Pure; a tier the upstream omitted is null. */
export function readGas(data: CmcGlobalData | null | undefined): GasRead {
  const gas = data?.etherscanGas;
  // The block number and the confirmation times arrive string-encoded live, so
  // they go through the tolerant reader; the gwei prices arrive as numbers but
  // are routed through it too, so a future encoding flip cannot blank a tier.
  return {
    block: readNumeric(gas?.lastBlock),
    slowGwei: readNumeric(gas?.slowPriceDecimal),
    standardGwei: readNumeric(gas?.standardPriceDecimal),
    fastGwei: readNumeric(gas?.fastPriceDecimal),
    slowSeconds: readNumeric(gas?.slowConfirmationTime),
    standardSeconds: readNumeric(gas?.standardConfirmationTime),
    fastSeconds: readNumeric(gas?.fastConfirmationTime),
  };
}

/** One coin, read for the ranking table. `rank` is its position in the window. */
export type ListingRead = {
  id: number | null;
  rank: number;
  name: string;
  symbol: string;
  price: Reading;
  percentChange24h: Reading;
  marketCap: Reading;
  volume24h: Reading;
  dominance: Reading;
};

/**
 * Read one listing row. Its `quotes` is an array of one (the USD quote), so
 * every quote-derived figure goes through `primaryQuote()` first: a row whose
 * quote block is empty still renders (with `—` for price/change/mcap/volume),
 * rather than throwing or reading as a zero-priced coin.
 */
export function readListingRow(row: CmcListingRow, rank: number): ListingRead {
  const quote = primaryQuote<CmcListingQuote>(row?.quotes);
  return {
    id: readNumber(row?.id),
    rank,
    name: typeof row?.name === 'string' ? row.name : '',
    symbol: typeof row?.symbol === 'string' ? row.symbol : '',
    price: readNumber(quote?.price),
    percentChange24h: readNumber(quote?.percentChange24h),
    marketCap: readNumber(quote?.marketCap),
    volume24h: readNumber(quote?.volume24h),
    dominance: readNumber(quote?.dominance),
  };
}

/** One venue, read for the ranking table. */
export type ExchangeRead = {
  id: number | null;
  name: string;
  totalVol24h: Reading;
  marketSharePct: Reading;
  numMarkets: Reading;
  score: Reading;
  makerFee: Reading;
  takerFee: Reading;
};

/** Read one exchange row. Pure; a field the upstream omitted is null. */
export function readExchangeRow(row: CmcExchangeRow): ExchangeRead {
  return {
    id: readNumber(row?.id),
    name: typeof row?.name === 'string' ? row.name : '',
    totalVol24h: readNumber(row?.totalVol24h),
    marketSharePct: readNumber(row?.marketSharePct),
    numMarkets: readNumber(row?.numMarkets),
    score: readNumber(row?.score),
    makerFee: readNumber(row?.makerFee),
    takerFee: readNumber(row?.takerFee),
  };
}

/** The board, assembled. Every list is a slice of the upstream page, stated. */
export type GlobalBoard = {
  global: GlobalRead;
  segments: SegmentRead[];
  gas: GasRead;
  listing: ListingRead[];
  exchanges: ExchangeRead[];
  slice: {
    listingShown: number;
    /** The upstream's own count — a STRING upstream parsed with `readNumeric()`. */
    listingTotal: Reading;
    exchangesShown: number;
    exchangesTotal: Reading;
    note: string;
  };
  derived: string;
  asOf: number;
};

/** How many rows of each ranking the board shows unless told otherwise. */
export const DEFAULT_SLICE = 25;

/**
 * Build the board from the three `mode=global|listing|exchanges` payloads. Pure.
 *
 * `nowSec` is passed in rather than read, so the board is deterministic and
 * unit-tests without a clock. `listingLimit`/`exchangeLimit` default to 25 and
 * are STATED on the board (`slice.note`), because "the 25 highest-ranked coins
 * we asked for" and "every coin" are different claims and only the first is
 * true. A row-list that is absent or empty yields an empty table the caller
 * renders as an explicit failure, not a silent one.
 */
export function buildGlobalBoard(input: {
  global?: CmcGlobalData | null;
  listing?: CmcListingData | null;
  exchanges?: CmcExchangesData | null;
  listingStart?: number;
  listingLimit?: number;
  exchangeLimit?: number;
  nowSec: number;
}): GlobalBoard {
  const listingLimit = input.listingLimit ?? DEFAULT_SLICE;
  const exchangeLimit = input.exchangeLimit ?? DEFAULT_SLICE;
  const listingStart = input.listingStart ?? 1;

  const rows = Array.isArray(input.listing?.cryptoCurrencyList)
    ? input.listing.cryptoCurrencyList.slice(0, listingLimit)
    : [];
  // The rank is the coin's position in the requested window: CoinMarketCap's
  // listing page carries no rank field, so it is derived from `start` + offset.
  const listing = rows.map((row, i) => readListingRow(row, listingStart + i));

  const exchRows = Array.isArray(input.exchanges?.exchanges)
    ? input.exchanges.exchanges.slice(0, exchangeLimit)
    : [];
  const exchanges = exchRows.map(readExchangeRow);

  const listingTotal = readNumeric(input.listing?.totalCount);
  const exchangesTotal = readNumber(input.exchanges?.count);

  const listingNote =
    listingTotal === null
      ? `${listing.length} coins read (the upstream reported no total count)`
      : `${listing.length} of ${listingTotal.toLocaleString('en-US')} coins`;
  const exchangeNote =
    exchangesTotal === null
      ? `${exchanges.length} venues read (the upstream reported no count)`
      : `${exchanges.length} of ${exchangesTotal.toLocaleString('en-US')} venues`;

  return {
    global: readGlobal(input.global),
    segments: readSegments(input.global),
    gas: readGas(input.global),
    listing,
    exchanges,
    slice: {
      listingShown: listing.length,
      listingTotal,
      exchangesShown: exchanges.length,
      exchangesTotal,
      note: `this board reads ${listingNote} and ${exchangeNote} from CoinMarketCap's ranked pages — the ranking is by the upstream's own order within the window requested, not across the whole market`,
    },
    derived:
      'total market cap and 24h volume are read from data.quotes[0] (a one-element array — an empty quote renders \u2014, never 0); ' +
      'dominance and its 24h change, the segment volumes (DeFi, stablecoins, derivatives) and the gas oracle are read verbatim from the global object; ' +
      'listing rows read their price, change, market cap, volume and dominance from each row\u2019s own one-element quote; ' +
      'the coin count is parsed from the upstream STRING totalCount; the venue ranking is read verbatim by reported volume and market share',
    asOf: input.nowSec,
  };
}

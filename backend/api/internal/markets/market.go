// Package markets is the market-data value model shared by every venue
// (tickers, candles, order books and the derivative price/rate feeds).
//
// Two rules hold everywhere in this package: every price, quantity and rate is
// a decimal STRING (never float64 — 1e12-scale values must survive exact), and
// absence is honest — an unreported level is an empty string, never a
// fabricated zero or a borrowed last price.
package markets

import (
	"time"
)

// Stable refusal codes for this domain. Clients branch on these, so they are
// frozen once shipped.
const (
	// CodeTickerInvalid marks a ticker with absent identity or an unparseable
	// or negative price.
	CodeTickerInvalid = "MARKET_TICKER_INVALID"
	// CodeBookCrossed marks an order book whose best bid is above its best ask.
	CodeBookCrossed = "MARKET_BOOK_CROSSED"
	// CodeBookInvalid marks a structurally invalid order book (bad level).
	CodeBookInvalid = "MARKET_BOOK_INVALID"
	// CodeCandleInvalid marks a candle with missing or inconsistent values.
	CodeCandleInvalid = "MARKET_CANDLE_INVALID"
	// CodePriceInvalid marks a mark/index price that is absent or negative.
	CodePriceInvalid = "MARKET_PRICE_INVALID"
	// CodeFundingInvalid marks a funding rate that is absent or unparseable.
	CodeFundingInvalid = "MARKET_FUNDING_INVALID"
	// CodeOpenInterestInvalid marks an open-interest value that is absent or
	// negative.
	CodeOpenInterestInvalid = "MARKET_OPEN_INTEREST_INVALID"
)

// Ticker is one venue's top-of-book quote for a symbol. INVARIANT: prices are
// decimal strings where the empty string means "not reported" — never a zero
// and never a borrowed trade price (see SnapshotFromTicker).
type Ticker struct {
	Exchange string `json:"exchange"`
	// Symbol is the canonical `BASE/QUOTE` form (instruments.CanonicalSymbol).
	Symbol string    `json:"symbol"`
	Bid    string    `json:"bid"`
	Ask    string    `json:"ask"`
	Last   string    `json:"last"`
	Ts     time.Time `json:"ts"`
}

// Candle is one OHLCV bar. INVARIANT: every value is a decimal string; an
// unreported volume is empty, not zero.
type Candle struct {
	Exchange string `json:"exchange"`
	Symbol   string `json:"symbol"`
	// Interval is the venue bar size (e.g. "1m"), identity of the bar series.
	Interval  string    `json:"interval"`
	OpenTime  time.Time `json:"open_time"`
	Open      string    `json:"open"`
	High      string    `json:"high"`
	Low       string    `json:"low"`
	Close     string    `json:"close"`
	Volume    string    `json:"volume"`
}

// Level is one price level of an order book: price and quantity as decimal
// strings.
type Level struct {
	Price    string `json:"price"`
	Quantity string `json:"quantity"`
}

// Book is a venue order book. INVARIANT: Bids[0] and Asks[0] are the BEST
// (closest to mid) levels — best bid ≤ best ask must hold (Validate refuses a
// crossed book).
type Book struct {
	Exchange string  `json:"exchange"`
	Symbol   string  `json:"symbol"`
	Bids     []Level `json:"bids"`
	Asks     []Level `json:"asks"`
	Ts       time.Time `json:"ts"`
}

// MarkPrice is the derivative mark price used for P&L and liquidation. Price
// is a decimal string and must be positive: a zero mark price is not a real
// market state.
type MarkPrice struct {
	Exchange string    `json:"exchange"`
	Symbol   string    `json:"symbol"`
	Price    string    `json:"price"`
	Ts       time.Time `json:"ts"`
}

// IndexPrice is the underlying index price a derivative tracks. Price is a
// decimal string and must be positive.
type IndexPrice struct {
	Exchange string    `json:"exchange"`
	Symbol   string    `json:"symbol"`
	Price    string    `json:"price"`
	Ts       time.Time `json:"ts"`
}

// FundingRate is the periodic funding rate of a perpetual. Rate is a decimal
// string and MAY be negative — that is the real direction of payment, not an
// error. NextFundingAt is nil when the venue does not report it.
type FundingRate struct {
	Exchange      string     `json:"exchange"`
	Symbol        string     `json:"symbol"`
	Rate          string     `json:"rate"`
	NextFundingAt *time.Time `json:"next_funding_at"`
	Ts            time.Time  `json:"ts"`
}

// OpenInterest is the open contracts/units of a derivative market. Value is a
// decimal string and may legitimately be zero (a dead market), never negative.
type OpenInterest struct {
	Exchange string    `json:"exchange"`
	Symbol   string    `json:"symbol"`
	Value    string    `json:"value"`
	Ts       time.Time `json:"ts"`
}

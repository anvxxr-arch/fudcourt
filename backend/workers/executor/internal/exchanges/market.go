package exchanges

import (
	"errors"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/platform/decimal"
)

// Market-model types for the venue boundary (objective §8.16). The planner
// needs three things the trading interface proper does not carry: the
// instrument grid (step/tick/min bounds), the fee schedule, and a priced market
// snapshot. They are declared HERE, in the venue package that produces them,
// for two reasons:
//
//  1. the plan/risk vocabulary (risk.InstrumentMetadata, risk.FeeModel) lives
//     in a core package that this boundary must NOT import (core packages must
//     not be depended on by the venue layer), and
//  2. a venue adapter must be able to return them without the caller reaching
//     into its wire types.
//
// The executor API (internal/api) translates these into the planner's core
// types (planner.InstrumentMetadata == risk.InstrumentMetadata,
// planner.MarketSnapshot). Keeping the two spellings apart is deliberate: the
// adapter boundary and the planner boundary are different contracts.

// Instrument is one venue-tradable instrument normalized to the canonical grid
// (TS exchange.ts Market / InstrumentMetadata). Money/quantity fields are
// decimal strings; nullable bounds are *string so an unknown bound is honestly
// absent, never a fabricated 0 (house rule).
type Instrument struct {
	Symbol                string
	MarketType            execution.MarketType
	Exchange              execution.ExchangeID
	BaseAsset             string
	QuoteAsset            string
	SettlementAsset       string
	TickSize              string
	StepSize              string
	MinQuantity           *string
	MaxQuantity           *string
	MinNotional           *string
	MaxNotional           *string
	ContractMultiplier    string
	MaxLeverage           *string
	MaintenanceMarginRate *string
	LeverageBrackets      []LeverageBracket
}

// Market couples an Instrument with the venue's symbol for it (TS exchange.ts
// Market: { symbol, marketType, metadata }). Symbol is the CANONICAL form
// ("BTC/USDT"); adapters that only speak the venue form keep the mapping
// internal.
type Market struct {
	Symbol     string
	MarketType execution.MarketType
	Metadata   Instrument
}

// LeverageBracket is one leverage tier, ascending by notional (PRD §18).
type LeverageBracket struct {
	MaxNotional           *string
	MaxLeverage           string
	MaintenanceMarginRate string
}

// FeeModel is a venue fee schedule in bps of notional (TS FeeModel).
type FeeModel struct {
	MakerBps string
	TakerBps string
}

// MarketSnapshot is a priced market view computed from a ticker
// (TS MarketSnapshot, produced by tickerToSnapshot). Every price is a decimal
// string.
type MarketSnapshot struct {
	Symbol    string
	Bid       string
	Ask       string
	Mid       string
	SpreadBps string
	Last      string
	Timestamp int64
}

// Named refusals for the market-data surface. They are separate sentinels so a
// caller can tell "this venue cannot answer at all" (configuration shape) from
// a transport failure, instead of sniffing error text.
var (
	// ErrMarketsUnavailable is returned by an adapter that cannot enumerate
	// instruments (the paper simulator). The caller must supply metadata
	// another way — it never fabricates a grid.
	ErrMarketsUnavailable = errors.New("exchange: markets are not enumerable for this venue")
	// ErrFeesUnavailable is returned by an adapter that does not publish
	// per-symbol fees (Bybit reads them from the venue account response). The
	// caller reports "market data unavailable" rather than inventing a
	// schedule.
	ErrFeesUnavailable = errors.New("exchange: fee schedule is not available for this venue")
	// ErrTickerUnpriced is retained as a named refusal for callers that need to
	// distinguish a wholly unpriced ticker; TickerSnapshot itself mirrors the
	// TS tickerToSnapshot and does NOT return it (see the function doc).
	ErrTickerUnpriced = errors.New("exchange: ticker carries no usable price")
)

// TickerSnapshot builds the priced snapshot from a ticker, exactly as
// tickerToSnapshot does in worker.ts:
//
//	bid = ticker.bid ?? ticker.last ?? 0
//	ask = ticker.ask ?? ticker.last ?? 0
//	mid = bid>0 && ask>0 ? (bid+ask)/2 : (ticker.last ?? 0)
//	last = ticker.last ?? mid
//	spreadBps = mid>0 && ask>bid ? (ask-bid)/mid*10000 : 0
//
// DIVERGENCE (documented): the TS returns numeric zeros when the ticker
// carries no price at all; this port preserves that envelope because the
// frozen contract's MarketSnapshot has non-nullable numeric fields, and the
// planner — not this helper — is where an unpriced market entry is refused.
// The math is exact decimal arithmetic (never float64, objective §36).
func TickerSnapshot(t execution.Ticker, at int64) (MarketSnapshot, error) {
	pick := func(vals ...*string) string {
		for _, v := range vals {
			if v != nil {
				return *v
			}
		}
		return ""
	}
	lastRaw := pick(t.Last)
	bid := pick(t.Bid, t.Last)
	ask := pick(t.Ask, t.Last)
	mid := lastRaw
	if isPositiveDec(bid) && isPositiveDec(ask) {
		sum, err := decimal.Add(bid, ask)
		if err != nil {
			return MarketSnapshot{}, err
		}
		half, err := decimal.Quo(sum, "2")
		if err != nil {
			return MarketSnapshot{}, err
		}
		mid = half
	}
	if lastRaw == "" {
		lastRaw = mid
	}
	spread := "0"
	if isPositiveDec(mid) {
		if c, err := decimal.Cmp(ask, bid); err == nil && c > 0 {
			diff, err := decimal.Sub(ask, bid)
			if err == nil {
				ratio, err := decimal.Quo(diff, mid)
				if err == nil {
					if bps, err := decimal.Mul(ratio, "10000"); err == nil {
						spread = bps
					}
				}
			}
		}
	}
	if bid == "" {
		bid = "0"
	}
	if ask == "" {
		ask = "0"
	}
	if mid == "" {
		mid = "0"
	}
	if lastRaw == "" {
		lastRaw = mid
	}
	return MarketSnapshot{
		Symbol:    t.Symbol,
		Bid:       bid,
		Ask:       ask,
		Mid:       mid,
		SpreadBps: spread,
		Last:      lastRaw,
		Timestamp: at,
	}, nil
}

// isPositiveDec reports whether s parses as a decimal strictly greater than 0.
func isPositiveDec(s string) bool {
	if s == "" {
		return false
	}
	r, err := decimal.Parse(s)
	if err != nil {
		return false
	}
	return r.Sign() > 0
}

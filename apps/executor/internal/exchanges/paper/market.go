package paper

import (
	"context"
	"errors"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges"
)

// ErrMarketSource is returned when an injected live market source fails or
// refuses a symbol. It is surfaced — never turned into a fabricated quote — so
// a paper order rests rather than filling against a price nobody published.
var ErrMarketSource = errors.New("paper: market source unavailable")

// MarketSource is the optional LIVE market-data source an injected paper venue
// reads its prices from. It mirrors the TS PaperExchangeAdapter, which wraps a
// live adapter's market-data surface (`getMarkets`/`getTicker`) and does its
// OWN simulated matching and settlement on top of the live tape
// (the retired TS exchange module: `marketData` is the live
// adapter, `PaperExchangeAdapter` owns `placeOrder`/`match`).
//
// SEMANTICS:
//   - A nil Source selects the hermetic simulator every unit test runs against:
//     prices come from the internal `marks` map and no network is touched.
//   - A non-nil Source makes this a PRODUCTION paper venue: GetTicker/GetMarkets/
//     GetFees delegate to it and matching is driven by the live tape. Order
//     placement, cancellation and settlement stay paper-owned — the source's
//     placeOrder/cancelOrder are NEVER reached (only its read surface is used).
type MarketSource interface {
	// GetTicker returns the live quote for a canonical symbol. A last-only or
	// bid/ask-only ticker is acceptable; the matcher takes the first available
	// price (last, then bid, then ask) exactly as the TS matcher does.
	GetTicker(ctx context.Context, symbol string) (execution.Ticker, error)
	// GetMarkets returns the venue's tradable set, so the paper venue reports the
	// real instrument grid rather than a fabricated one.
	GetMarkets(ctx context.Context) ([]exchanges.Market, error)
	// GetFees returns the venue fee schedule for symbol (read-only delegation).
	GetFees(ctx context.Context, symbol string) (exchanges.FeeModel, error)
}

// sourceRef returns the injected live market source, or nil for the hermetic
// simulator. Read once per call so delegation does not hold the venue mutex
// across a network round trip.
func (p *Paper) sourceRef() MarketSource { return p.source }

// priceLocked resolves the price the matcher crosses against for one symbol:
// the live ticker when a source is injected, else the internal mark. It reports
// ok=false when no honest price exists (no mark, or the source failed/empty) —
// the caller then lets the order rest rather than filling at a guess.
func (p *Paper) priceLocked(symbol string) (string, bool) {
	if p.source != nil {
		t, err := p.source.GetTicker(context.Background(), symbol)
		if err != nil {
			return "", false
		}
		for _, v := range []*string{t.Last, t.Bid, t.Ask} {
			if v != nil && *v != "" {
				return *v, true
			}
		}
		return "", false
	}
	m, ok := p.marks[symbol]
	return m, ok
}

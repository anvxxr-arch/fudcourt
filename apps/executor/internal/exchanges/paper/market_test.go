package paper

import (
	"context"
	"errors"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges"
)

// stubSource is a hand-controlled paper.MarketSource: a live tape without a
// network, so the source seam can be asserted deterministically.
type stubSource struct {
	ticker execution.Ticker
	marks  []exchanges.Market
	fees   exchanges.FeeModel
	err    error
}

func (s stubSource) GetTicker(context.Context, string) (execution.Ticker, error) {
	if s.err != nil {
		return execution.Ticker{}, s.err
	}
	return s.ticker, nil
}
func (s stubSource) GetMarkets(context.Context) ([]exchanges.Market, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.marks, nil
}
func (s stubSource) GetFees(context.Context, string) (exchanges.FeeModel, error) {
	if s.err != nil {
		return exchanges.FeeModel{}, s.err
	}
	return s.fees, nil
}

func lastOf(price string) execution.Ticker {
	return execution.Ticker{Symbol: "BTC/USDT", Last: &price}
}

// A market order fills AT PLACEMENT against the injected live tape — the
// faithful TS behaviour (placeOrder runs matchOrder immediately). The hermetic
// simulator has no mark for the symbol, so without the source it could not fill.
func TestSourceMarketOrderFillsFromLiveTape(t *testing.T) {
	tape := lastOf("100000")
	p, err := NewPaper(PaperConfig{
		MarketType: execution.MarketLinearPerp,
		Source:     stubSource{ticker: tape},
		// deliberately no Marks: the price must come from the source
	})
	if err != nil {
		t.Fatal(err)
	}
	order, err := p.CreateOrder(context.Background(), execution.OrderRequest{
		ClientOrderID: "c1",
		Symbol:        "BTC/USDT",
		Side:          execution.SideBuy,
		Quantity:      "0.01",
		OrderType:     "market",
		Intent:        execution.IntentOpen,
	})
	if err != nil {
		t.Fatalf("CreateOrder: %v", err)
	}
	if order.Status != execution.ChildFilled {
		t.Fatalf("status = %s, want FILLED (market fills at placement)", order.Status)
	}
	fills, _ := p.GetFills(context.Background(), "BTC/USDT")
	if len(fills) != 1 {
		t.Fatalf("got %d fills, want 1", len(fills))
	}
	// 100000 with default 5 bps slippage on a buy → 100050, never the raw mark.
	if fills[0].Price != "100050" {
		t.Fatalf("fill price = %s, want 100050 (mark + slippage)", fills[0].Price)
	}
}

// GetTicker/GetMarkets/GetFees delegate to the source (the paper venue owns
// MATCHING, the source owns the tape — the TS PaperExchangeAdapter split).
func TestSourceReadSurfaceDelegates(t *testing.T) {
	tape := lastOf("42000")
	md := exchanges.Market{Symbol: "BTC/USDT", MarketType: execution.MarketSpot}
	src := stubSource{ticker: tape, marks: []exchanges.Market{md}, fees: exchanges.FeeModel{MakerBps: "0", TakerBps: "0"}}
	p, err := NewPaper(PaperConfig{MarketType: execution.MarketSpot, Source: src})
	if err != nil {
		t.Fatal(err)
	}
	got, err := p.GetTicker(context.Background(), "BTC/USDT")
	if err != nil || got.Last == nil || *got.Last != "42000" {
		t.Fatalf("GetTicker delegated badly: %#v %v", got, err)
	}
	markets, err := p.GetMarkets(context.Background())
	if err != nil || len(markets) != 1 || markets[0].Symbol != "BTC/USDT" {
		t.Fatalf("GetMarkets delegated badly: %#v %v", markets, err)
	}
	fees, err := p.GetFees(context.Background(), "BTC/USDT")
	if err != nil || fees.TakerBps != "0" {
		t.Fatalf("GetFees delegated badly: %#v %v", fees, err)
	}
}

// A source failure must NOT become a fabricated price: the order rests (stays
// OPEN) rather than filling at a guess (house rule: never fake a number).
func TestSourceFailureLeavesOrderResting(t *testing.T) {
	p, err := NewPaper(PaperConfig{
		MarketType: execution.MarketSpot,
		Source:     stubSource{err: errors.New("upstream down")},
	})
	if err != nil {
		t.Fatal(err)
	}
	order, err := p.CreateOrder(context.Background(), execution.OrderRequest{
		ClientOrderID: "c1",
		Symbol:        "BTC/USDT",
		Side:          execution.SideBuy,
		Quantity:      "0.01",
		OrderType:     "market",
		Intent:        execution.IntentOpen,
	})
	if err != nil {
		t.Fatalf("CreateOrder: %v", err)
	}
	if order.Status != execution.ChildOpen {
		t.Fatalf("status = %s, want OPEN (no price ⇒ no fill)", order.Status)
	}
	fills, _ := p.GetFills(context.Background(), "BTC/USDT")
	if len(fills) != 0 {
		t.Fatalf("fabricated %d fills against a failed source", len(fills))
	}
}

// A nil source keeps the hermetic simulator: prices come from Marks and no
// delegation occurs. This pins that the production seam did not change the
// test-only behaviour every existing unit test depends on.
func TestNilSourceKeepsHermeticSimulator(t *testing.T) {
	p, err := NewPaper(PaperConfig{
		MarketType: execution.MarketSpot,
		Marks:      map[string]string{"BTC/USDT": "100000"},
		FillRate:   "1",
	})
	if err != nil {
		t.Fatal(err)
	}
	order, err := p.CreateOrder(context.Background(), execution.OrderRequest{
		ClientOrderID: "c1",
		Symbol:        "BTC/USDT",
		Side:          execution.SideBuy,
		Quantity:      "0.01",
		OrderType:     "market",
		Intent:        execution.IntentOpen,
	})
	if err != nil {
		t.Fatal(err)
	}
	if order.Status != execution.ChildFilled {
		t.Fatalf("hermetic fill status = %s, want FILLED", order.Status)
	}
}

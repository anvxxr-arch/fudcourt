package paper

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/exchanges"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/platform/decimal"
)

// The scenarios below pin the paper venue's observable behavior end to end:
// acceptance, refusals, matching, settlement, idempotency, failure knobs and
// simulated time. Expected money values are exact decimal strings computed by
// hand from the documented knobs (mark 100000, 10 bps slip -> 100100, 5 bps
// taker fee -> 50.05), never re-derived through the code under test.

const baseMs = 1_700_000_000_000

func newPaper(t *testing.T, mut func(*PaperConfig)) *Paper {
	t.Helper()
	cfg := PaperConfig{
		Clock:    exchanges.FixedClock{Millis: baseMs},
		Balances: []execution.Balance{{Asset: "USDT", Free: "1000000", Used: "0"}},
		Marks:    map[string]string{"BTC/USDT": "100000"},
	}
	if mut != nil {
		mut(&cfg)
	}
	p, err := NewPaper(cfg)
	if err != nil {
		t.Fatalf("NewPaper: %v", err)
	}
	return p
}

func marketReq(client, side, qty string) execution.OrderRequest {
	return marketReqOn(client, "BTC/USDT", side, qty)
}

// marketReqOn is marketReq for a chosen canonical symbol.
func marketReqOn(client, symbol, side, qty string) execution.OrderRequest {
	return execution.OrderRequest{
		ClientOrderID: client,
		Symbol:        symbol,
		Side:          execution.Side(side),
		Quantity:      qty,
		OrderType:     "market",
		TimeInForce:   execution.TIFGTC,
		Intent:        execution.IntentOpen,
		ExecutionID:   "exec_1",
	}
}

func limitReq(client, side, price, qty string) execution.OrderRequest {
	req := marketReq(client, side, qty)
	req.OrderType = "limit"
	req.Price = price
	return req
}

func TestNewPaperValidation(t *testing.T) {
	tests := []struct {
		name    string
		mut     func(*PaperConfig)
		wantErr error
	}{
		{name: "zero config is valid", mut: nil},
		{name: "fill rate zero", mut: func(c *PaperConfig) { c.FillRate = "0" }, wantErr: ErrInvalidFillRate},
		{name: "fill rate above one", mut: func(c *PaperConfig) { c.FillRate = "1.5" }, wantErr: ErrInvalidFillRate},
		{name: "fill rate malformed", mut: func(c *PaperConfig) { c.FillRate = "abc" }, wantErr: ErrInvalidFillRate},
		{name: "mark symbol not canonical", mut: func(c *PaperConfig) { c.Marks = map[string]string{"BTCUSDT": "1"} }, wantErr: ErrInvalidMark},
		{name: "mark price zero", mut: func(c *PaperConfig) { c.Marks = map[string]string{"BTC/USDT": "0"} }, wantErr: ErrInvalidMark},
		{name: "mark price malformed", mut: func(c *PaperConfig) { c.Marks = map[string]string{"BTC/USDT": "x"} }, wantErr: ErrInvalidMark},
		{name: "balance without asset", mut: func(c *PaperConfig) {
			c.Balances = []execution.Balance{{Asset: "", Free: "1", Used: "0"}}
		}, wantErr: ErrInvalidBalances},
		{name: "balance duplicate asset", mut: func(c *PaperConfig) {
			c.Balances = []execution.Balance{{Asset: "USDT", Free: "1", Used: "0"}, {Asset: "USDT", Free: "2", Used: "0"}}
		}, wantErr: ErrInvalidBalances},
		{name: "balance negative free", mut: func(c *PaperConfig) {
			c.Balances = []execution.Balance{{Asset: "USDT", Free: "-1", Used: "0"}}
		}, wantErr: ErrInvalidBalances},
		{name: "balance malformed", mut: func(c *PaperConfig) {
			c.Balances = []execution.Balance{{Asset: "USDT", Free: "x", Used: "0"}}
		}, wantErr: ErrInvalidBalances},
		{name: "negative slippage", mut: func(c *PaperConfig) { c.SlippageBps = -1 }, wantErr: exchanges.ErrInvalidOrder},
		{name: "negative spread", mut: func(c *PaperConfig) { c.SpreadBps = -1 }, wantErr: exchanges.ErrInvalidOrder},
		{name: "negative latency", mut: func(c *PaperConfig) { c.Latency = -time.Millisecond }, wantErr: exchanges.ErrInvalidOrder},
		{name: "negative failure count", mut: func(c *PaperConfig) { c.TimeoutCalls = -1 }, wantErr: exchanges.ErrInvalidOrder},
		{name: "bad market type", mut: func(c *PaperConfig) { c.MarketType = "margin" }, wantErr: exchanges.ErrInvalidOrder},
		{name: "bad reject category", mut: func(c *PaperConfig) { c.RejectCategory = "silly" }, wantErr: exchanges.ErrInvalidOrder},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := NewPaper(PaperConfig{})
			if tt.mut != nil {
				cfg := PaperConfig{
					Clock:    exchanges.FixedClock{Millis: baseMs},
					Balances: []execution.Balance{{Asset: "USDT", Free: "1000000", Used: "0"}},
					Marks:    map[string]string{"BTC/USDT": "100000"},
				}
				tt.mut(&cfg)
				_, err = NewPaper(cfg)
			}
			if tt.wantErr == nil {
				if err != nil {
					t.Fatalf("NewPaper: unexpected error %v", err)
				}
				return
			}
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("NewPaper error = %v, want errors.Is(%v)", err, tt.wantErr)
			}
		})
	}
}

func TestCreateOrderValidation(t *testing.T) {
	bad := marketReq("c1", "buy", "1")
	badNoClient := bad
	badNoClient.ClientOrderID = ""
	badSymbol := bad
	badSymbol.Symbol = "BTCUSDT"
	badSide := bad
	badSide.Side = "hold"
	badType := bad
	badType.OrderType = "stop"
	badTIF := bad
	badTIF.TimeInForce = "DAY"
	badQty := bad
	badQty.Quantity = "0"
	badQtyNeg := bad
	badQtyNeg.Quantity = "-1"
	badQtyMal := bad
	badQtyMal.Quantity = "abc"
	limitNoPrice := limitReq("c2", "buy", "", "1")
	limitBadPrice := limitReq("c2", "buy", "x", "1")
	marketWithPrice := marketReq("c3", "buy", "1")
	marketWithPrice.Price = "100000"
	badIntent := bad
	badIntent.Intent = "hedge"

	tests := []struct {
		name string
		req  execution.OrderRequest
	}{
		{name: "missing client order id", req: badNoClient},
		{name: "symbol not canonical", req: badSymbol},
		{name: "unknown side", req: badSide},
		{name: "unknown type", req: badType},
		{name: "unknown time in force", req: badTIF},
		{name: "zero quantity", req: badQty},
		{name: "negative quantity", req: badQtyNeg},
		{name: "malformed quantity", req: badQtyMal},
		{name: "limit without price", req: limitNoPrice},
		{name: "limit malformed price", req: limitBadPrice},
		{name: "market with price", req: marketWithPrice},
		{name: "unknown intent", req: badIntent},
	}
	p := newPaper(t, nil)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := p.CreateOrder(context.Background(), tt.req)
			if !errors.Is(err, exchanges.ErrInvalidOrder) {
				t.Fatalf("CreateOrder error = %v, want ErrInvalidOrder", err)
			}
		})
	}
}

func TestCreateOrderAcceptance(t *testing.T) {
	tests := []struct {
		name        string
		req         execution.OrderRequest
		wantStatus  execution.ChildOrderStatus
		wantFilled  string
		wantFillPx  string
		wantFillFee string
		wantIsExit  bool
	}{
		{
			name: "market buy fills immediately at mark plus slippage",
			req:  marketReq("m1", "buy", "1"),
			// mark 100000 + 10 bps slip = 100100; taker fee 5 bps = 50.05.
			wantStatus:  execution.ChildFilled,
			wantFilled:  "1",
			wantFillPx:  "100100",
			wantFillFee: "50.05",
		},
		{
			name: "resting limit buy accepted open",
			req:  limitReq("l1", "buy", "95000", "1"),
			// mark 100000 > 95000: no cross, nothing filled.
			wantStatus: execution.ChildOpen,
			wantFilled: "0",
		},
		{
			name: "crossed limit buy fills at the limit price",
			req:  limitReq("l2", "buy", "100000", "1"),
			// mark == limit crosses; maker fee 2 bps of 100000 = 20.
			wantStatus:  execution.ChildFilled,
			wantFilled:  "1",
			wantFillPx:  "100000",
			wantFillFee: "20",
		},
		{
			name: "close intent marks the order as exit",
			req: func() execution.OrderRequest {
				r := marketReq("m2", "buy", "1")
				r.Intent = execution.IntentClose
				return r
			}(),
			wantStatus:  execution.ChildFilled,
			wantFilled:  "1",
			wantFillPx:  "100100",
			wantFillFee: "50.05",
			wantIsExit:  true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := newPaper(t, func(c *PaperConfig) { c.SlippageBps = 10 })
			order, err := p.CreateOrder(context.Background(), tt.req)
			if err != nil {
				t.Fatalf("CreateOrder: %v", err)
			}
			if order.ExchangeOrderID != "paper_order_1" {
				t.Errorf("ExchangeOrderID = %q, want paper_order_1", order.ExchangeOrderID)
			}
			if order.Status != tt.wantStatus {
				t.Errorf("Status = %q, want %q", order.Status, tt.wantStatus)
			}
			if order.FilledQuantity != tt.wantFilled {
				t.Errorf("FilledQuantity = %q, want %q", order.FilledQuantity, tt.wantFilled)
			}
			if order.IsExit != tt.wantIsExit {
				t.Errorf("IsExit = %v, want %v", order.IsExit, tt.wantIsExit)
			}
			if order.SubmittedAt != baseMs || order.UpdatedAt != baseMs {
				t.Errorf("timestamps = %d/%d, want %d", order.SubmittedAt, order.UpdatedAt, baseMs)
			}
			fills, err := p.GetFills(context.Background(), "BTC/USDT")
			if err != nil {
				t.Fatalf("GetFills: %v", err)
			}
			if tt.wantFillPx == "" {
				if len(fills) != 0 {
					t.Fatalf("unexpected fills %+v", fills)
				}
				return
			}
			if len(fills) != 1 {
				t.Fatalf("fills = %+v, want exactly one", fills)
			}
			f := fills[0]
			if f.ExchangeTradeID != "paper_trade_1" {
				t.Errorf("ExchangeTradeID = %q, want paper_trade_1", f.ExchangeTradeID)
			}
			if f.ClientOrderID != tt.req.ClientOrderID {
				t.Errorf("ClientOrderID = %q, want %q", f.ClientOrderID, tt.req.ClientOrderID)
			}
			if f.Price != tt.wantFillPx || f.Quantity != "1" || f.QuoteQuantity != tt.wantFillPx {
				t.Errorf("fill = (%s, %s, %s), want (%s, 1, %s)", f.Price, f.Quantity, f.QuoteQuantity, tt.wantFillPx, tt.wantFillPx)
			}
			if f.Fee != tt.wantFillFee || f.FeeAsset != "USDT" {
				t.Errorf("fee = %s %s, want %s USDT", f.Fee, f.FeeAsset, tt.wantFillFee)
			}
			if f.Timestamp != baseMs {
				t.Errorf("fill Timestamp = %d, want %d", f.Timestamp, baseMs)
			}
		})
	}
}

func TestCreateOrderIdempotent(t *testing.T) {
	p := newPaper(t, nil)
	first, err := p.CreateOrder(context.Background(), marketReq("same", "buy", "1"))
	if err != nil {
		t.Fatalf("CreateOrder: %v", err)
	}
	second, err := p.CreateOrder(context.Background(), marketReq("same", "buy", "1"))
	if err != nil {
		t.Fatalf("idempotent replay: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("replay returned a different order:\n first  %+v\n second %+v", first, second)
	}
	fills, err := p.GetFills(context.Background(), "BTC/USDT")
	if err != nil {
		t.Fatalf("GetFills: %v", err)
	}
	if len(fills) != 1 {
		t.Fatalf("replay created new state: fills = %+v", fills)
	}
	if _, err := p.GetOrder(context.Background(), "BTC/USDT", "paper_order_2"); !errors.Is(err, exchanges.ErrOrderNotFound) {
		t.Fatalf("second venue order exists: %v", err)
	}

	// A replay returns the SAME order in its CURRENT state even after further
	// fills; it never restarts or duplicates (0.4 of 10 per pass: 4 at
	// acceptance + 4 in the extra Match = 8).
	p2 := newPaper(t, func(c *PaperConfig) { c.FillRate = "0.4" })
	if _, err := p2.CreateOrder(context.Background(), limitReq("p", "buy", "100000", "10")); err != nil {
		t.Fatalf("CreateOrder: %v", err)
	}
	if err := p2.Match(); err != nil {
		t.Fatalf("Match: %v", err)
	}
	replay, err := p2.CreateOrder(context.Background(), limitReq("p", "buy", "100000", "10"))
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if replay.ExchangeOrderID != "paper_order_1" || replay.FilledQuantity != "8" || replay.Status != execution.ChildPartial {
		t.Fatalf("replay = %+v, want paper_order_1 PARTIAL 8", replay)
	}
}

func TestPartialFillsViaFillRate(t *testing.T) {
	p := newPaper(t, func(c *PaperConfig) { c.FillRate = "0.4" })
	ctx := context.Background()
	order, err := p.CreateOrder(ctx, limitReq("pf", "buy", "100000", "10"))
	if err != nil {
		t.Fatalf("CreateOrder: %v", err)
	}
	// One pass per call: 4, 4, then the tail (chunk 4 exceeds the remaining 2,
	// the TS step-safe rule finishes the order).
	want := []struct {
		status execution.ChildOrderStatus
		filled string
	}{
		{execution.ChildPartial, "4"},
		{execution.ChildPartial, "8"},
		{execution.ChildFilled, "10"},
	}
	if order.Status != want[0].status || order.FilledQuantity != want[0].filled {
		t.Fatalf("after acceptance: %s %s, want %s %s", order.Status, order.FilledQuantity, want[0].status, want[0].filled)
	}
	for i, step := range want[1:] {
		if err := p.Match(); err != nil {
			t.Fatalf("Match %d: %v", i+2, err)
		}
		got, err := p.GetOrder(ctx, "BTC/USDT", "paper_order_1")
		if err != nil {
			t.Fatalf("GetOrder: %v", err)
		}
		if got.Status != step.status || got.FilledQuantity != step.filled {
			t.Fatalf("pass %d: %s %s, want %s %s", i+2, got.Status, got.FilledQuantity, step.status, step.filled)
		}
	}
	fills, err := p.GetFills(ctx, "BTC/USDT")
	if err != nil {
		t.Fatalf("GetFills: %v", err)
	}
	wantQty := []string{"4", "4", "2"}
	wantFee := []string{"80", "80", "40"} // maker 2 bps of 400000 / 400000 / 200000
	if len(fills) != len(wantQty) {
		t.Fatalf("fills = %+v, want %d", fills, len(wantQty))
	}
	for i, f := range fills {
		if f.Quantity != wantQty[i] || f.Fee != wantFee[i] || f.Price != "100000" {
			t.Errorf("fill %d = (%s, %s, fee %s), want (%s, 100000, fee %s)", i, f.Quantity, f.Price, f.Fee, wantQty[i], wantFee[i])
		}
	}
}

func TestGetFillsSymbolScoping(t *testing.T) {
	p := newPaper(t, func(c *PaperConfig) { c.Marks["ETH/USDT"] = "3000" })
	ctx := context.Background()
	for _, req := range []execution.OrderRequest{
		marketReq("btc-1", "buy", "1"),
		marketReqOn("eth-1", "ETH/USDT", "buy", "1"),
		marketReq("btc-2", "sell", "1"),
	} {
		if _, err := p.CreateOrder(ctx, req); err != nil {
			t.Fatalf("CreateOrder(%s): %v", req.ClientOrderID, err)
		}
	}
	btc, err := p.GetFills(ctx, "BTC/USDT")
	if err != nil {
		t.Fatalf("GetFills(BTC/USDT): %v", err)
	}
	if len(btc) != 2 {
		t.Fatalf("BTC fills = %+v, want 2", btc)
	}
	if btc[0].ClientOrderID != "btc-1" || btc[1].ClientOrderID != "btc-2" {
		t.Errorf("BTC fill order = %s,%s, want btc-1,btc-2", btc[0].ClientOrderID, btc[1].ClientOrderID)
	}
	eth, err := p.GetFills(ctx, "ETH/USDT")
	if err != nil {
		t.Fatalf("GetFills(ETH/USDT): %v", err)
	}
	if len(eth) != 1 || eth[0].ClientOrderID != "eth-1" {
		t.Fatalf("ETH fills = %+v, want exactly eth-1", eth)
	}
	if _, err := p.GetFills(ctx, "DOGE/USDT"); err != nil {
		t.Fatalf("empty symbol scope must not error: %v", err)
	}
}

func TestFailureKnobs(t *testing.T) {
	tests := []struct {
		name          string
		mut           func(*PaperConfig)
		wantCategory  execution.ErrorCategory
		wantRetryable bool
		wantDeadline  bool
	}{
		{
			name:          "timeout classifies as network_retryable wrapping DeadlineExceeded",
			mut:           func(c *PaperConfig) { c.TimeoutCalls = 1 },
			wantCategory:  execution.ErrNetworkRetryable,
			wantRetryable: true,
			wantDeadline:  true,
		},
		{
			name:          "network error classifies as network_retryable",
			mut:           func(c *PaperConfig) { c.NetworkErrorCalls = 1 },
			wantCategory:  execution.ErrNetworkRetryable,
			wantRetryable: true,
		},
		{
			name:          "overload classifies as exchange_overload",
			mut:           func(c *PaperConfig) { c.OverloadCalls = 1 },
			wantCategory:  execution.ErrExchangeOverload,
			wantRetryable: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := newPaper(t, tt.mut)
			ctx := context.Background()
			_, err := p.GetAccount(ctx)
			if err == nil {
				t.Fatal("first call must fail while the knob is armed")
			}
			class := exchanges.Classify(err)
			if class.Category != tt.wantCategory || class.Retryable != tt.wantRetryable {
				t.Errorf("Classify = %+v, want category %s retryable %v", class, tt.wantCategory, tt.wantRetryable)
			}
			if got := errors.Is(err, context.DeadlineExceeded); got != tt.wantDeadline {
				t.Errorf("errors.Is(DeadlineExceeded) = %v, want %v", got, tt.wantDeadline)
			}
			// The knob is consumed exactly once per call.
			if _, err := p.GetAccount(ctx); err != nil {
				t.Fatalf("second call must succeed once consumed: %v", err)
			}
		})
	}
}

func TestRejectOrdersKnob(t *testing.T) {
	p := newPaper(t, func(c *PaperConfig) {
		c.RejectOrders = 1
		c.RejectCode = "max_orders"
		c.RejectCategory = execution.ErrRateLimited
	})
	ctx := context.Background()
	_, err := p.CreateOrder(ctx, marketReq("r1", "buy", "1"))
	if err == nil {
		t.Fatal("CreateOrder must be rejected while the knob is armed")
	}
	var ve *exchanges.VenueError
	if !errors.As(err, &ve) {
		t.Fatalf("rejection = %T %v, want *exchanges.VenueError", err, err)
	}
	if ve.Code != "max_orders" || ve.Class.Category != execution.ErrRateLimited || !ve.Class.Retryable {
		t.Errorf("VenueError = code %q class %+v, want max_orders rate_limited retryable", ve.Code, ve.Class)
	}
	// Nothing was created by the rejected call.
	if fills, _ := p.GetFills(ctx, "BTC/USDT"); len(fills) != 0 {
		t.Fatalf("rejection created fills %+v", fills)
	}
	// The retry with the same ClientOrderID places the order for real.
	order, err := p.CreateOrder(ctx, marketReq("r1", "buy", "1"))
	if err != nil {
		t.Fatalf("retry after rejection: %v", err)
	}
	if order.ExchangeOrderID != "paper_order_1" || order.Status != execution.ChildFilled {
		t.Fatalf("retry order = %+v, want paper_order_1 FILLED", order)
	}

	// Defaults: code "paper_reject", category invalid_order.
	p2 := newPaper(t, func(c *PaperConfig) { c.RejectOrders = 1 })
	_, err = p2.CreateOrder(ctx, marketReq("r2", "buy", "1"))
	if !errors.As(err, &ve) {
		t.Fatalf("default rejection = %T %v, want *exchanges.VenueError", err, err)
	}
	if ve.Code != "paper_reject" || ve.Class.Category != execution.ErrInvalidOrder {
		t.Errorf("default rejection = code %q class %+v, want paper_reject invalid_order", ve.Code, ve.Class)
	}
}

func TestLatencySimulation(t *testing.T) {
	tests := []struct {
		name    string
		latency time.Duration
		wantTs  []int64 // timestamps of ticker 1, ticker 2, first fill
	}{
		{name: "zero latency keeps clock pinned", latency: 0, wantTs: []int64{baseMs, baseMs, baseMs}},
		{name: "latency advances simulated time per call", latency: 250 * time.Millisecond,
			wantTs: []int64{baseMs + 250, baseMs + 500, baseMs + 750}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := newPaper(t, func(c *PaperConfig) { c.Latency = tt.latency })
			ctx := context.Background()
			for i := range 2 {
				ticker, err := p.GetTicker(ctx, "BTC/USDT")
				if err != nil {
					t.Fatalf("GetTicker %d: %v", i+1, err)
				}
				if ticker.Ts != tt.wantTs[i] {
					t.Errorf("ticker %d Ts = %d, want %d", i+1, ticker.Ts, tt.wantTs[i])
				}
			}
			if _, err := p.CreateOrder(ctx, marketReq("lat", "buy", "1")); err != nil {
				t.Fatalf("CreateOrder: %v", err)
			}
			fills, err := p.GetFills(ctx, "BTC/USDT")
			if err != nil {
				t.Fatalf("GetFills: %v", err)
			}
			if len(fills) != 1 || fills[0].Timestamp != tt.wantTs[2] {
				t.Fatalf("fill timestamp = %+v, want %d", fills, tt.wantTs[2])
			}
		})
	}
}

func TestPriceMoveFillsRestingLimit(t *testing.T) {
	tests := []struct {
		name         string
		order        execution.OrderRequest
		action       func(*Paper) error
		wantFillPx   string
		wantNotional string
	}{
		{
			name:  "MoveMarkBps crosses a resting buy",
			order: limitReq("mv", "buy", "95000", "1"),
			action: func(p *Paper) error {
				// 100000 * (1 - 500 bps) = 95000: the mark lands on the limit.
				return p.MoveMarkBps("BTC/USDT", -500)
			},
			wantFillPx:   "95000",
			wantNotional: "95000",
		},
		{
			name:  "SetMark crosses a resting sell",
			order: limitReq("sm", "sell", "105000", "1"),
			action: func(p *Paper) error {
				return p.SetMark("BTC/USDT", "110000")
			},
			wantFillPx:   "105000",
			wantNotional: "105000",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := newPaper(t, nil)
			ctx := context.Background()
			// A sell fills against the base balance the paper account owns.
			if tt.order.Side == execution.SideSell {
				if err := p.SetMark("BTC/USDT", "100000"); err != nil {
					t.Fatalf("SetMark: %v", err)
				}
			}
			order, err := p.CreateOrder(ctx, tt.order)
			if err != nil {
				t.Fatalf("CreateOrder: %v", err)
			}
			if order.Status != execution.ChildOpen {
				t.Fatalf("order must rest before the move: %s", order.Status)
			}
			if err := tt.action(p); err != nil {
				t.Fatalf("action: %v", err)
			}
			// A mark move alone runs no pass; the order is still resting.
			resting, err := p.GetOrder(ctx, "BTC/USDT", order.ExchangeOrderID)
			if err != nil {
				t.Fatalf("GetOrder: %v", err)
			}
			if resting.Status != execution.ChildOpen {
				t.Fatalf("mark move must not match on its own: %s", resting.Status)
			}
			if err := p.Match(); err != nil {
				t.Fatalf("Match: %v", err)
			}
			filled, err := p.GetOrder(ctx, "BTC/USDT", order.ExchangeOrderID)
			if err != nil {
				t.Fatalf("GetOrder: %v", err)
			}
			if filled.Status != execution.ChildFilled || filled.FilledQuantity != "1" {
				t.Fatalf("order = %+v, want FILLED 1", filled)
			}
			fills, err := p.GetFills(ctx, "BTC/USDT")
			if err != nil {
				t.Fatalf("GetFills: %v", err)
			}
			if len(fills) != 1 || fills[0].Price != tt.wantFillPx || fills[0].QuoteQuantity != tt.wantNotional {
				t.Fatalf("fill = %+v, want price %s notional %s", fills, tt.wantFillPx, tt.wantNotional)
			}
		})
	}
}

func TestPositionLifecycle(t *testing.T) {
	p := newPaper(t, func(c *PaperConfig) { c.SlippageBps = 10 })
	ctx := context.Background()
	if _, err := p.GetPosition(ctx, "BTC/USDT"); !errors.Is(err, exchanges.ErrNoPosition) {
		t.Fatalf("flat GetPosition = %v, want ErrNoPosition", err)
	}
	// Long 1 @ 100100 (mark 100000 + 10 bps slip).
	if _, err := p.CreateOrder(ctx, marketReq("p1", "buy", "1")); err != nil {
		t.Fatalf("buy: %v", err)
	}
	pos, err := p.GetPosition(ctx, "BTC/USDT")
	if err != nil {
		t.Fatalf("GetPosition: %v", err)
	}
	if pos.Quantity != "1" || pos.Side != execution.SideBuy || pos.EntryPrice != "100100" || pos.PositionSide != "net" {
		t.Fatalf("position = %+v, want long 1 @ 100100", pos)
	}
	if pos.Leverage != nil || pos.MarginMode != nil || pos.LiquidationPrice != nil {
		t.Fatalf("paper must keep leverage/margin/liquidation honestly nil: %+v", pos)
	}
	// A partial reduce keeps the entry price.
	if _, err := p.CreateOrder(ctx, marketReq("p2", "sell", "0.4")); err != nil {
		t.Fatalf("reduce: %v", err)
	}
	pos, err = p.GetPosition(ctx, "BTC/USDT")
	if err != nil {
		t.Fatalf("GetPosition: %v", err)
	}
	if pos.Quantity != "0.6" || pos.EntryPrice != "100100" {
		t.Fatalf("after reduce = %+v, want 0.6 @ 100100", pos)
	}
	// Close to flat: flat is ErrNoPosition again.
	if _, err := p.CreateOrder(ctx, marketReq("p3", "sell", "0.6")); err != nil {
		t.Fatalf("close: %v", err)
	}
	if _, err := p.GetPosition(ctx, "BTC/USDT"); !errors.Is(err, exchanges.ErrNoPosition) {
		t.Fatalf("flat after close = %v, want ErrNoPosition", err)
	}
	// Short: signed quantity is negative.
	if _, err := p.CreateOrder(ctx, marketReq("p4", "sell", "1")); err != nil {
		t.Fatalf("short: %v", err)
	}
	pos, err = p.GetPosition(ctx, "BTC/USDT")
	if err != nil {
		t.Fatalf("GetPosition: %v", err)
	}
	if pos.Quantity != "-1" || pos.Side != execution.SideSell || pos.EntryPrice != "99900" {
		t.Fatalf("short = %+v, want -1 @ 99900 (mark 100000 - 10 bps slip)", pos)
	}
}

func TestLinearSettlement(t *testing.T) {
	p := newPaper(t, func(c *PaperConfig) {
		c.MarketType = execution.MarketLinearPerp
		c.SlippageBps = 10
	})
	ctx := context.Background()
	// Open long 1 @ 100100 (taker fee 50.05): quote absorbs the fee only.
	if _, err := p.CreateOrder(ctx, marketReq("lin1", "buy", "1")); err != nil {
		t.Fatalf("open: %v", err)
	}
	// Move to 110000 and close: fill 109890 (110000 - 10 bps), realized PnL
	// (109890 - 100100) * 1 = 9790, taker fee 54.945.
	if err := p.SetMark("BTC/USDT", "110000"); err != nil {
		t.Fatalf("SetMark: %v", err)
	}
	if _, err := p.CreateOrder(ctx, marketReq("lin2", "sell", "1")); err != nil {
		t.Fatalf("close: %v", err)
	}
	if _, err := p.GetPosition(ctx, "BTC/USDT"); !errors.Is(err, exchanges.ErrNoPosition) {
		t.Fatalf("closed position = want ErrNoPosition")
	}
	equity, err := p.GetBalance(ctx)
	if err != nil {
		t.Fatalf("GetBalance: %v", err)
	}
	if equity.SpotEquity != nil {
		t.Errorf("SpotEquity = %s, want nil on linear_perp", *equity.SpotEquity)
	}
	if equity.FuturesEquity == nil {
		t.Fatal("FuturesEquity = nil, want set on linear_perp")
	}
	// 1000000 - 50.05 - 54.945 + 9790 = 1009685.005.
	if *equity.FuturesEquity != "1009685.005" {
		t.Errorf("FuturesEquity = %s, want 1009685.005", *equity.FuturesEquity)
	}
	// Linear settlement never touches the base wallet.
	if _, err := p.GetPosition(ctx, "BTC/USDT"); err == nil {
		t.Fatal("expected ErrNoPosition")
	}
	for _, b := range equity.Balances {
		if b.Asset == "BTC" {
			t.Fatalf("linear settlement created a base wallet row: %+v", b)
		}
	}
}

func TestGetBalanceBasisAndSorting(t *testing.T) {
	p := newPaper(t, func(c *PaperConfig) {
		// Deliberately unsorted with a garbage Total that must be recomputed.
		c.Balances = []execution.Balance{
			{Asset: "ETH", Free: "5", Used: "0", Total: "999"},
			{Asset: "BTC", Free: "2", Used: "1", Total: "999"},
			{Asset: "USDT", Free: "1000000", Used: "0", Total: "999"},
		}
	})
	equity, err := p.GetBalance(context.Background())
	if err != nil {
		t.Fatalf("GetBalance: %v", err)
	}
	if equity.SpotEquity == nil || equity.FuturesEquity != nil {
		t.Fatalf("spot basis: SpotEquity set/FuturesEquity nil, got %v/%v", equity.SpotEquity, equity.FuturesEquity)
	}
	if equity.Timestamp != baseMs {
		t.Errorf("Timestamp = %d, want %d", equity.Timestamp, baseMs)
	}
	var assets []string
	for _, b := range equity.Balances {
		assets = append(assets, b.Asset)
		wantTotal, err := decimal.Add(b.Free, b.Used)
		if err != nil {
			t.Fatalf("Add: %v", err)
		}
		if b.Total != wantTotal {
			t.Errorf("%s total = %s, want free+used recomputed to %s (was configured as 999)", b.Asset, b.Total, wantTotal)
		}
	}
	if !reflect.DeepEqual(assets, []string{"BTC", "ETH", "USDT"}) {
		t.Errorf("balances not stably sorted by asset: %v", assets)
	}
	// Spot equity is the nominal sum of totals: 3 + 5 + 1000000.
	if *equity.SpotEquity != "1000008" {
		t.Errorf("SpotEquity = %s, want 1000008", *equity.SpotEquity)
	}
}

func TestGetTicker(t *testing.T) {
	ctx := context.Background()
	t.Run("no spread means honest nil touch prices", func(t *testing.T) {
		p := newPaper(t, nil)
		ticker, err := p.GetTicker(ctx, "BTC/USDT")
		if err != nil {
			t.Fatalf("GetTicker: %v", err)
		}
		if ticker.Last == nil || *ticker.Last != "100000" {
			t.Fatalf("Last = %v, want 100000", ticker.Last)
		}
		if ticker.Bid != nil || ticker.Ask != nil {
			t.Fatalf("Bid/Ask = %v/%v, want nil/nil at SpreadBps 0", ticker.Bid, ticker.Ask)
		}
		if ticker.Ts != baseMs {
			t.Errorf("Ts = %d, want %d", ticker.Ts, baseMs)
		}
	})
	t.Run("spread derives symmetric touch prices", func(t *testing.T) {
		p := newPaper(t, func(c *PaperConfig) { c.SpreadBps = 20 })
		ticker, err := p.GetTicker(ctx, "BTC/USDT")
		if err != nil {
			t.Fatalf("GetTicker: %v", err)
		}
		if ticker.Bid == nil || *ticker.Bid != "99900" || ticker.Ask == nil || *ticker.Ask != "100100" {
			t.Fatalf("Bid/Ask = %v/%v, want 99900/100100", ticker.Bid, ticker.Ask)
		}
	})
	t.Run("unknown mark is refused", func(t *testing.T) {
		p := newPaper(t, nil)
		if _, err := p.GetTicker(ctx, "ETH/USDT"); !errors.Is(err, ErrInvalidMark) {
			t.Fatalf("GetTicker = %v, want ErrInvalidMark", err)
		}
		if _, err := p.GetTicker(ctx, "BTCUSDT"); !errors.Is(err, exchanges.ErrInvalidSymbol) {
			t.Fatalf("GetTicker = %v, want ErrInvalidSymbol", err)
		}
	})
}

func TestCancelOrderSemantics(t *testing.T) {
	p := newPaper(t, nil)
	ctx := context.Background()
	resting, err := p.CreateOrder(ctx, limitReq("cx", "buy", "95000", "1"))
	if err != nil {
		t.Fatalf("CreateOrder: %v", err)
	}
	cancelled, err := p.CancelOrder(ctx, "BTC/USDT", resting.ExchangeOrderID)
	if err != nil {
		t.Fatalf("CancelOrder: %v", err)
	}
	if cancelled.Status != execution.ChildCancelled {
		t.Fatalf("Status = %s, want CANCELLED", cancelled.Status)
	}
	if open, _ := p.GetOpenOrders(ctx, "BTC/USDT"); len(open) != 0 {
		t.Fatalf("cancelled order still open: %+v", open)
	}
	// Double-cancel is an idempotent no-op.
	again, err := p.CancelOrder(ctx, "BTC/USDT", resting.ExchangeOrderID)
	if err != nil || again.Status != execution.ChildCancelled {
		t.Fatalf("double cancel = %+v, %v", again, err)
	}

	// Cancelling a filled order is refused with a VenueError (invalid_order).
	filled, err := p.CreateOrder(ctx, marketReq("done", "buy", "1"))
	if err != nil {
		t.Fatalf("CreateOrder: %v", err)
	}
	_, err = p.CancelOrder(ctx, "BTC/USDT", filled.ExchangeOrderID)
	var ve *exchanges.VenueError
	if !errors.As(err, &ve) || ve.Class.Category != execution.ErrInvalidOrder {
		t.Fatalf("cancel filled = %v, want VenueError invalid_order", err)
	}

	// Unknown ids and mismatched symbols are ErrOrderNotFound (documented).
	if _, err := p.CancelOrder(ctx, "BTC/USDT", "paper_order_999"); !errors.Is(err, exchanges.ErrOrderNotFound) {
		t.Fatalf("unknown id = %v, want ErrOrderNotFound", err)
	}
	if _, err := p.CancelOrder(ctx, "ETH/USDT", filled.ExchangeOrderID); !errors.Is(err, exchanges.ErrOrderNotFound) {
		t.Fatalf("wrong symbol = %v, want ErrOrderNotFound", err)
	}
}

func TestChildOrderTransitionGuard(t *testing.T) {
	p := newPaper(t, nil)
	tests := []struct {
		name    string
		from    execution.ChildOrderStatus
		to      execution.ChildOrderStatus
		wantErr bool
	}{
		{name: "open to partial", from: execution.ChildOpen, to: execution.ChildPartial},
		{name: "open to filled", from: execution.ChildOpen, to: execution.ChildFilled},
		{name: "open to cancelled", from: execution.ChildOpen, to: execution.ChildCancelled},
		{name: "partial to filled", from: execution.ChildPartial, to: execution.ChildFilled},
		{name: "filled to cancelled is illegal", from: execution.ChildFilled, to: execution.ChildCancelled, wantErr: true},
		{name: "cancelled to filled is illegal", from: execution.ChildCancelled, to: execution.ChildFilled, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			o := &orderState{order: execution.NormalizedOrder{Status: tt.from}}
			err := p.transitionLocked(o, tt.to)
			if tt.wantErr {
				if !errors.Is(err, ErrIllegalTransition) {
					t.Fatalf("transition error = %v, want ErrIllegalTransition", err)
				}
				if o.order.Status != tt.from {
					t.Fatalf("illegal transition changed status to %s", o.order.Status)
				}
				return
			}
			if err != nil {
				t.Fatalf("legal transition refused: %v", err)
			}
			if o.order.Status != tt.to {
				t.Fatalf("Status = %s, want %s", o.order.Status, tt.to)
			}
		})
	}
}

func TestSeedJitterDeterminism(t *testing.T) {
	mut := func(c *PaperConfig) { c.Seed = 42 }
	p1 := newPaper(t, mut)
	p2 := newPaper(t, mut)
	for _, p := range []*Paper{p1, p2} {
		if _, err := p.CreateOrder(context.Background(), marketReq("j", "buy", "1")); err != nil {
			t.Fatalf("CreateOrder: %v", err)
		}
	}
	f1, _ := p1.GetFills(context.Background(), "BTC/USDT")
	f2, _ := p2.GetFills(context.Background(), "BTC/USDT")
	if len(f1) != 1 || len(f2) != 1 {
		t.Fatalf("fills = %v / %v, want one each", f1, f2)
	}
	if f1[0].Price != f2[0].Price {
		t.Fatalf("same seed diverged: %s vs %s", f1[0].Price, f2[0].Price)
	}
	// Jitter lands in 0..SlippageBps (5 bps of 100000 = 50) above the mark:
	// 100000..100050.
	lo, err := decimal.Cmp(f1[0].Price, "100000")
	if err != nil {
		t.Fatalf("Cmp: %v", err)
	}
	hi, err := decimal.Cmp(f1[0].Price, "100050")
	if err != nil {
		t.Fatalf("Cmp: %v", err)
	}
	if lo < 0 || hi > 0 {
		t.Fatalf("jittered price %s outside [100000, 100050]", f1[0].Price)
	}
	// Default seed: no randomness at all, slippage exactly SlippageBps.
	p3 := newPaper(t, nil)
	if _, err := p3.CreateOrder(context.Background(), marketReq("j", "buy", "1")); err != nil {
		t.Fatalf("CreateOrder: %v", err)
	}
	f3, _ := p3.GetFills(context.Background(), "BTC/USDT")
	if f3[0].Price != "100050" {
		t.Fatalf("default seed fill price = %s, want 100050", f3[0].Price)
	}
}

func TestAdvance(t *testing.T) {
	p := newPaper(t, nil)
	ctx := context.Background()
	if err := p.Advance(-time.Second); err == nil {
		t.Fatal("Advance must refuse negative durations")
	}
	order, err := p.CreateOrder(ctx, limitReq("adv", "buy", "95000", "1"))
	if err != nil {
		t.Fatalf("CreateOrder: %v", err)
	}
	// Cross the mark without matching, then advance: the pass inside Advance
	// fills the order at the simulated time.
	if err := p.MoveMarkBps("BTC/USDT", -500); err != nil {
		t.Fatalf("MoveMarkBps: %v", err)
	}
	if err := p.Advance(2 * time.Second); err != nil {
		t.Fatalf("Advance: %v", err)
	}
	filled, err := p.GetOrder(ctx, "BTC/USDT", order.ExchangeOrderID)
	if err != nil {
		t.Fatalf("GetOrder: %v", err)
	}
	if filled.Status != execution.ChildFilled {
		t.Fatalf("Advance did not run a matching pass: %s", filled.Status)
	}
	fills, err := p.GetFills(ctx, "BTC/USDT")
	if err != nil {
		t.Fatalf("GetFills: %v", err)
	}
	if len(fills) != 1 || fills[0].Timestamp != baseMs+2000 {
		t.Fatalf("fill timestamp = %+v, want %d", fills, baseMs+2000)
	}
}

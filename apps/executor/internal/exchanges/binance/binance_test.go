package binance

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges"
)

// recordingClient is the stub exchanges.HTTPClient: it captures every
// *http.Request and replays a canned response (no network anywhere).
type recordingClient struct {
	reqs    []*http.Request
	respond func(req *http.Request) (*http.Response, error)
}

func (c *recordingClient) Do(req *http.Request) (*http.Response, error) {
	c.reqs = append(c.reqs, req)
	if c.respond == nil {
		return nil, errors.New("recordingClient: no responder configured")
	}
	return c.respond(req)
}

// jsonResp builds a canned HTTP response.
func jsonResp(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{},
	}
}

// newTestBinance builds an adapter pinned to a fixed clock and recorder.
func newTestBinance(t *testing.T, market execution.MarketType, respond func(*http.Request) (*http.Response, error)) (*Binance, *recordingClient) {
	t.Helper()
	rec := &recordingClient{respond: respond}
	b, err := New(Config{
		Credentials: exchanges.Credentials{APIKey: "testkey", APISecret: "testsecret"},
		HTTP:        rec,
		Clock:       exchanges.FixedClock{Millis: 1700000000000},
		MarketType:  market,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return b, rec
}

func TestNewRefusals(t *testing.T) {
	okHTTP := exchanges.HTTPClientFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("unused") })
	cases := []struct {
		name    string
		cfg     Config
		wantErr error
	}{
		{
			name:    "empty credentials refused",
			cfg:     Config{HTTP: okHTTP},
			wantErr: ErrNoCredentials,
		},
		{
			name:    "key without secret refused",
			cfg:     Config{Credentials: exchanges.Credentials{APIKey: "k"}, HTTP: okHTTP},
			wantErr: ErrNoCredentials,
		},
		{
			name:    "nil http client refused",
			cfg:     Config{Credentials: exchanges.Credentials{APIKey: "k", APISecret: "s"}},
			wantErr: ErrNoHTTPClient,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := New(tc.cfg); !errors.Is(err, tc.wantErr) {
				t.Fatalf("New error = %v, want %v", err, tc.wantErr)
			}
		})
	}
}

func TestSignQueryVector(t *testing.T) {
	// Deterministic HMAC-SHA256 vector: the expected digest is computed here
	// with an independent stdlib HMAC so the assertion is byte-exact against a
	// second, separately written implementation.
	query := "symbol=BTCUSDT&orderId=42&timestamp=1700000000000&recvWindow=5000"
	mac := hmac.New(sha256.New, []byte("testsecret"))
	mac.Write([]byte(query))
	want := hex.EncodeToString(mac.Sum(nil))

	got := SignQuery(query, "testsecret")
	if got != want {
		t.Fatalf("SignQuery = %q, want %q", got, want)
	}
	if again := SignQuery(query, "testsecret"); again != got {
		t.Fatalf("SignQuery not deterministic: %q vs %q", got, again)
	}
	if len(got) != 64 {
		t.Fatalf("signature must be a 64-char lowercase hex digest, got len %d", len(got))
	}
}

func TestSignedRequestShape(t *testing.T) {
	b, rec := newTestBinance(t, execution.MarketSpot, func(*http.Request) (*http.Response, error) {
		return jsonResp(200, `{"symbol":"BTCUSDT","orderId":42,"clientOrderId":"cid-1","side":"BUY","type":"LIMIT","price":"100.00","origQty":"0.5","executedQty":"0.0","status":"NEW","time":1,"updateTime":2}`), nil
	})
	if _, err := b.GetOrder(context.Background(), "BTC/USDT", "42"); err != nil {
		t.Fatalf("GetOrder: %v", err)
	}
	if len(rec.reqs) != 1 {
		t.Fatalf("expected 1 request, got %d", len(rec.reqs))
	}
	req := rec.reqs[0]

	// Header carries the KEY, never the secret.
	if got := req.Header.Get("X-MBX-APIKEY"); got != "testkey" {
		t.Fatalf("X-MBX-APIKEY = %q, want testkey", got)
	}

	// Query: params as the builder emits them, signature appended LAST and
	// byte-exact over the emitted query minus the signature parameter.
	raw := req.URL.RawQuery
	idx := strings.LastIndex(raw, "&signature=")
	if idx < 0 {
		t.Fatalf("signature parameter missing or not last: %q", raw)
	}
	signedPart := raw[:idx]
	sig := raw[idx+len("&signature="):]
	if want := SignQuery(signedPart, "testsecret"); sig != want {
		t.Fatalf("signature = %q, want %q (signed %q)", sig, want, signedPart)
	}
	wantQuery := "symbol=BTCUSDT&orderId=42&timestamp=1700000000000&recvWindow=5000"
	if signedPart != wantQuery {
		t.Fatalf("signed query = %q, want %q", signedPart, wantQuery)
	}

	// The secret must appear nowhere in the request except as the HMAC input.
	var all strings.Builder
	all.WriteString(req.URL.String())
	for k, vs := range req.Header {
		all.WriteString(k)
		for _, v := range vs {
			all.WriteString(v)
		}
	}
	if strings.Contains(all.String(), "testsecret") {
		t.Fatalf("secret leaked into request: %q", all.String())
	}
}

func TestPublicTickerIsUnsigned(t *testing.T) {
	b, rec := newTestBinance(t, execution.MarketSpot, func(*http.Request) (*http.Response, error) {
		return jsonResp(200, `{"symbol":"BTCUSDT","bidPrice":"60000.1","askPrice":"60000.2"}`), nil
	})
	tick, err := b.GetTicker(context.Background(), "BTC/USDT")
	if err != nil {
		t.Fatalf("GetTicker: %v", err)
	}
	req := rec.reqs[0]
	if req.URL.Path != "/api/v3/ticker/bookTicker" {
		t.Fatalf("path = %q", req.URL.Path)
	}
	if req.URL.Query().Has("signature") || req.URL.Query().Has("timestamp") {
		t.Fatalf("public ticker must not be signed, got query %q", req.URL.RawQuery)
	}
	if got := req.Header.Get("X-MBX-APIKEY"); got != "" {
		t.Fatalf("public ticker must not send the key header, got %q", got)
	}
	// Honest nulls: book ticker has no last; empty wire prices are nil.
	if tick.Last != nil {
		t.Fatalf("Last must be nil for bookTicker, got %v", *tick.Last)
	}
	if tick.Bid == nil || *tick.Bid != "60000.1" || tick.Ask == nil || *tick.Ask != "60000.2" {
		t.Fatalf("Bid/Ask not preserved verbatim: %+v", tick)
	}
	if tick.Ts != 1700000000000 {
		t.Fatalf("Ts = %d, want fixed clock 1700000000000", tick.Ts)
	}
	if tick.Symbol != "BTC/USDT" {
		t.Fatalf("Symbol = %q, want canonical BTC/USDT", tick.Symbol)
	}
}

func TestTickerEmptyPriceIsNull(t *testing.T) {
	b, _ := newTestBinance(t, execution.MarketSpot, func(*http.Request) (*http.Response, error) {
		return jsonResp(200, `{"symbol":"BTCUSDT","bidPrice":"","askPrice":"60000.2"}`), nil
	})
	tick, err := b.GetTicker(context.Background(), "BTC/USDT")
	if err != nil {
		t.Fatalf("GetTicker: %v", err)
	}
	if tick.Bid != nil {
		t.Fatalf("empty bidPrice must map to nil, got %v", *tick.Bid)
	}
	if tick.Ask == nil {
		t.Fatalf("askPrice must be preserved")
	}
}

func TestOrderStatusMappingTable(t *testing.T) {
	cases := []struct {
		wire string
		want execution.ChildOrderStatus
	}{
		{"NEW", execution.ChildOpen},
		{"open", execution.ChildOpen},
		{"PARTIALLY_FILLED", execution.ChildPartial},
		{"FILLED", execution.ChildFilled},
		{"closed", execution.ChildFilled},
		{"CANCELED", execution.ChildCancelled},
		{"canceled", execution.ChildCancelled},
		{"cancelled", execution.ChildCancelled},
		{"REJECTED", execution.ChildRejected},
		{"rejected", execution.ChildRejected},
		{"EXPIRED", execution.ChildExpired},
		{"expired", execution.ChildExpired},
		{"PENDING_NEW", execution.ChildUnknown},
		{"", execution.ChildUnknown},
		{"filled ", execution.ChildUnknown},
	}
	for _, tc := range cases {
		t.Run(tc.wire, func(t *testing.T) {
			if got := mapOrderStatus(tc.wire); got != tc.want {
				t.Fatalf("mapOrderStatus(%q) = %q, want %q", tc.wire, got, tc.want)
			}
		})
	}
}

func TestErrorClassificationFromFixtures(t *testing.T) {
	cases := []struct {
		name     string
		status   int
		body     string
		wantCat  execution.ErrorCategory
		wantCode string
	}{
		{
			name:     "rate limit -1003 on 429",
			status:   429,
			body:     `{"code":-1003,"msg":"Too many requests."}`,
			wantCat:  execution.ErrRateLimited,
			wantCode: "-1003",
		},
		{
			name:     "insufficient balance -2010",
			status:   400,
			body:     `{"code":-2010,"msg":"Account has insufficient balance."}`,
			wantCat:  execution.ErrInsufficientBalance,
			wantCode: "-2010",
		},
		{
			name:     "invalid key -2015",
			status:   403,
			body:     `{"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}`,
			wantCat:  execution.ErrPermissionError,
			wantCode: "-2015",
		},
		{
			name:     "unknown order -2013",
			status:   400,
			body:     `{"code":-2013,"msg":"Order does not exist."}`,
			wantCat:  execution.ErrInvalidOrder,
			wantCode: "-2013",
		},
		{
			name:    "non-JSON 5xx body",
			status:  500,
			body:    `upstream unavailable`,
			wantCat: execution.ErrNetworkRetryable,
		},
		{
			name:    "418 DDoS protection without envelope",
			status:  418,
			body:    `{`,
			wantCat: execution.ErrExchangeOverload,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b, _ := newTestBinance(t, execution.MarketSpot, func(*http.Request) (*http.Response, error) {
				return jsonResp(tc.status, tc.body), nil
			})
			_, err := b.GetOrder(context.Background(), "BTC/USDT", "42")
			if err == nil {
				t.Fatal("expected error")
			}
			ve := &exchanges.VenueError{}
			if !errors.As(err, &ve) {
				t.Fatalf("error is not a *exchanges.VenueError: %T", err)
			}
			if ve.Class.Category != tc.wantCat {
				t.Fatalf("category = %q, want %q", ve.Class.Category, tc.wantCat)
			}
			if ve.Code != tc.wantCode {
				t.Fatalf("code = %q, want %q", ve.Code, tc.wantCode)
			}
			if ve.HTTPStatus != tc.status {
				t.Fatalf("HTTPStatus = %d, want %d", ve.HTTPStatus, tc.status)
			}
			if strings.Contains(err.Error(), "testsecret") || strings.Contains(err.Error(), tc.body) {
				t.Fatalf("error leaked raw body/secret: %q", err.Error())
			}
		})
	}
}

func TestTransportErrorIsNetworkRetryable(t *testing.T) {
	b, _ := newTestBinance(t, execution.MarketSpot, func(*http.Request) (*http.Response, error) {
		return nil, errors.New("dial tcp: connection refused")
	})
	_, err := b.GetTicker(context.Background(), "BTC/USDT")
	if err == nil {
		t.Fatal("expected error")
	}
	class := exchanges.Classify(err)
	if class.Category != execution.ErrNetworkRetryable || !class.Retryable {
		t.Fatalf("transport failure classification = %+v, want retryable network_retryable", class)
	}
	if strings.Contains(err.Error(), "testsecret") {
		t.Fatalf("secret leaked into error: %q", err.Error())
	}
}

func TestGetAccountProbe(t *testing.T) {
	t.Run("success grants read and static binance permissions", func(t *testing.T) {
		b, rec := newTestBinance(t, execution.MarketSpot, func(*http.Request) (*http.Response, error) {
			return jsonResp(200, `{"makerCommission":10,"balances":[]}`), nil
		})
		meta, err := b.GetAccount(context.Background())
		if err != nil {
			t.Fatalf("GetAccount: %v", err)
		}
		if rec.reqs[0].URL.Path != "/api/v3/account" {
			t.Fatalf("path = %q", rec.reqs[0].URL.Path)
		}
		if !meta.Permissions.Read {
			t.Fatal("Read must be true after a successful signed read (PRD §46)")
		}
		if meta.Permissions.SpotTrade == nil || !*meta.Permissions.SpotTrade {
			t.Fatal("SpotTrade must be true per exchange.ts binance mapping")
		}
		if meta.Permissions.FuturesTrade == nil || !*meta.Permissions.FuturesTrade {
			t.Fatal("FuturesTrade must be true per exchange.ts binance mapping")
		}
		if meta.Permissions.Withdraw == nil || *meta.Permissions.Withdraw {
			t.Fatal("Withdraw must be false (FUDCourt never requests withdrawal, PRD §43)")
		}
		if meta.Health != execution.HealthActive {
			t.Fatalf("Health = %q, want ACTIVE", meta.Health)
		}
		if meta.Exchange != execution.ExchangeBinance {
			t.Fatalf("Exchange = %q", meta.Exchange)
		}
		if meta.APIKeyMasked == nil || *meta.APIKeyMasked != "***" {
			t.Fatalf("APIKeyMasked = %v, want \"***\" for a short key", meta.APIKeyMasked)
		}
	})

	t.Run("masked key for long key", func(t *testing.T) {
		rec := &recordingClient{respond: func(*http.Request) (*http.Response, error) {
			return jsonResp(200, `{}`), nil
		}}
		b, err := New(Config{
			Credentials: exchanges.Credentials{APIKey: "testkey12345678", APISecret: "testsecret"},
			HTTP:        rec,
			Clock:       exchanges.FixedClock{Millis: 1},
			MarketType:  execution.MarketSpot,
		})
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		meta, err := b.GetAccount(context.Background())
		if err != nil {
			t.Fatalf("GetAccount: %v", err)
		}
		if meta.APIKeyMasked == nil || *meta.APIKeyMasked != "tes...678" {
			t.Fatalf("APIKeyMasked = %v, want tes...678", meta.APIKeyMasked)
		}
	})

	t.Run("auth-class failure maps health via CredentialHealthForValidation", func(t *testing.T) {
		b, _ := newTestBinance(t, execution.MarketSpot, func(*http.Request) (*http.Response, error) {
			return jsonResp(403, `{"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}`), nil
		})
		meta, err := b.GetAccount(context.Background())
		if err == nil {
			t.Fatal("expected probe error")
		}
		if meta.Health != execution.HealthPermissionError {
			t.Fatalf("Health = %q, want PERMISSION_ERROR", meta.Health)
		}
	})

	t.Run("rate-limited probe maps to RATE_LIMITED", func(t *testing.T) {
		b, _ := newTestBinance(t, execution.MarketSpot, func(*http.Request) (*http.Response, error) {
			return jsonResp(429, `{"code":-1003,"msg":"Too many requests."}`), nil
		})
		meta, err := b.GetAccount(context.Background())
		if err == nil {
			t.Fatal("expected probe error")
		}
		if meta.Health != execution.HealthRateLimited {
			t.Fatalf("Health = %q, want RATE_LIMITED", meta.Health)
		}
	})
}

func TestGetBalanceParsing(t *testing.T) {
	body := `{"balances":[
		{"asset":"BTC","free":"0.10000000","locked":"1.50000000"},
		{"asset":"USDT","free":"100.25","locked":"0.75"}
	]}`
	t.Run("spot equity", func(t *testing.T) {
		b, rec := newTestBinance(t, execution.MarketSpot, func(*http.Request) (*http.Response, error) {
			return jsonResp(200, body), nil
		})
		eq, err := b.GetBalance(context.Background())
		if err != nil {
			t.Fatalf("GetBalance: %v", err)
		}
		if rec.reqs[0].URL.Path != "/api/v3/account" {
			t.Fatalf("path = %q", rec.reqs[0].URL.Path)
		}
		if !rec.reqs[0].URL.Query().Has("signature") {
			t.Fatal("balance read must be signed")
		}
		// Decimal strings preserved VERBATIM in rows; totals via decimal.Add.
		wantRows := []execution.Balance{
			{Asset: "BTC", Free: "0.10000000", Used: "1.50000000", Total: "1.6"},
			{Asset: "USDT", Free: "100.25", Used: "0.75", Total: "101"},
		}
		if len(eq.Balances) != len(wantRows) {
			t.Fatalf("rows = %d, want %d", len(eq.Balances), len(wantRows))
		}
		for i, want := range wantRows {
			if eq.Balances[i] != want {
				t.Fatalf("row %d = %+v, want %+v", i, eq.Balances[i], want)
			}
		}
		if eq.SpotEquity == nil || *eq.SpotEquity != "102.6" {
			t.Fatalf("SpotEquity = %v, want 102.6", eq.SpotEquity)
		}
		if eq.FuturesEquity != nil {
			t.Fatalf("FuturesEquity must be nil for spot, got %v", *eq.FuturesEquity)
		}
		if eq.TotalEquity == nil || *eq.TotalEquity != "102.6" {
			t.Fatalf("TotalEquity = %v, want 102.6", eq.TotalEquity)
		}
		if eq.Timestamp != 1700000000000 {
			t.Fatalf("Timestamp = %d, want fixed clock", eq.Timestamp)
		}
	})

	t.Run("linear_perp equity with empty rows is honest null", func(t *testing.T) {
		b, _ := newTestBinance(t, execution.MarketLinearPerp, func(*http.Request) (*http.Response, error) {
			return jsonResp(200, `{"balances":[]}`), nil
		})
		eq, err := b.GetBalance(context.Background())
		if err != nil {
			t.Fatalf("GetBalance: %v", err)
		}
		if eq.SpotEquity != nil {
			t.Fatal("SpotEquity must be nil for linear_perp")
		}
		if eq.FuturesEquity != nil || eq.TotalEquity != nil {
			t.Fatal("empty balance list must yield nil equity (never 0)")
		}
	})
}

func TestGetFillsParsing(t *testing.T) {
	body := `[{
		"id": 8765432,
		"orderId": 123456,
		"price": "0.00100000",
		"qty": "100.00000000",
		"quoteQty": "0.10000000",
		"commission": "0.00001000",
		"commissionAsset": "BNB",
		"time": 1700000000500,
		"isBuyer": true,
		"isMaker": false
	}]`
	b, rec := newTestBinance(t, execution.MarketSpot, func(*http.Request) (*http.Response, error) {
		return jsonResp(200, body), nil
	})
	fills, err := b.GetFills(context.Background(), "BTC/USDT")
	if err != nil {
		t.Fatalf("GetFills: %v", err)
	}
	req := rec.reqs[0]
	if req.URL.Path != "/api/v3/myTrades" {
		t.Fatalf("path = %q", req.URL.Path)
	}
	if got := req.URL.Query().Get("symbol"); got != "BTCUSDT" {
		t.Fatalf("symbol = %q, want BTCUSDT", got)
	}
	if len(fills) != 1 {
		t.Fatalf("fills = %d, want 1", len(fills))
	}
	want := execution.Fill{
		ExchangeTradeID: "8765432",
		ClientOrderID:   "", // classic myTrades rows carry none — honest empty
		Price:           "0.00100000",
		Quantity:        "100.00000000",
		QuoteQuantity:   "0.10000000",
		Fee:             "0.00001000",
		FeeAsset:        "BNB",
		Timestamp:       1700000000500,
	}
	if fills[0] != want {
		t.Fatalf("fill = %+v\nwant %+v", fills[0], want)
	}
}

func TestCreateOrderRequestAndParsing(t *testing.T) {
	body := `{
		"symbol":"BTCUSDT","orderId":123456,"clientOrderId":"cid-1",
		"transactTime":1700000000000,"price":"100.00","origQty":"0.50000000",
		"executedQty":"0.10000000","cummulativeQuoteQty":"10.0","status":"PARTIALLY_FILLED",
		"timeInForce":"GTC","type":"LIMIT","side":"BUY","workingTime":1700000000000
	}`
	b, rec := newTestBinance(t, execution.MarketSpot, func(*http.Request) (*http.Response, error) {
		return jsonResp(200, body), nil
	})
	req := execution.OrderRequest{
		ClientOrderID: "cid-1",
		Symbol:        "BTC/USDT",
		Side:          execution.SideBuy,
		Quantity:      "0.50000000",
		Price:         "100.00",
		OrderType:     "limit",
		TimeInForce:   execution.TIFGTC,
		ReduceOnly:    true,
		Intent:        execution.IntentClose,
		ExecutionID:   "exec-1",
	}
	order, err := b.CreateOrder(context.Background(), req)
	if err != nil {
		t.Fatalf("CreateOrder: %v", err)
	}
	httpReq := rec.reqs[0]
	if httpReq.Method != http.MethodPost || httpReq.URL.Path != "/api/v3/order" {
		t.Fatalf("request = %s %s", httpReq.Method, httpReq.URL.Path)
	}
	q := httpReq.URL.Query()
	for k, want := range map[string]string{
		"symbol": "BTCUSDT", "side": "BUY", "type": "LIMIT",
		"quantity": "0.50000000", "price": "100.00", "timeInForce": "GTC",
		"newClientOrderId": "cid-1", "newOrderRespType": "RESULT",
		"timestamp": "1700000000000", "recvWindow": "5000",
	} {
		if got := q.Get(k); got != want {
			t.Fatalf("param %s = %q, want %q", k, got, want)
		}
	}
	if q.Has("reduceOnly") {
		t.Fatal("the structural spot form sends no reduceOnly parameter")
	}
	if !strings.HasSuffix(httpReq.URL.RawQuery, "&signature="+SignQuery("symbol=BTCUSDT&side=BUY&type=LIMIT&quantity=0.50000000&price=100.00&timeInForce=GTC&newClientOrderId=cid-1&newOrderRespType=RESULT&timestamp=1700000000000&recvWindow=5000", "testsecret")) {
		t.Fatalf("signature not last or not byte-exact over emitted query: %q", httpReq.URL.RawQuery)
	}

	// Parsing: canonical types with verbatim decimal strings.
	if order.ExchangeOrderID != "123456" || order.ClientOrderID != "cid-1" {
		t.Fatalf("ids = %+v", order)
	}
	if order.Symbol != "BTC/USDT" {
		t.Fatalf("Symbol = %q, want BTC/USDT (mapped back from wire echo)", order.Symbol)
	}
	if order.Side != execution.SideBuy || order.Type != "limit" {
		t.Fatalf("side/type = %q/%q", order.Side, order.Type)
	}
	if order.Price == nil || *order.Price != "100.00" {
		t.Fatalf("Price = %v, want verbatim 100.00", order.Price)
	}
	if order.Quantity != "0.50000000" || order.FilledQuantity != "0.10000000" {
		t.Fatalf("qty = %q/%q, want verbatim wire strings", order.Quantity, order.FilledQuantity)
	}
	if order.Status != execution.ChildPartial {
		t.Fatalf("Status = %q, want PARTIAL", order.Status)
	}
	if !order.IsExit {
		t.Fatal("IsExit must follow ReduceOnly/Intent=close on the create path")
	}
	if order.SubmittedAt != 1700000000000 || order.UpdatedAt != 1700000000000 {
		t.Fatalf("timestamps = %d/%d", order.SubmittedAt, order.UpdatedAt)
	}
}

func TestGetOrderParsing(t *testing.T) {
	body := `{
		"symbol":"BTCUSDT","orderId":77,"clientOrderId":"cid-2","price":"0",
		"origQty":"0.25000000","executedQty":"0.25000000","status":"FILLED",
		"timeInForce":"GTC","type":"MARKET","side":"SELL","time":100,"updateTime":200
	}`
	b, _ := newTestBinance(t, execution.MarketSpot, func(*http.Request) (*http.Response, error) {
		return jsonResp(200, body), nil
	})
	order, err := b.GetOrder(context.Background(), "BTC/USDT", "77")
	if err != nil {
		t.Fatalf("GetOrder: %v", err)
	}
	if order.Status != execution.ChildFilled {
		t.Fatalf("Status = %q, want FILLED", order.Status)
	}
	if order.Type != "market" {
		t.Fatalf("Type = %q, want market", order.Type)
	}
	if order.Price != nil {
		t.Fatalf("market order price 0 must map to nil, got %v", *order.Price)
	}
	if order.Quantity != "0.25000000" || order.FilledQuantity != "0.25000000" {
		t.Fatalf("quantities not verbatim: %+v", order)
	}
	if order.IsExit {
		t.Fatal("IsExit must be false without a create-path request")
	}
	if order.SubmittedAt != 100 || order.UpdatedAt != 200 {
		t.Fatalf("timestamps = %d/%d", order.SubmittedAt, order.UpdatedAt)
	}
}

func TestGetOpenOrdersList(t *testing.T) {
	body := `[
		{"symbol":"BTCUSDT","orderId":1,"clientOrderId":"a","price":"1","origQty":"1","executedQty":"0","status":"NEW","type":"LIMIT","side":"BUY","time":1,"updateTime":1},
		{"symbol":"BTCUSDT","orderId":2,"clientOrderId":"b","price":"2","origQty":"1","executedQty":"0","status":"EXPIRED","type":"LIMIT","side":"SELL","time":2,"updateTime":2}
	]`
	b, rec := newTestBinance(t, execution.MarketSpot, func(*http.Request) (*http.Response, error) {
		return jsonResp(200, body), nil
	})
	orders, err := b.GetOpenOrders(context.Background(), "BTC/USDT")
	if err != nil {
		t.Fatalf("GetOpenOrders: %v", err)
	}
	if got := rec.reqs[0].URL.Query().Get("symbol"); got != "BTCUSDT" {
		t.Fatalf("symbol = %q", got)
	}
	if len(orders) != 2 || orders[0].Status != execution.ChildOpen || orders[1].Status != execution.ChildExpired {
		t.Fatalf("orders = %+v", orders)
	}
}

func TestGetPositionUSDMargin(t *testing.T) {
	t.Run("spot always refuses with ErrNoPosition", func(t *testing.T) {
		b, rec := newTestBinance(t, execution.MarketSpot, func(*http.Request) (*http.Response, error) {
			t.Fatal("spot must issue no request")
			return nil, nil
		})
		_, err := b.GetPosition(context.Background(), "BTC/USDT")
		if !errors.Is(err, exchanges.ErrNoPosition) {
			t.Fatalf("err = %v, want ErrNoPosition", err)
		}
		if len(rec.reqs) != 0 {
			t.Fatal("spot GetPosition must not call the venue")
		}
	})

	t.Run("signed short position", func(t *testing.T) {
		body := `[{"symbol":"BTCUSDT","positionAmt":"-2.5","entryPrice":"100.5","markPrice":"101","unRealizedProfit":"-1.25","liquidationPrice":"250.0","leverage":"5","marginType":"cross","positionSide":"BOTH"}]`
		b, rec := newTestBinance(t, execution.MarketLinearPerp, func(*http.Request) (*http.Response, error) {
			return jsonResp(200, body), nil
		})
		pos, err := b.GetPosition(context.Background(), "BTC/USDT")
		if err != nil {
			t.Fatalf("GetPosition: %v", err)
		}
		req := rec.reqs[0]
		if req.URL.Path != "/fapi/v2/positionRisk" {
			t.Fatalf("path = %q", req.URL.Path)
		}
		if got := req.URL.Query().Get("symbol"); got != "BTCUSDT" {
			t.Fatalf("symbol = %q", got)
		}
		if pos.Side != execution.SideSell || pos.Quantity != "-2.5" {
			t.Fatalf("position = %+v, want sell -2.5 (wire sign preserved)", pos)
		}
		if pos.EntryPrice != "100.5" || pos.LiquidationPrice == nil || *pos.LiquidationPrice != "250.0" {
			t.Fatalf("prices = %+v", pos)
		}
		if pos.Leverage == nil || *pos.Leverage != "5" {
			t.Fatalf("Leverage = %v", pos.Leverage)
		}
		if pos.MarginMode == nil || *pos.MarginMode != execution.MarginCross {
			t.Fatalf("MarginMode = %v", pos.MarginMode)
		}
		if pos.PositionSide != "net" {
			t.Fatalf("PositionSide = %q, want net (BOTH = one-way)", pos.PositionSide)
		}
		if pos.MarketType != execution.MarketLinearPerp {
			t.Fatalf("MarketType = %q", pos.MarketType)
		}
	})

	t.Run("flat or absent refuses with ErrNoPosition", func(t *testing.T) {
		b, _ := newTestBinance(t, execution.MarketLinearPerp, func(*http.Request) (*http.Response, error) {
			return jsonResp(200, `[{"symbol":"BTCUSDT","positionAmt":"0.000","entryPrice":"0"}]`), nil
		})
		if _, err := b.GetPosition(context.Background(), "BTC/USDT"); !errors.Is(err, exchanges.ErrNoPosition) {
			t.Fatalf("err = %v, want ErrNoPosition", err)
		}
	})
}

func TestInvalidInputRefusals(t *testing.T) {
	b, rec := newTestBinance(t, execution.MarketSpot, func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid input must be refused before any request")
		return nil, nil
	})
	base := execution.OrderRequest{
		ClientOrderID: "cid-1", Symbol: "BTC/USDT", Side: execution.SideBuy,
		Quantity: "0.5", OrderType: "limit", Price: "100.0", TimeInForce: execution.TIFGTC,
	}
	cases := []struct {
		name    string
		call    func() error
		wantErr error
	}{
		{
			name: "empty symbol on create",
			call: func() error {
				r := base
				r.Symbol = ""
				_, err := b.CreateOrder(context.Background(), r)
				return err
			},
			wantErr: exchanges.ErrInvalidSymbol,
		},
		{
			name: "non-canonical symbol on create",
			call: func() error {
				r := base
				r.Symbol = "BTCUSDT"
				_, err := b.CreateOrder(context.Background(), r)
				return err
			},
			wantErr: exchanges.ErrInvalidSymbol,
		},
		{
			name: "unknown quote refused",
			call: func() error {
				r := base
				r.Symbol = "BTC/XYZ"
				_, err := b.CreateOrder(context.Background(), r)
				return err
			},
			wantErr: exchanges.ErrUnknownQuote,
		},
		{
			name: "bad quantity",
			call: func() error {
				r := base
				r.Quantity = "abc"
				_, err := b.CreateOrder(context.Background(), r)
				return err
			},
			wantErr: exchanges.ErrInvalidOrder,
		},
		{
			name: "zero quantity",
			call: func() error {
				r := base
				r.Quantity = "0"
				_, err := b.CreateOrder(context.Background(), r)
				return err
			},
			wantErr: exchanges.ErrInvalidOrder,
		},
		{
			name: "limit without price",
			call: func() error {
				r := base
				r.Price = ""
				_, err := b.CreateOrder(context.Background(), r)
				return err
			},
			wantErr: exchanges.ErrInvalidOrder,
		},
		{
			name: "market with price",
			call: func() error {
				r := base
				r.OrderType = "market"
				_, err := b.CreateOrder(context.Background(), r)
				return err
			},
			wantErr: exchanges.ErrInvalidOrder,
		},
		{
			name: "unknown order type",
			call: func() error {
				r := base
				r.OrderType = "stop_limit"
				_, err := b.CreateOrder(context.Background(), r)
				return err
			},
			wantErr: exchanges.ErrInvalidOrder,
		},
		{
			name: "bad time in force",
			call: func() error {
				r := base
				r.TimeInForce = "GTD"
				_, err := b.CreateOrder(context.Background(), r)
				return err
			},
			wantErr: exchanges.ErrInvalidOrder,
		},
		{
			name: "empty order id on get",
			call: func() error {
				_, err := b.GetOrder(context.Background(), "BTC/USDT", "")
				return err
			},
			wantErr: ErrMissingOrderID,
		},
		{
			name: "empty symbol on ticker",
			call: func() error {
				_, err := b.GetTicker(context.Background(), "")
				return err
			},
			wantErr: exchanges.ErrInvalidSymbol,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.call(); !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
		})
	}
	if len(rec.reqs) != 0 {
		t.Fatalf("invalid input must never reach the transport, got %d requests", len(rec.reqs))
	}
}

func TestSymbolMappingAcrossCalls(t *testing.T) {
	// Both directions with fixture echoes: canonical → wire in the request,
	// wire → canonical in every parsed response.
	cases := []struct {
		name    string
		symbol  string
		wire    string
		body    string
		call    func(*Binance, string) (string, error)
		wantSym string
	}{
		{
			name:   "create order echo",
			symbol: "BTC/USDT",
			wire:   "BTCUSDT",
			body:   `{"symbol":"BTCUSDT","orderId":1,"clientOrderId":"c","price":"1","origQty":"1","executedQty":"0","status":"NEW","type":"LIMIT","side":"BUY","time":1,"updateTime":1}`,
			call: func(b *Binance, s string) (string, error) {
				o, err := b.CreateOrder(context.Background(), execution.OrderRequest{
					ClientOrderID: "c", Symbol: s, Side: execution.SideBuy,
					Quantity: "1", OrderType: "limit", Price: "1", TimeInForce: execution.TIFGTC,
				})
				return o.Symbol, err
			},
			wantSym: "BTC/USDT",
		},
		{
			name:   "get order echo",
			symbol: "ETH/USDT",
			wire:   "ETHUSDT",
			body:   `{"symbol":"ETHUSDT","orderId":1,"clientOrderId":"c","price":"1","origQty":"1","executedQty":"0","status":"NEW","type":"LIMIT","side":"BUY","time":1,"updateTime":1}`,
			call: func(b *Binance, s string) (string, error) {
				o, err := b.GetOrder(context.Background(), s, "1")
				return o.Symbol, err
			},
			wantSym: "ETH/USDT",
		},
		{
			name:   "ticker echo",
			symbol: "BTC/USDC",
			wire:   "BTCUSDC",
			body:   `{"symbol":"BTCUSDC","bidPrice":"1","askPrice":"2"}`,
			call: func(b *Binance, s string) (string, error) {
				o, err := b.GetTicker(context.Background(), s)
				return o.Symbol, err
			},
			wantSym: "BTC/USDC",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b, rec := newTestBinance(t, execution.MarketSpot, func(*http.Request) (*http.Response, error) {
				return jsonResp(200, tc.body), nil
			})
			gotSym, err := tc.call(b, tc.symbol)
			if err != nil {
				t.Fatalf("call: %v", err)
			}
			if gotSym != tc.wantSym {
				t.Fatalf("symbol = %q, want %q", gotSym, tc.wantSym)
			}
			if got := rec.reqs[0].URL.Query().Get("symbol"); got != tc.wire {
				t.Fatalf("wire symbol = %q, want %q", got, tc.wire)
			}
		})
	}
}

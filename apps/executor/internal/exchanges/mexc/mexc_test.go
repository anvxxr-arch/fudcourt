package mexc

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges"
)

// The tests below are table-driven and run entirely against fixture
// responses through a stub exchanges.HTTPClient — NO network, ever. Signing is
// pinned with exchanges.FixedClock + fixed credentials so every HMAC vector is
// deterministic.

const (
	fixedMillis = int64(1700000000000)
	testAPIKey  = "apiKey123456"
	testSecret  = "s3cr3t"
	// goldenSign is Sign(testSecret, testAPIKey, "1700000000000") — the
	// byte-exact header-variant signature (independently verified in
	// TestSignMatchesGoldenVectors against crypto/hmac).
	goldenSign = "00a4ddcdeec0fc44f381e13b8e493aa27784f9183ae14b6b351e2fa2aafbf895"
)

// capturedRequest is one request observed by the stub client.
type capturedRequest struct {
	Method string
	URL    *url.URL
	Header http.Header
	Body   string
}

// stubClient is a no-network exchanges.HTTPClient: it records every request
// and answers with one prepared fixture response (or error).
type stubClient struct {
	reqs []capturedRequest
	resp *http.Response
	err  error
}

// Do implements exchanges.HTTPClient.
func (s *stubClient) Do(req *http.Request) (*http.Response, error) {
	var body string
	if req.Body != nil {
		b, _ := io.ReadAll(req.Body)
		body = string(b)
	}
	s.reqs = append(s.reqs, capturedRequest{Method: req.Method, URL: req.URL, Header: req.Header.Clone(), Body: body})
	return s.resp, s.err
}

// fixture builds a fixture HTTP response body.
func fixture(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body))}
}

// newStub builds a stub answering one fixture.
func newStub(status int, body string) *stubClient {
	return &stubClient{resp: fixture(status, body)}
}

// newTestMEXC builds an adapter with pinned credentials and clock.
func newTestMEXC(t *testing.T, market execution.MarketType, stub exchanges.HTTPClient) *MEXC {
	t.Helper()
	m, err := New(Config{
		Credentials: exchanges.Credentials{APIKey: testAPIKey, APISecret: testSecret},
		HTTP:        stub,
		Clock:       exchanges.FixedClock{Millis: fixedMillis},
		MarketType:  market,
	})
	if err != nil {
		t.Fatalf("New: unexpected error %v", err)
	}
	return m
}

func TestNewRefusesInvalidConfig(t *testing.T) {
	valid := Config{
		Credentials: exchanges.Credentials{APIKey: testAPIKey, APISecret: testSecret},
		HTTP:        &stubClient{},
		MarketType:  execution.MarketSpot,
	}
	cases := []struct {
		name    string
		mutate  func(*Config)
		wantErr error
	}{
		{"empty api key", func(c *Config) { c.Credentials.APIKey = "" }, ErrMissingCredentials},
		{"empty secret", func(c *Config) { c.Credentials.APISecret = "" }, ErrMissingCredentials},
		{"nil http", func(c *Config) { c.HTTP = nil }, ErrMissingHTTPClient},
		{"empty market type", func(c *Config) { c.MarketType = "" }, ErrInvalidMarketType},
		{"unknown market type", func(c *Config) { c.MarketType = "options" }, ErrInvalidMarketType},
		{"base url without host", func(c *Config) { c.BaseURL = "http://" }, ErrInvalidBaseURL},
		{"base url wrong scheme", func(c *Config) { c.BaseURL = "ftp://api.mexc.com" }, ErrInvalidBaseURL},
		{"base url unparsable", func(c *Config) { c.BaseURL = "http://%zz" }, ErrInvalidBaseURL},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := valid
			tc.mutate(&cfg)
			m, err := New(cfg)
			if m != nil {
				t.Fatalf("New: adapter returned for refused config")
			}
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("New: got err %v, want %v", err, tc.wantErr)
			}
		})
	}
}

func TestNewAppliesDefaults(t *testing.T) {
	m, err := New(Config{
		Credentials: exchanges.Credentials{APIKey: testAPIKey, APISecret: testSecret},
		HTTP:        &stubClient{},
		MarketType:  execution.MarketLinearPerp,
		BaseURL:     "https://contract.mexc.com/",
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if m.base != "https://contract.mexc.com" {
		t.Fatalf("BaseURL trailing slash not trimmed: %q", m.base)
	}
	if m.clock == nil {
		t.Fatalf("nil Clock did not default to SystemClock")
	}
	m2, err := New(Config{
		Credentials: exchanges.Credentials{APIKey: testAPIKey, APISecret: testSecret},
		HTTP:        &stubClient{},
		MarketType:  execution.MarketSpot,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if m2.base != DefaultBaseURL {
		t.Fatalf("empty BaseURL: got %q, want %q", m2.base, DefaultBaseURL)
	}
}

// TestSignMatchesGoldenVectors pins Sign() byte-exact against golden hex
// vectors AND against an independent crypto/hmac computation of the
// documented payload apiKey+timestampMs.
func TestSignMatchesGoldenVectors(t *testing.T) {
	cases := []struct {
		name      string
		secret    string
		apiKey    string
		timestamp string
		want      string
	}{
		{"fixed credentials", testSecret, testAPIKey, "1700000000000", goldenSign},
		{"second vector", "secret", "key", "1700000000000", "0eb15ed09c26d51b65c3de4a2c219450f5835924b266e2fe34bb0249b2be2309"},
		{"empty timestamp pins the concat contract (no separator, no clock fallback)", testSecret, testAPIKey, "", "ca761f987d37b7eb91b76ff39cab46273b20118f3dc68dee26b64f0d7f262882"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Independent computation of the documented variant.
			mac := hmac.New(sha256.New, []byte(tc.secret))
			mac.Write([]byte(tc.apiKey + tc.timestamp))
			independent := hex.EncodeToString(mac.Sum(nil))
			if independent != tc.want {
				t.Fatalf("golden literal drifted: independent hmac gives %s, literal is %s", independent, tc.want)
			}
			got := Sign(tc.secret, tc.apiKey, tc.timestamp)
			if got != tc.want {
				t.Fatalf("Sign: got %s, want %s", got, tc.want)
			}
			// Deterministic: same inputs, same bytes.
			if again := Sign(tc.secret, tc.apiKey, tc.timestamp); again != got {
				t.Fatalf("Sign not deterministic: %s vs %s", again, got)
			}
		})
	}
}

func TestSignedRequestHeaders(t *testing.T) {
	t.Run("signed call carries the header-variant signature", func(t *testing.T) {
		stub := newStub(200, `{"balances":[]}`)
		m := newTestMEXC(t, execution.MarketSpot, stub)
		if _, err := m.GetBalance(context.Background()); err != nil {
			t.Fatalf("GetBalance: %v", err)
		}
		if len(stub.reqs) != 1 {
			t.Fatalf("want 1 request, got %d", len(stub.reqs))
		}
		req := stub.reqs[0]
		if req.Method != http.MethodGet || req.URL.Path != "/api/v3/account" {
			t.Fatalf("unexpected request: %s %s", req.Method, req.URL.Path)
		}
		if got := req.Header.Get("X-MEXC-APIKEY"); got != testAPIKey {
			t.Errorf("X-MEXC-APIKEY: got %q, want %q", got, testAPIKey)
		}
		if got := req.Header.Get("X-MEXC-TIMESTAMP"); got != "1700000000000" {
			t.Errorf("X-MEXC-TIMESTAMP: got %q, want %q", got, "1700000000000")
		}
		if got := req.Header.Get("X-MEXC-SIGNATURE"); got != goldenSign {
			t.Errorf("X-MEXC-SIGNATURE: got %q, want %q", got, goldenSign)
		}
		// Secret material lives only in headers — never in the query string.
		if q := req.URL.RawQuery; strings.Contains(q, testSecret) || strings.Contains(q, goldenSign) || strings.Contains(q, testAPIKey) {
			t.Errorf("query leaks credential material: %q", q)
		}
	})
	t.Run("public call sends no signature headers", func(t *testing.T) {
		stub := newStub(200, `{"symbol":"BTC_USDT","lastPrice":"1"}`)
		m := newTestMEXC(t, execution.MarketSpot, stub)
		if _, err := m.GetTicker(context.Background(), "BTC/USDT"); err != nil {
			t.Fatalf("GetTicker: %v", err)
		}
		req := stub.reqs[0]
		for _, h := range []string{"X-MEXC-APIKEY", "X-MEXC-SIGNATURE", "X-MEXC-TIMESTAMP"} {
			if got := req.Header.Get(h); got != "" {
				t.Errorf("public request carries %s: %q", h, got)
			}
		}
	})
}

// TestSymbolMappingBothDirections covers the venue's distinguishing rule —
// the underscored wire form BTC_USDT — in BOTH directions plus the named
// refusals.
func TestSymbolMappingBothDirections(t *testing.T) {
	t.Run("canonical to wire in the request", func(t *testing.T) {
		stub := newStub(200, `{"symbol":"BTC_USDT","lastPrice":"65000.5"}`)
		m := newTestMEXC(t, execution.MarketSpot, stub)
		if _, err := m.GetTicker(context.Background(), "BTC/USDT"); err != nil {
			t.Fatalf("GetTicker: %v", err)
		}
		if got := stub.reqs[0].URL.Query().Get("symbol"); got != "BTC_USDT" {
			t.Fatalf("wire symbol: got %q, want BTC_USDT", got)
		}
	})
	t.Run("wire to canonical in the response", func(t *testing.T) {
		stub := newStub(200, `{"orderId":"1","symbol":"BTC_USDT","origQty":"1","executedQty":"0","status":"NEW","type":"LIMIT","side":"BUY","price":"1"}`)
		m := newTestMEXC(t, execution.MarketSpot, stub)
		order, err := m.GetOrder(context.Background(), "BTC/USDT", "1")
		if err != nil {
			t.Fatalf("GetOrder: %v", err)
		}
		if order.Symbol != "BTC/USDT" {
			t.Fatalf("canonical symbol: got %q, want BTC/USDT", order.Symbol)
		}
	})
	cases := []struct {
		name        string
		symbol      string
		fixtureBody string
		wantErr     error
	}{
		{"non-canonical symbol refused", "BTCUSDT", `{}`, exchanges.ErrInvalidSymbol},
		{"unknown quote refused on input", "BTC/FOO", `{}`, exchanges.ErrUnknownQuote},
		{"unknown quote refused on wire echo", "BTC/USDT", `{"orderId":"1","symbol":"BTC_FOO","origQty":"1","executedQty":"0","status":"NEW","type":"LIMIT","side":"BUY","price":"1"}`, exchanges.ErrUnknownQuote},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := newStub(200, tc.fixtureBody)
			m := newTestMEXC(t, execution.MarketSpot, stub)
			_, err := m.GetOrder(context.Background(), tc.symbol, "1")
			if tc.symbol == "BTCUSDT" || tc.symbol == "BTC/FOO" {
				// Invalid input: refused before any request.
				if len(stub.reqs) != 0 {
					t.Fatalf("request issued for refused symbol")
				}
				_, err = m.GetTicker(context.Background(), tc.symbol)
			}
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("got err %v, want %v", err, tc.wantErr)
			}
		})
	}
}

func TestOrderStatusMapping(t *testing.T) {
	cases := []struct {
		wire string
		want execution.ChildOrderStatus
	}{
		{"NEW", execution.ChildOpen},
		{"PARTIALLY_FILLED", execution.ChildPartial},
		{"FILLED", execution.ChildFilled},
		{"CANCELED", execution.ChildCancelled},
		{"CANCELLED", execution.ChildCancelled},
		{"REJECTED", execution.ChildRejected},
		{"EXPIRED", execution.ChildExpired},
		{"new", execution.ChildOpen}, // names are case-insensitive
		{"Partially_Filled", execution.ChildPartial},
		{"UNEXPECTED_NAME", execution.ChildUnknown},
		{"3", execution.ChildUnknown}, // numeric states are never guessed
		{"", execution.ChildUnknown},
	}
	for _, tc := range cases {
		t.Run("wire_"+tc.wire, func(t *testing.T) {
			body := `{"orderId":"1","symbol":"BTC_USDT","origQty":"1","executedQty":"0","status":"` + tc.wire + `","type":"LIMIT","side":"BUY","price":"1"}`
			stub := newStub(200, body)
			m := newTestMEXC(t, execution.MarketSpot, stub)
			order, err := m.GetOrder(context.Background(), "BTC/USDT", "1")
			if err != nil {
				t.Fatalf("GetOrder: %v", err)
			}
			if order.Status != tc.want {
				t.Fatalf("status %q: got %v, want %v", tc.wire, order.Status, tc.want)
			}
		})
	}
}

func TestErrorClassificationFromFixtures(t *testing.T) {
	cases := []struct {
		name         string
		body         string
		status       int
		wantCategory execution.ErrorCategory
		wantRetry    bool
		wantCode     string
	}{
		{"429 rate limited", `{"code":429,"msg":"too many requests"}`, 429, execution.ErrRateLimited, true, "429"},
		{"401 permission", `{"code":401,"msg":"invalid api key"}`, 401, execution.ErrPermissionError, false, "401"},
		{"403 permission", `{"code":403,"msg":"forbidden"}`, 403, execution.ErrPermissionError, false, "403"},
		{"10007 insufficient balance", `{"code":10007,"msg":"balance not enough"}`, 400, execution.ErrInsufficientBalance, false, "10007"},
		{"10211 invalid order", `{"code":10211,"msg":"order rejected"}`, 400, execution.ErrInvalidOrder, false, "10211"},
		{"400 invalid order", `{"code":400,"msg":"bad request"}`, 400, execution.ErrInvalidOrder, false, "400"},
		{"500 retryable", `{"code":500,"msg":"server error"}`, 500, execution.ErrNetworkRetryable, true, "500"},
		{"503 retryable", `{"code":503,"msg":"unavailable"}`, 503, execution.ErrNetworkRetryable, true, "503"},
		{"string code", `{"code":"10007","msg":"balance not enough"}`, 400, execution.ErrInsufficientBalance, false, "10007"},
		{"contract success:false envelope", `{"success":false,"code":10211,"msg":"order rejected","data":null}`, 200, execution.ErrInvalidOrder, false, "10211"},
		{"unknown code", `{"code":99999,"msg":"mystery"}`, 200, execution.ErrUnknown, false, "99999"},
		{"bare 5xx without code classifies per status family", `gateway timeout`, 504, execution.ErrNetworkRetryable, true, ""},
		{"bare 4xx outside the mapped families stays unknown", `not found`, 404, execution.ErrUnknown, false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := newStub(tc.status, tc.body)
			m := newTestMEXC(t, execution.MarketSpot, stub)
			_, err := m.GetOrder(context.Background(), "BTC/USDT", "1")
			if err == nil {
				t.Fatalf("GetOrder: expected error")
			}
			class := exchanges.Classify(err)
			if class.Category != tc.wantCategory {
				t.Errorf("category: got %v, want %v", class.Category, tc.wantCategory)
			}
			if class.Retryable != tc.wantRetry {
				t.Errorf("retryable: got %v, want %v", class.Retryable, tc.wantRetry)
			}
			var ve *exchanges.VenueError
			if !errors.As(err, &ve) {
				t.Fatalf("error is not a *exchanges.VenueError: %T", err)
			}
			if ve.Code != tc.wantCode {
				t.Errorf("code: got %q, want %q", ve.Code, tc.wantCode)
			}
		})
	}
}

func TestCreateOrderParsing(t *testing.T) {
	t.Run("spot limit order echoes request fields", func(t *testing.T) {
		stub := newStub(200, `{"symbol":"BTC_USDT","orderId":"9001","clientOrderId":"fud_x_1","price":"65000.5","origQty":"0.1","executedQty":"0","status":"NEW","type":"LIMIT","side":"BUY","time":1690000000000}`)
		m := newTestMEXC(t, execution.MarketSpot, stub)
		order, err := m.CreateOrder(context.Background(), execution.OrderRequest{
			ClientOrderID: "fud_x_1",
			Symbol:        "BTC/USDT",
			Side:          execution.SideBuy,
			Quantity:      "0.1",
			Price:         "65000.5",
			OrderType:     "limit",
			TimeInForce:   execution.TIFGTC,
			Intent:        execution.IntentOpen,
		})
		if err != nil {
			t.Fatalf("CreateOrder: %v", err)
		}
		if order.ExchangeOrderID != "9001" || order.ClientOrderID != "fud_x_1" ||
			order.Symbol != "BTC/USDT" || order.Side != execution.SideBuy ||
			order.Type != "limit" || order.Quantity != "0.1" ||
			order.FilledQuantity != "0" || order.Status != execution.ChildOpen ||
			order.IsExit || order.SubmittedAt != 1690000000000 ||
			// No update time on the wire: updated falls back to created (TS mapOrder parity).
			order.UpdatedAt != 1690000000000 ||
			order.Price == nil || *order.Price != "65000.5" {
			t.Fatalf("order: got %+v", order)
		}
		req := stub.reqs[0]
		if req.Method != http.MethodPost || req.URL.Path != "/api/v3/order" {
			t.Fatalf("unexpected request: %s %s", req.Method, req.URL.Path)
		}
		form, err := url.ParseQuery(req.Body)
		if err != nil {
			t.Fatalf("parse form: %v", err)
		}
		wantForm := map[string]string{
			"symbol":        "BTC_USDT",
			"side":          "BUY",
			"type":          "LIMIT",
			"quantity":      "0.1",
			"price":         "65000.5",
			"timeInForce":   "GTC",
			"clientOrderId": "fud_x_1",
		}
		for k, want := range wantForm {
			if got := form.Get(k); got != want {
				t.Errorf("form %s: got %q, want %q", k, got, want)
			}
		}
	})
	t.Run("spot market order keeps decimal literals exact", func(t *testing.T) {
		const huge = "100000000000000000000.5"
		stub := newStub(200, `{"symbol":"BTC_USDT","orderId":"9002","clientOrderId":"fud_x_2","price":"0","origQty":"`+huge+`","executedQty":"0.1","status":"PARTIALLY_FILLED","type":"MARKET","side":"SELL","time":1690000000000}`)
		m := newTestMEXC(t, execution.MarketSpot, stub)
		order, err := m.CreateOrder(context.Background(), execution.OrderRequest{
			ClientOrderID: "fud_x_2",
			Symbol:        "BTC/USDT",
			Side:          execution.SideSell,
			Quantity:      huge,
			Price:         "",
			OrderType:     "market",
			TimeInForce:   execution.TIFIOC,
			Intent:        execution.IntentReduce,
		})
		if err != nil {
			t.Fatalf("CreateOrder: %v", err)
		}
		if order.Quantity != huge {
			t.Errorf("quantity: got %q, want %q", order.Quantity, huge)
		}
		if order.FilledQuantity != "0.1" {
			t.Errorf("filled: got %q, want 0.1", order.FilledQuantity)
		}
		if order.Price != nil {
			t.Errorf("market order price: got %v, want nil (venue '0' marker)", *order.Price)
		}
		if order.Status != execution.ChildPartial {
			t.Errorf("status: got %v, want PARTIAL", order.Status)
		}
		if !order.IsExit {
			t.Errorf("IsExit: got false, want true (reduce intent)")
		}
		form, _ := url.ParseQuery(stub.reqs[0].Body)
		if form.Get("price") != "" {
			t.Errorf("market order sent a price: %q", form.Get("price"))
		}
	})
	t.Run("contract submit uses the assumed category-2 form", func(t *testing.T) {
		stub := newStub(200, `{"success":true,"code":200,"data":{"orderId":"77","clientOrderId":"fud_x_3"}}`)
		m := newTestMEXC(t, execution.MarketLinearPerp, stub)
		order, err := m.CreateOrder(context.Background(), execution.OrderRequest{
			ClientOrderID: "fud_x_3",
			Symbol:        "BTC/USDT",
			Side:          execution.SideBuy,
			Quantity:      "0.25",
			Price:         "65000.5",
			OrderType:     "limit",
			TimeInForce:   execution.TIFGTC,
			ReduceOnly:    true,
			Intent:        execution.IntentClose,
		})
		if err != nil {
			t.Fatalf("CreateOrder: %v", err)
		}
		if order.ExchangeOrderID != "77" || order.ClientOrderID != "fud_x_3" {
			t.Errorf("ids: got %q/%q", order.ExchangeOrderID, order.ClientOrderID)
		}
		if order.Quantity != "0.25" || order.Side != execution.SideBuy || order.Type != "limit" {
			t.Errorf("request-echo fields: got %+v", order)
		}
		if order.Status != execution.ChildUnknown {
			t.Errorf("ack-only status: got %v, want UNKNOWN (never guessed)", order.Status)
		}
		if !order.IsExit {
			t.Errorf("IsExit: got false, want true (close intent)")
		}
		req := stub.reqs[0]
		if req.Method != http.MethodPost || req.URL.Path != "/api/v1/contract/submit" {
			t.Fatalf("unexpected request: %s %s", req.Method, req.URL.Path)
		}
		form, _ := url.ParseQuery(req.Body)
		wantForm := map[string]string{
			"symbol":        "BTC_USDT",
			"vol":           "0.25",
			"side":          "2", // close short — reduce-only buy
			"type":          "5", // limit
			"openType":      "2", // category 2: cross
			"price":         "65000.5",
			"clientOrderId": "fud_x_3",
		}
		for k, want := range wantForm {
			if got := form.Get(k); got != want {
				t.Errorf("form %s: got %q, want %q", k, got, want)
			}
		}
	})
}

func TestGetBalanceParsing(t *testing.T) {
	t.Run("spot sums row totals exactly", func(t *testing.T) {
		stub := newStub(200, `{"balances":[
			{"asset":"BTC","free":"0.1","locked":"0.2"},
			{"asset":"USDT","free":"100000000000000000000.5","locked":"0"},
			{"asset":"DUST","free":"0","locked":"0"}
		]}`)
		m := newTestMEXC(t, execution.MarketSpot, stub)
		eq, err := m.GetBalance(context.Background())
		if err != nil {
			t.Fatalf("GetBalance: %v", err)
		}
		if len(eq.Balances) != 2 {
			t.Fatalf("rows: got %d (zero row must be skipped), want 2", len(eq.Balances))
		}
		if eq.Balances[0] != (execution.Balance{Asset: "BTC", Free: "0.1", Used: "0.2", Total: "0.3"}) {
			t.Errorf("BTC row: got %+v", eq.Balances[0])
		}
		if eq.Balances[1].Total != "100000000000000000000.5" {
			t.Errorf("USDT total: got %q, want 100000000000000000000.5", eq.Balances[1].Total)
		}
		const sum = "100000000000000000000.8"
		if eq.SpotEquity == nil || *eq.SpotEquity != sum {
			t.Errorf("spot equity: got %v, want %q", eq.SpotEquity, sum)
		}
		if eq.FuturesEquity != nil {
			t.Errorf("futures equity on spot account: got %v, want nil (honest null)", *eq.FuturesEquity)
		}
		if eq.TotalEquity == nil || *eq.TotalEquity != sum {
			t.Errorf("total equity: got %v, want %q", eq.TotalEquity, sum)
		}
		if eq.Timestamp != fixedMillis {
			t.Errorf("timestamp: got %d, want %d", eq.Timestamp, fixedMillis)
		}
	})
	t.Run("empty balances stay honest nulls", func(t *testing.T) {
		stub := newStub(200, `{"balances":[]}`)
		m := newTestMEXC(t, execution.MarketSpot, stub)
		eq, err := m.GetBalance(context.Background())
		if err != nil {
			t.Fatalf("GetBalance: %v", err)
		}
		if eq.SpotEquity != nil || eq.FuturesEquity != nil || eq.TotalEquity != nil {
			t.Fatalf("empty balances must yield nil equity, got %+v", eq)
		}
	})
	t.Run("contract form fills futures basis only", func(t *testing.T) {
		stub := newStub(200, `{"success":true,"code":200,"data":[{"currency":"USDT","available":"5","frozen":"2"},{"currency":"BTC","available":"0","frozen":"0"}]}`)
		m := newTestMEXC(t, execution.MarketLinearPerp, stub)
		eq, err := m.GetBalance(context.Background())
		if err != nil {
			t.Fatalf("GetBalance: %v", err)
		}
		if len(eq.Balances) != 1 {
			t.Fatalf("rows: got %d, want 1", len(eq.Balances))
		}
		if eq.Balances[0] != (execution.Balance{Asset: "USDT", Free: "5", Used: "2", Total: "7"}) {
			t.Errorf("USDT row: got %+v", eq.Balances[0])
		}
		if eq.FuturesEquity == nil || *eq.FuturesEquity != "7" {
			t.Errorf("futures equity: got %v, want 7", eq.FuturesEquity)
		}
		if eq.SpotEquity != nil {
			t.Errorf("spot equity on perp account: got %v, want nil (honest null)", *eq.SpotEquity)
		}
		if eq.TotalEquity == nil || *eq.TotalEquity != "7" {
			t.Errorf("total equity: got %v, want 7", eq.TotalEquity)
		}
	})
}

func TestGetFillsParsing(t *testing.T) {
	cases := []struct {
		name string
		body string
		want execution.Fill
	}{
		{
			"spot form with every field",
			`[{"id":"11","orderId":"9001","clientOrderId":"fud_x_1","price":"65000.5","qty":"0.1","quoteQty":"6500.05","commission":"0.001","commissionAsset":"USDT","time":1690000000000}]`,
			execution.Fill{ExchangeTradeID: "11", ClientOrderID: "fud_x_1", Price: "65000.5", Quantity: "0.1", QuoteQuantity: "6500.05", Fee: "0.001", FeeAsset: "USDT", Timestamp: 1690000000000},
		},
		{
			"exact decimals survive untouched",
			`[{"id":"12","price":"100000000000000000000.5","qty":"0.1","quoteQty":"10000000000000000000.05","commission":"0","commissionAsset":"USDT","time":1}]`,
			execution.Fill{ExchangeTradeID: "12", Price: "100000000000000000000.5", Quantity: "0.1", QuoteQuantity: "10000000000000000000.05", Fee: "0", FeeAsset: "USDT", Timestamp: 1},
		},
		{
			"missing quote computed exactly; unreported fee/asset honest",
			`[{"id":"13","price":"0.1","qty":"0.3","time":5}]`,
			execution.Fill{ExchangeTradeID: "13", Price: "0.1", Quantity: "0.3", QuoteQuantity: "0.03", Fee: "0", FeeAsset: "", Timestamp: 5},
		},
		{
			"contract form aliases; missing timestamp is receipt time",
			`[{"dealId":"14","orderId":"77","dealPrice":"65000.5","vol":"0.1","fee":"0.002","feeCurrency":"USDT"}]`,
			execution.Fill{ExchangeTradeID: "14", Price: "65000.5", Quantity: "0.1", QuoteQuantity: "6500.05", Fee: "0.002", FeeAsset: "USDT", Timestamp: fixedMillis},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := newStub(200, tc.body)
			m := newTestMEXC(t, execution.MarketSpot, stub)
			fills, err := m.GetFills(context.Background(), "BTC/USDT")
			if err != nil {
				t.Fatalf("GetFills: %v", err)
			}
			if len(fills) != 1 {
				t.Fatalf("fills: got %d, want 1", len(fills))
			}
			if fills[0] != tc.want {
				t.Fatalf("fill: got %+v, want %+v", fills[0], tc.want)
			}
		})
	}
}

// TestAccountMetadataPermissionsAreHonestNulls is the repo's named
// honest-nulls example: MEXC does not report key-restriction flags, so the
// trade/withdraw flags MUST come back nil — never inferred true or false.
func TestAccountMetadataPermissionsAreHonestNulls(t *testing.T) {
	// The fixture deliberately omits any key-restriction data.
	const fixtureBody = `{"someAccountPayload":true}`
	for _, market := range []execution.MarketType{execution.MarketSpot, execution.MarketLinearPerp} {
		t.Run(string(market), func(t *testing.T) {
			stub := newStub(200, fixtureBody)
			m := newTestMEXC(t, market, stub)
			meta, err := m.GetAccount(context.Background())
			if err != nil {
				t.Fatalf("GetAccount: %v", err)
			}
			if meta.Permissions.SpotTrade != nil {
				t.Errorf("SpotTrade: got %v, want nil (MEXC does not report it)", *meta.Permissions.SpotTrade)
			}
			if meta.Permissions.FuturesTrade != nil {
				t.Errorf("FuturesTrade: got %v, want nil (MEXC does not report it)", *meta.Permissions.FuturesTrade)
			}
			if meta.Permissions.Withdraw != nil {
				t.Errorf("Withdraw: got %v, want nil (MEXC does not report it)", *meta.Permissions.Withdraw)
			}
			if !meta.Permissions.Read {
				t.Errorf("Read: got false, want true (a successful signed read proves read)")
			}
			if meta.Health != execution.HealthActive {
				t.Errorf("health: got %v, want ACTIVE", meta.Health)
			}
			if meta.APIKeyMasked == nil || *meta.APIKeyMasked != "api...456" {
				t.Errorf("APIKeyMasked: got %v, want api...456", meta.APIKeyMasked)
			} else if strings.Contains(*meta.APIKeyMasked, testAPIKey) || strings.Contains(*meta.APIKeyMasked, testSecret) {
				t.Errorf("masked key leaks credential material")
			}
		})
	}
}

func TestGetAccountProbeFailureSetsHealth(t *testing.T) {
	cases := []struct {
		name       string
		body       string
		status     int
		wantHealth execution.CredentialHealth
	}{
		{"401 auth failure", `{"code":401,"msg":"invalid api key"}`, 401, execution.HealthPermissionError},
		{"429 rate limited", `{"code":429,"msg":"slow down"}`, 429, execution.HealthRateLimited},
		{"500 anything else", `{"code":500,"msg":"server error"}`, 500, execution.HealthInvalid},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := newStub(tc.status, tc.body)
			m := newTestMEXC(t, execution.MarketSpot, stub)
			meta, err := m.GetAccount(context.Background())
			if err == nil {
				t.Fatalf("GetAccount: expected probe failure")
			}
			if meta.Health != tc.wantHealth {
				t.Errorf("health: got %v, want %v", meta.Health, tc.wantHealth)
			}
			if meta.Permissions.Read {
				t.Errorf("Read: got true, want false (no successful signed read)")
			}
			if meta.Permissions.SpotTrade != nil || meta.Permissions.FuturesTrade != nil || meta.Permissions.Withdraw != nil {
				t.Errorf("restriction flags must stay nil even on failure")
			}
		})
	}
}

func TestGetPosition(t *testing.T) {
	t.Run("spot refuses with ErrNoPosition and no request", func(t *testing.T) {
		stub := newStub(200, `{}`)
		m := newTestMEXC(t, execution.MarketSpot, stub)
		_, err := m.GetPosition(context.Background(), "BTC/USDT")
		if !errors.Is(err, exchanges.ErrNoPosition) {
			t.Fatalf("got %v, want ErrNoPosition", err)
		}
		if len(stub.reqs) != 0 {
			t.Fatalf("spot GetPosition must not touch the network")
		}
	})
	cases := []struct {
		name      string
		body      string
		wantErr   error
		wantQty   string
		wantSide  execution.Side
		wantEntry string
	}{
		{"flat holding is ErrNoPosition", `{"success":true,"code":200,"data":{"holdVol":"0","positionType":1}}`, exchanges.ErrNoPosition, "", "", ""},
		{"empty payload is ErrNoPosition", `{"success":true,"code":200,"data":null}`, exchanges.ErrNoPosition, "", "", ""},
		{"long position signed positive", `{"success":true,"code":200,"data":{"holdVol":"1.5","positionType":1,"openAvgPrice":"65000.5","leverage":"20","marginMode":2,"liquidationPrice":"50000"}}`, nil, "1.5", execution.SideBuy, "65000.5"},
		{"short position signed negative", `{"success":true,"code":200,"data":{"holdVol":"2","positionType":2,"openAvgPrice":"64000"}}`, nil, "-2", execution.SideSell, "64000"},
		{"zero positionType code falls back to signed magnitude", `{"success":true,"code":200,"data":{"holdVol":"-0.75","positionType":0,"openAvgPrice":"1"}}`, nil, "-0.75", execution.SideSell, "1"},
		{"missing direction refused", `{"success":true,"code":200,"data":{"holdVol":"1","openAvgPrice":"1"}}`, errMalformedPayload, "", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := newStub(200, tc.body)
			m := newTestMEXC(t, execution.MarketLinearPerp, stub)
			pos, err := m.GetPosition(context.Background(), "BTC/USDT")
			if tc.wantErr != nil {
				if tc.wantErr == errMalformedPayload {
					var ve *exchanges.VenueError
					if !errors.As(err, &ve) {
						t.Fatalf("got %v, want wrapped malformed venue error", err)
					}
					return
				}
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("got %v, want %v", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("GetPosition: %v", err)
			}
			if pos.Quantity != tc.wantQty || pos.Side != tc.wantSide || pos.EntryPrice != tc.wantEntry {
				t.Fatalf("position: got %+v", pos)
			}
			if pos.Symbol != "BTC/USDT" || pos.MarketType != execution.MarketLinearPerp || pos.PositionSide != "net" {
				t.Fatalf("position identity: got %+v", pos)
			}
		})
	}
	t.Run("honest nils on unreported figures", func(t *testing.T) {
		stub := newStub(200, `{"success":true,"code":200,"data":{"holdVol":"1","positionType":1}}`)
		m := newTestMEXC(t, execution.MarketLinearPerp, stub)
		pos, err := m.GetPosition(context.Background(), "BTC/USDT")
		if err != nil {
			t.Fatalf("GetPosition: %v", err)
		}
		if pos.Leverage != nil || pos.MarginMode != nil || pos.LiquidationPrice != nil {
			t.Fatalf("unreported figures must be nil, got %+v", pos)
		}
	})
}

func TestGetTickerHonestNulls(t *testing.T) {
	cases := []struct {
		name     string
		body     string
		wantBid  *string
		wantAsk  *string
		wantLast *string
	}{
		{"empty touches stay nil", `{"symbol":"BTC_USDT","lastPrice":"65000.5","bidPrice":"","askPrice":"0"}`, nil, nil, ptr("65000.5")},
		{"contract form touches", `{"success":true,"code":200,"data":{"symbol":"BTC_USDT","lastPrice":"1","bid1Price":"0.9","ask1Price":"1.1"}}`, ptr("0.9"), ptr("1.1"), ptr("1")},
		{"no ticker row is all-nil", `null`, nil, nil, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			market := execution.MarketSpot
			if strings.Contains(tc.name, "contract") {
				market = execution.MarketLinearPerp
			}
			stub := newStub(200, tc.body)
			m := newTestMEXC(t, market, stub)
			tick, err := m.GetTicker(context.Background(), "BTC/USDT")
			if err != nil {
				t.Fatalf("GetTicker: %v", err)
			}
			if tick.Symbol != "BTC/USDT" {
				t.Errorf("symbol: got %q", tick.Symbol)
			}
			checkPtr := func(name string, got, want *string) {
				t.Helper()
				switch {
				case got == nil && want == nil:
				case got != nil && want != nil && *got == *want:
				default:
					t.Errorf("%s: got %v, want %v", name, got, want)
				}
			}
			checkPtr("bid", tick.Bid, tc.wantBid)
			checkPtr("ask", tick.Ask, tc.wantAsk)
			checkPtr("last", tick.Last, tc.wantLast)
		})
	}
}

func TestInvalidOrderRequestRefusals(t *testing.T) {
	base := execution.OrderRequest{
		ClientOrderID: "fud_x_1",
		Symbol:        "BTC/USDT",
		Side:          execution.SideBuy,
		Quantity:      "0.1",
		Price:         "65000.5",
		OrderType:     "limit",
		TimeInForce:   execution.TIFGTC,
		Intent:        execution.IntentOpen,
	}
	cases := []struct {
		name    string
		mutate  func(*execution.OrderRequest)
		wantErr error
	}{
		{"missing client order id", func(r *execution.OrderRequest) { r.ClientOrderID = "" }, exchanges.ErrInvalidOrder},
		{"unknown side", func(r *execution.OrderRequest) { r.Side = "hold" }, exchanges.ErrInvalidOrder},
		{"unknown order type", func(r *execution.OrderRequest) { r.OrderType = "stop" }, exchanges.ErrInvalidOrder},
		{"non-decimal quantity", func(r *execution.OrderRequest) { r.Quantity = "abc" }, exchanges.ErrInvalidOrder},
		{"zero quantity", func(r *execution.OrderRequest) { r.Quantity = "0" }, exchanges.ErrInvalidOrder},
		{"negative quantity", func(r *execution.OrderRequest) { r.Quantity = "-1" }, exchanges.ErrInvalidOrder},
		{"limit without price", func(r *execution.OrderRequest) { r.Price = "" }, exchanges.ErrInvalidOrder},
		{"non-decimal price", func(r *execution.OrderRequest) { r.Price = "1,5" }, exchanges.ErrInvalidOrder},
		{"market with price", func(r *execution.OrderRequest) { r.OrderType = "market" }, exchanges.ErrInvalidOrder},
		{"unknown time in force", func(r *execution.OrderRequest) { r.TimeInForce = "GTD" }, exchanges.ErrInvalidOrder},
		{"invalid symbol", func(r *execution.OrderRequest) { r.Symbol = "BTCUSDT" }, exchanges.ErrInvalidSymbol},
		{"unknown quote", func(r *execution.OrderRequest) { r.Symbol = "BTC/FOO" }, exchanges.ErrUnknownQuote},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := newStub(200, `{}`)
			m := newTestMEXC(t, execution.MarketSpot, stub)
			req := base
			tc.mutate(&req)
			_, err := m.CreateOrder(context.Background(), req)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("got %v, want %v", err, tc.wantErr)
			}
			if len(stub.reqs) != 0 {
				t.Fatalf("refused request must not reach the wire")
			}
		})
	}
}

func TestTransportErrorWrappedNetworkRetryable(t *testing.T) {
	cause := errors.New("dial tcp: connection refused")
	stub := &stubClient{err: cause}
	m := newTestMEXC(t, execution.MarketSpot, stub)
	_, err := m.GetBalance(context.Background())
	if err == nil {
		t.Fatalf("GetBalance: expected transport error")
	}
	class := exchanges.Classify(err)
	if class.Category != execution.ErrNetworkRetryable || !class.Retryable {
		t.Fatalf("transport failure: got %+v, want network_retryable", class)
	}
	if !errors.Is(err, cause) {
		t.Fatalf("transport cause not wrapped: %v", err)
	}
	var ve *exchanges.VenueError
	if !errors.As(err, &ve) {
		t.Fatalf("not a *exchanges.VenueError: %T", err)
	}
}

func TestErrorsNeverContainSecretMaterial(t *testing.T) {
	// The venue echoes credential-looking text back; it must never survive
	// into the rendered error (PRD §109).
	body := `{"code":401,"msg":"auth failed for apiKey123456 using s3cr3t sig ` + strings.Repeat("a", 64) + ` tail"}`
	stub := newStub(401, body)
	m := newTestMEXC(t, execution.MarketSpot, stub)
	_, err := m.GetAccount(context.Background())
	if err == nil {
		t.Fatalf("GetAccount: expected error")
	}
	rendered := err.Error()
	for _, leaked := range []string{testAPIKey, testSecret, strings.Repeat("a", 64)} {
		if strings.Contains(rendered, leaked) {
			t.Errorf("error leaks secret material %q: %q", leaked, rendered)
		}
	}
	if !strings.Contains(rendered, "[REDACTED]") {
		t.Errorf("error does not show redaction: %q", rendered)
	}
	if len(rendered) > 400 {
		t.Errorf("error message not capped: %d chars", len(rendered))
	}
}

func TestNilContextRefused(t *testing.T) {
	stub := newStub(200, `{}`)
	m := newTestMEXC(t, execution.MarketSpot, stub)
	if _, err := m.GetBalance(nil); !errors.Is(err, ErrNilContext) {
		t.Fatalf("GetBalance(nil): got %v, want ErrNilContext", err)
	}
	if _, err := m.GetOrder(nil, "BTC/USDT", "1"); !errors.Is(err, ErrNilContext) {
		t.Fatalf("GetOrder(nil): got %v, want ErrNilContext", err)
	}
}

func TestGetOpenOrdersAndCancelOrder(t *testing.T) {
	t.Run("open orders map to canonical views", func(t *testing.T) {
		stub := newStub(200, `[
			{"orderId":"1","symbol":"BTC_USDT","origQty":"1","executedQty":"0.5","status":"PARTIALLY_FILLED","type":"LIMIT","side":"BUY","price":"1"},
			{"orderId":"2","symbol":"BTC_USDT","origQty":"2","executedQty":"0","status":"NEW","type":"MARKET","side":"SELL","price":"0"}
		]`)
		m := newTestMEXC(t, execution.MarketSpot, stub)
		orders, err := m.GetOpenOrders(context.Background(), "BTC/USDT")
		if err != nil {
			t.Fatalf("GetOpenOrders: %v", err)
		}
		if len(orders) != 2 {
			t.Fatalf("orders: got %d, want 2", len(orders))
		}
		if orders[0].Status != execution.ChildPartial || orders[0].FilledQuantity != "0.5" {
			t.Errorf("order 0: got %+v", orders[0])
		}
		if orders[1].Price != nil {
			t.Errorf("market order price: got %v, want nil", *orders[1].Price)
		}
	})
	t.Run("cancel returns the final order view", func(t *testing.T) {
		stub := newStub(200, `{"orderId":"9","symbol":"BTC_USDT","origQty":"1","executedQty":"0","status":"CANCELED","type":"LIMIT","side":"SELL","price":"2"}`)
		m := newTestMEXC(t, execution.MarketSpot, stub)
		order, err := m.CancelOrder(context.Background(), "BTC/USDT", "9")
		if err != nil {
			t.Fatalf("CancelOrder: %v", err)
		}
		if order.Status != execution.ChildCancelled {
			t.Errorf("status: got %v, want CANCELLED", order.Status)
		}
		req := stub.reqs[0]
		if req.Method != http.MethodDelete || req.URL.Query().Get("orderId") != "9" {
			t.Errorf("cancel request: %s %s", req.Method, req.URL.RawQuery)
		}
	})
	t.Run("unknown order maps to ErrOrderNotFound", func(t *testing.T) {
		stub := newStub(200, `null`)
		m := newTestMEXC(t, execution.MarketSpot, stub)
		_, err := m.GetOrder(context.Background(), "BTC/USDT", "404")
		if !errors.Is(err, exchanges.ErrOrderNotFound) {
			t.Fatalf("got %v, want ErrOrderNotFound", err)
		}
	})
}

// ptr returns a *string for fixture literals.
func ptr(s string) *string { return &s }

package bybit

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges"
)

const (
	testAPIKey    = "test-api-key-0001"
	testAPISecret = "super-secret-key"
	testMillis    = int64(1700000000000)
)

// stubCall is one scripted HTTP response for the stub transport.
type stubCall struct {
	status int
	body   string
	err    error
}

// stubClient records every request (with its raw body) and replays scripted
// responses in order — the injectable exchanges.HTTPClient seam, so no test
// ever touches the network.
type stubClient struct {
	t     *testing.T
	calls []stubCall
	reqs  []*http.Request
	raws  []string
}

// Do implements exchanges.HTTPClient.
func (s *stubClient) Do(req *http.Request) (*http.Response, error) {
	idx := len(s.reqs)
	s.reqs = append(s.reqs, req)
	raw := ""
	if req.Body != nil {
		b, err := io.ReadAll(req.Body)
		if err != nil {
			s.t.Fatalf("reading captured body: %v", err)
		}
		raw = string(b)
	}
	s.raws = append(s.raws, raw)
	if idx >= len(s.calls) {
		s.t.Fatalf("unexpected HTTP call %d: %s %s", idx, req.Method, req.URL.Path)
	}
	call := s.calls[idx]
	if call.err != nil {
		return nil, call.err
	}
	return &http.Response{
		StatusCode: call.status,
		Body:       io.NopCloser(strings.NewReader(call.body)),
		Header:     http.Header{},
	}, nil
}

// newStub wires a Bybit adapter over a scripted stub transport with a pinned
// clock so signatures are deterministic.
func newStub(t *testing.T, market execution.MarketType, calls ...stubCall) (*Bybit, *stubClient) {
	t.Helper()
	stub := &stubClient{t: t, calls: calls}
	b, err := New(Config{
		Credentials: exchanges.Credentials{APIKey: testAPIKey, APISecret: testAPISecret},
		HTTP:        stub,
		Clock:       exchanges.FixedClock{Millis: testMillis},
		MarketType:  market,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return b, stub
}

// ok wraps a result payload in a success envelope fixture.
func ok(result string) stubCall {
	return stubCall{status: 200, body: `{"retCode":0,"retMsg":"OK","result":` + result + `}`}
}

// fail wraps a venue refusal fixture.
func fail(retCode int, retMsg string) stubCall {
	return stubCall{status: 200, body: `{"retCode":` + strconv.Itoa(retCode) + `,"retMsg":` + strconv.Quote(retMsg) + `,"result":{}}`}
}

// independentHMAC computes the Bybit signature from scratch (not via Sign):
// HMAC-SHA256 over timestamp+apiKey+recvWindow+payload, hex-lowercase.
func independentHMAC(secret, timestamp, apiKey, recvWindow, payload string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp + apiKey + recvWindow + payload))
	return hex.EncodeToString(mac.Sum(nil))
}

func TestNewRefusals(t *testing.T) {
	valid := Config{
		Credentials: exchanges.Credentials{APIKey: "k", APISecret: "s"},
		HTTP:        exchanges.HTTPClientFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("unused") }),
		MarketType:  execution.MarketSpot,
	}
	cases := []struct {
		name    string
		mutate  func(*Config)
		wantErr error
	}{
		{"empty api key", func(c *Config) { c.Credentials.APIKey = "" }, ErrCredentialsRequired},
		{"empty secret", func(c *Config) { c.Credentials.APISecret = "" }, ErrCredentialsRequired},
		{"nil http client", func(c *Config) { c.HTTP = nil }, ErrHTTPClientRequired},
		{"unknown market type", func(c *Config) { c.MarketType = "futures" }, ErrInvalidMarketType},
	}
	for _, c := range cases {
		cfg := valid
		c.mutate(&cfg)
		if _, err := New(cfg); !errors.Is(err, c.wantErr) {
			t.Errorf("%s: New() error = %v, want %v", c.name, err, c.wantErr)
		}
	}
	if _, err := New(valid); err != nil {
		t.Errorf("valid config refused: %v", err)
	}
}

func TestSignKnownAnswerVectors(t *testing.T) {
	cases := []struct {
		name               string
		timestamp, apiKey  string
		secret, recvWindow string
		payload, want      string
	}{
		{
			name:      "GET query payload (fixed key, fixed timestamp)",
			timestamp: "1700000000000", apiKey: "test-api-key-0001",
			secret: "super-secret-key", recvWindow: "5000",
			payload: "category=linear&symbol=BTCUSDT",
			want:    "d9a3365ba46c148f102f6b5f764e80bf998071d8e2f5e9392fcb45d312c5eef2",
		},
		{
			name:      "POST raw-body payload",
			timestamp: "1655890000000", apiKey: "abcdefghijklmnopqrst",
			secret: "shhh", recvWindow: "5000",
			payload: `{"symbol":"BTCUSDT","side":"Buy"}`,
			want:    "1cac1c064407ea8db274ac7b550ac45819726387946e48234b88b95f6de4c305",
		},
	}
	for _, c := range cases {
		got := Sign(c.timestamp, c.apiKey, c.secret, c.recvWindow, c.payload)
		if got != c.want {
			t.Errorf("%s: Sign() = %s, want %s", c.name, got, c.want)
		}
		if ind := independentHMAC(c.secret, c.timestamp, c.apiKey, c.recvWindow, c.payload); got != ind {
			t.Errorf("%s: Sign() = %s disagrees with independent HMAC %s", c.name, got, ind)
		}
		if len(got) != 64 {
			t.Errorf("%s: signature is %d chars, want 64 hex chars", c.name, len(got))
		}
	}
}

func TestSignedRequestHeaders(t *testing.T) {
	b, stub := newStub(t, execution.MarketLinearPerp,
		ok(`{"category":"linear","list":[{"symbol":"BTCUSDT","bid1Price":"1","ask1Price":"2","lastPrice":"1.5"}]}`),
		ok(`{"orderId":"OID-1","orderLinkId":"cli-1"}`),
	)
	if _, err := b.GetTicker(t.Context(), "BTC/USDT"); err != nil {
		t.Fatalf("GetTicker: %v", err)
	}
	req := stub.reqs[0]
	wantSign := independentHMAC(testAPISecret, "1700000000000", testAPIKey, "5000", "category=linear&symbol=BTCUSDT")
	cases := []struct{ header, want string }{
		{"X-BAPI-API-Key", testAPIKey},
		{"X-BAPI-TIMESTAMP", "1700000000000"},
		{"X-BAPI-RECV-WINDOW", "5000"},
		{"X-BAPI-SIGN", wantSign},
	}
	for _, c := range cases {
		if got := req.Header.Get(c.header); got != c.want {
			t.Errorf("GET %s = %q, want %q", c.header, got, c.want)
		}
	}
	if ct := req.Header.Get("Content-Type"); ct != "" {
		t.Errorf("GET Content-Type = %q, want empty", ct)
	}
	if got := Sign(req.Header.Get("X-BAPI-TIMESTAMP"), testAPIKey, testAPISecret,
		req.Header.Get("X-BAPI-RECV-WINDOW"), "category=linear&symbol=BTCUSDT"); got != req.Header.Get("X-BAPI-SIGN") {
		t.Errorf("Sign() over the sent query does not reproduce the sent signature")
	}

	if _, err := b.CreateOrder(t.Context(), execution.OrderRequest{
		ClientOrderID: "cli-1", Symbol: "BTC/USDT", Side: execution.SideBuy,
		Quantity: "0.5", Price: "30000.5", OrderType: "limit",
		TimeInForce: execution.TIFGTC, Intent: execution.IntentOpen, ExecutionID: "exec-1",
	}); err != nil {
		t.Fatalf("CreateOrder: %v", err)
	}
	post := stub.reqs[1]
	body := stub.raws[1]
	if got := post.Header.Get("Content-Type"); got != "application/json" {
		t.Errorf("POST Content-Type = %q, want application/json", got)
	}
	if got, want := post.Header.Get("X-BAPI-SIGN"), independentHMAC(testAPISecret, "1700000000000", testAPIKey, "5000", body); got != want {
		t.Errorf("POST signature = %s, want %s (over raw body %q)", got, want, body)
	}
	if post.URL.RawQuery != "" {
		t.Errorf("POST query = %q, want empty (body-carrying request)", post.URL.RawQuery)
	}
}

func TestSymbolMappingOnFixtureCalls(t *testing.T) {
	b, stub := newStub(t, execution.MarketSpot,
		ok(`{"category":"spot","list":[{"symbol":"BTCUSDT","bid1Price":"1","ask1Price":"2","lastPrice":"1.5"}]}`),
		ok(`{"category":"spot","list":[{"orderId":"OID-2","orderLinkId":"cli-2","symbol":"BTCUSDT","side":"Buy","orderType":"Limit","price":"1","qty":"2","cumExecQty":"0","orderStatus":"New","createdTime":"1655890000000","updatedTime":"1655890001000"}]}`),
	)
	if _, err := b.GetTicker(t.Context(), "BTC/USDT"); err != nil {
		t.Fatalf("GetTicker: %v", err)
	}
	if q := stub.reqs[0].URL.Query().Get("symbol"); q != "BTCUSDT" {
		t.Errorf("GetTicker sent symbol %q, want BTCUSDT", q)
	}
	orders, err := b.GetOpenOrders(t.Context(), "BTC/USDT")
	if err != nil {
		t.Fatalf("GetOpenOrders: %v", err)
	}
	if q := stub.reqs[1].URL.Query().Get("symbol"); q != "BTCUSDT" {
		t.Errorf("GetOpenOrders sent symbol %q, want BTCUSDT", q)
	}
	if len(orders) != 1 || orders[0].Symbol != "BTC/USDT" {
		t.Errorf("venue symbol BTCUSDT did not round-trip to BTC/USDT: %+v", orders)
	}

	// Wire-form and unknown-quote symbols are refused, never guessed.
	refusals := []struct {
		symbol  string
		wantErr error
	}{
		{"BTCUSDT", exchanges.ErrInvalidSymbol},
		{"BTC/XYZ", exchanges.ErrUnknownQuote},
		{"", exchanges.ErrInvalidSymbol},
	}
	for _, c := range refusals {
		if _, err := b.GetTicker(t.Context(), c.symbol); !errors.Is(err, c.wantErr) {
			t.Errorf("GetTicker(%q) error = %v, want %v", c.symbol, err, c.wantErr)
		}
	}
}

func TestMapOrderStatusTable(t *testing.T) {
	cases := []struct {
		venue string
		want  execution.ChildOrderStatus
	}{
		{"New", execution.ChildOpen},
		{"PartiallyFilled", execution.ChildPartial},
		{"Filled", execution.ChildFilled},
		{"Cancelled", execution.ChildCancelled},
		{"Canceled", execution.ChildCancelled},
		{"Rejected", execution.ChildRejected},
		{"Deactivated", execution.ChildExpired},
		{"Untriggered", execution.ChildUnknown},
		{"Triggered", execution.ChildUnknown},
		{"Active", execution.ChildUnknown},
		{"", execution.ChildUnknown},
		{"SomethingNew", execution.ChildUnknown},
	}
	for _, c := range cases {
		if got := mapOrderStatus(c.venue); got != c.want {
			t.Errorf("mapOrderStatus(%q) = %q, want %q", c.venue, got, c.want)
		}
	}
}

func TestErrorClassificationFixtures(t *testing.T) {
	cases := []struct {
		name    string
		call    stubCall
		wantCat execution.ErrorCategory
	}{
		{"10004 invalid sign", fail(10004, "invalid sign"), execution.ErrPermissionError},
		{"10006 too many visits", fail(10006, "too many visits"), execution.ErrRateLimited},
		{"110004 insufficient balance", fail(110004, "wallet has insufficient balance"), execution.ErrInsufficientBalance},
		{"110001 order does not exist", fail(110001, "order does not exist"), execution.ErrInvalidOrder},
		{"http 429 with retCode 0", stubCall{status: 429, body: `{"retCode":0,"retMsg":"OK","result":{}}`}, execution.ErrRateLimited},
	}
	for _, c := range cases {
		b, _ := newStub(t, execution.MarketLinearPerp, c.call)
		_, err := b.GetBalance(t.Context())
		if err == nil {
			t.Errorf("%s: GetBalance() succeeded, want failure", c.name)
			continue
		}
		if got := exchanges.Classify(err).Category; got != c.wantCat {
			t.Errorf("%s: Classify().Category = %q, want %q", c.name, got, c.wantCat)
		}
		var ve *exchanges.VenueError
		if !errors.As(err, &ve) {
			t.Errorf("%s: error %v is not a *exchanges.VenueError", c.name, err)
			continue
		}
		if ve.Class.Category != c.wantCat {
			t.Errorf("%s: VenueError.Class.Category = %q, want %q", c.name, ve.Class.Category, c.wantCat)
		}
	}
}

func TestTransportFailureClassification(t *testing.T) {
	boom := errors.New("dial tcp: connection reset")
	b, _ := newStub(t, execution.MarketLinearPerp, stubCall{err: boom})
	_, err := b.GetBalance(t.Context())
	if err == nil {
		t.Fatal("GetBalance() succeeded over a failing transport")
	}
	if got := exchanges.Classify(err); got.Category != execution.ErrNetworkRetryable || !got.Retryable {
		t.Errorf("transport failure classified %+v, want network_retryable retryable", got)
	}
	if !errors.Is(err, boom) {
		t.Errorf("transport cause not unwrappable: %v", err)
	}
	if !strings.Contains(err.Error(), "category=") {
		t.Errorf("error %q misses the classification render", err.Error())
	}
}

func TestCreateOrderFixture(t *testing.T) {
	b, stub := newStub(t, execution.MarketLinearPerp,
		ok(`{"orderId":"OID-1","orderLinkId":"cli-1"}`),
		ok(`{"orderId":"OID-2","orderLinkId":"cli-2","orderStatus":"New"}`),
	)
	order, err := b.CreateOrder(t.Context(), execution.OrderRequest{
		ClientOrderID: "cli-1", Symbol: "BTC/USDT", Side: execution.SideBuy,
		Quantity: "0.001", Price: "30000.5", OrderType: "limit",
		TimeInForce: execution.TIFGTC, ReduceOnly: true, Intent: execution.IntentClose, ExecutionID: "exec-1",
	})
	if err != nil {
		t.Fatalf("CreateOrder: %v", err)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(stub.raws[0]), &body); err != nil {
		t.Fatalf("captured body not JSON: %v", err)
	}
	wantBody := map[string]any{
		"category": "linear", "symbol": "BTCUSDT", "side": "Buy", "orderType": "Limit",
		"qty": "0.001", "price": "30000.5", "timeInForce": "GTC", "reduceOnly": true,
		"orderLinkId": "cli-1",
	}
	for k, want := range wantBody {
		if got := body[k]; got != want {
			t.Errorf("body[%s] = %v (%T), want %v (%T)", k, got, got, want, want)
		}
	}
	if order.ExchangeOrderID != "OID-1" || order.ClientOrderID != "cli-1" {
		t.Errorf("ack ids not parsed: %+v", order)
	}
	// The create ack reports no status: honest UNKNOWN, never fabricated.
	if order.Status != execution.ChildUnknown {
		t.Errorf("ack status = %q, want UNKNOWN", order.Status)
	}
	if order.FilledQuantity != "0" || order.Quantity != "0.001" || order.Price == nil || *order.Price != "30000.5" {
		t.Errorf("decimal strings not preserved: %+v", order)
	}
	if !order.IsExit {
		t.Errorf("close intent not marked as exit: %+v", order)
	}

	second, err := b.CreateOrder(t.Context(), execution.OrderRequest{
		ClientOrderID: "cli-2", Symbol: "BTC/USDT", Side: execution.SideSell,
		Quantity: "0.5", OrderType: "market", TimeInForce: execution.TIFIOC,
		Intent: execution.IntentOpen, ExecutionID: "exec-2",
	})
	if err != nil {
		t.Fatalf("CreateOrder (market): %v", err)
	}
	if second.Status != execution.ChildOpen {
		t.Errorf("ack orderStatus New → %q, want OPEN", second.Status)
	}
	var marketBody map[string]any
	if err := json.Unmarshal([]byte(stub.raws[1]), &marketBody); err != nil {
		t.Fatalf("captured body not JSON: %v", err)
	}
	if _, present := marketBody["price"]; present {
		t.Errorf("market order must omit price, body has %v", marketBody["price"])
	}
}

func TestGetBalanceFixture(t *testing.T) {
	wallet := ok(`{"list":[{"accountType":"CONTRACT","totalEquity":"1234.5678","coin":[{"coin":"USDT","walletBalance":"0.3","availableToWithdraw":"0.1"}]}]}`)
	b, _ := newStub(t, execution.MarketLinearPerp, wallet)
	eq, err := b.GetBalance(t.Context())
	if err != nil {
		t.Fatalf("GetBalance: %v", err)
	}
	if eq.FuturesEquity == nil || *eq.FuturesEquity != "1234.5678" {
		t.Errorf("FuturesEquity = %v, want 1234.5678", eq.FuturesEquity)
	}
	if eq.SpotEquity != nil {
		t.Errorf("SpotEquity = %v on a linear adapter, want honest nil", *eq.SpotEquity)
	}
	if eq.TotalEquity == nil || *eq.TotalEquity != "1234.5678" {
		t.Errorf("TotalEquity = %v, want 1234.5678", eq.TotalEquity)
	}
	if eq.Timestamp != testMillis {
		t.Errorf("Timestamp = %d, want %d", eq.Timestamp, testMillis)
	}
	if len(eq.Balances) != 1 {
		t.Fatalf("balances = %+v, want one row", eq.Balances)
	}
	row := eq.Balances[0]
	// 0.3 - 0.1 must be exact decimal "0.2" (float64 would yield 0.1999999…).
	if row.Asset != "USDT" || row.Total != "0.3" || row.Free != "0.1" || row.Used != "0.2" {
		t.Errorf("balance row = %+v, want USDT free=0.1 used=0.2 total=0.3", row)
	}

	spotWallet := ok(`{"list":[{"accountType":"UNIFIED","totalEquity":"42.25","coin":[]}]}`)
	sb, _ := newStub(t, execution.MarketSpot, spotWallet)
	sEq, err := sb.GetBalance(t.Context())
	if err != nil {
		t.Fatalf("GetBalance (spot): %v", err)
	}
	if sEq.SpotEquity == nil || *sEq.SpotEquity != "42.25" || sEq.FuturesEquity != nil {
		t.Errorf("spot equity = %+v, want SpotEquity=42.25 FuturesEquity=nil", sEq)
	}
}

func TestGetFillsFixture(t *testing.T) {
	fillsBody := ok(`{"list":[
		{"execId":"T-1","orderId":"OID-1","orderLinkId":"cli-1","price":"0.1","execQty":"0.3","execFee":"-0.0005","feeCurrency":"USDT","execTime":"1655890000000"},
		{"execId":"T-2","orderId":"OID-2","orderLinkId":"","price":"2","execQty":"5","execFee":"0.001","execTime":"1655890001000"}
	]}`)
	b, _ := newStub(t, execution.MarketLinearPerp, fillsBody)
	fills, err := b.GetFills(t.Context(), "BTC/USDT")
	if err != nil {
		t.Fatalf("GetFills: %v", err)
	}
	if len(fills) != 2 {
		t.Fatalf("fills = %+v, want 2 rows", fills)
	}
	f := fills[0]
	if f.ExchangeTradeID != "T-1" || f.ClientOrderID != "cli-1" || f.Timestamp != 1655890000000 {
		t.Errorf("fill identity = %+v", f)
	}
	// 0.1 × 0.3 must be exact "0.03" (float64 gives 0.030000000000000002).
	if f.Price != "0.1" || f.Quantity != "0.3" || f.QuoteQuantity != "0.03" {
		t.Errorf("fill amounts = %+v, want price 0.1 qty 0.3 quote 0.03", f)
	}
	// Paid fee normalized to magnitude; explicit fee asset honored.
	if f.Fee != "0.0005" || f.FeeAsset != "USDT" {
		t.Errorf("fill fee = %+v, want 0.0005 USDT", f)
	}
	g := fills[1]
	if g.FeeAsset != "USDT" {
		t.Errorf("missing feeCurrency → %q, want USDT fallback", g.FeeAsset)
	}
	if g.ClientOrderID != "" || g.QuoteQuantity != "10" {
		t.Errorf("second fill = %+v, want quote 10 and empty client id", g)
	}
}

func TestGetPositionFixture(t *testing.T) {
	long := ok(`{"list":[{"positionIdx":0,"tradeMode":0,"symbol":"BTCUSDT","side":"Buy","size":"0.5","avgPrice":"30000.5","leverage":"10","liqPrice":"21000.25"}]}`)
	short := ok(`{"list":[{"positionIdx":0,"tradeMode":1,"symbol":"BTCUSDT","side":"Sell","size":"1.25","avgPrice":"30000.5","leverage":"5","liqPrice":""}]}`)
	flat := ok(`{"list":[{"positionIdx":0,"tradeMode":0,"symbol":"BTCUSDT","side":"Buy","size":"0","avgPrice":"","leverage":"10","liqPrice":""}]}`)
	empty := ok(`{"list":[]}`)

	b, _ := newStub(t, execution.MarketLinearPerp, long, short, flat, empty)
	pos, err := b.GetPosition(t.Context(), "BTC/USDT")
	if err != nil {
		t.Fatalf("GetPosition (long): %v", err)
	}
	if pos.Quantity != "0.5" || pos.Side != execution.SideBuy || pos.PositionSide != "net" {
		t.Errorf("long position = %+v, want +0.5 buy net", pos)
	}
	if pos.EntryPrice != "30000.5" || pos.Symbol != "BTC/USDT" || pos.MarketType != execution.MarketLinearPerp {
		t.Errorf("position fields = %+v", pos)
	}
	if pos.Leverage == nil || *pos.Leverage != "10" || pos.LiquidationPrice == nil || *pos.LiquidationPrice != "21000.25" {
		t.Errorf("position figures = %+v", pos)
	}
	if pos.MarginMode == nil || *pos.MarginMode != execution.MarginCross {
		t.Errorf("tradeMode 0 → %+v, want cross", pos.MarginMode)
	}

	spos, err := b.GetPosition(t.Context(), "BTC/USDT")
	if err != nil {
		t.Fatalf("GetPosition (short): %v", err)
	}
	// One-way semantics: Sell → negative quantity; isolated via tradeMode 1.
	if spos.Quantity != "-1.25" || spos.Side != execution.SideSell {
		t.Errorf("short position = %+v, want -1.25 sell", spos)
	}
	if spos.MarginMode == nil || *spos.MarginMode != execution.MarginIsolated {
		t.Errorf("tradeMode 1 → %+v, want isolated", spos.MarginMode)
	}
	if spos.LiquidationPrice != nil {
		t.Errorf("empty liqPrice → %v, want honest nil", *spos.LiquidationPrice)
	}

	for i, name := range []string{"flat row", "empty list"} {
		_ = i
		if _, err := b.GetPosition(t.Context(), "BTC/USDT"); !errors.Is(err, exchanges.ErrNoPosition) {
			t.Errorf("GetPosition (%s) error = %v, want ErrNoPosition", name, err)
		}
	}
}

func TestGetTickerFixture(t *testing.T) {
	full := ok(`{"category":"linear","list":[{"symbol":"BTCUSDT","bid1Price":"30000.1","ask1Price":"30000.2","lastPrice":"30000.15"}]}`)
	thin := ok(`{"category":"linear","list":[{"symbol":"BTCUSDT","bid1Price":"","ask1Price":"","lastPrice":"30000.15"}]}`)
	b, _ := newStub(t, execution.MarketLinearPerp, full, thin, ok(`{"category":"linear","list":[]}`))

	tk, err := b.GetTicker(t.Context(), "BTC/USDT")
	if err != nil {
		t.Fatalf("GetTicker: %v", err)
	}
	if tk.Bid == nil || *tk.Bid != "30000.1" || tk.Ask == nil || *tk.Ask != "30000.2" || tk.Last == nil || *tk.Last != "30000.15" {
		t.Errorf("ticker = %+v", tk)
	}
	if tk.Ts != testMillis {
		t.Errorf("Ts = %d, want clock %d", tk.Ts, testMillis)
	}

	tk, err = b.GetTicker(t.Context(), "BTC/USDT")
	if err != nil {
		t.Fatalf("GetTicker (thin): %v", err)
	}
	if tk.Bid != nil || tk.Ask != nil {
		t.Errorf("empty touch prices → %+v, want honest nils", tk)
	}
	if _, err := b.GetTicker(t.Context(), "BTC/USDT"); !errors.Is(err, exchanges.ErrInvalidSymbol) {
		t.Errorf("missing ticker row error = %v, want refusal", err)
	}
}

func TestGetAccountFixture(t *testing.T) {
	full := ok(`{"note":"main bot","readOnly":0,"permissions":["Spot.Order","Contract.*","Wallet.Withdraw"]}`)
	quiet := ok(`{"note":"","readOnly":0}`)
	readOnly := ok(`{"note":"watcher","readOnly":1,"permissions":[]}`)

	b, _ := newStub(t, execution.MarketLinearPerp, full, quiet, readOnly)
	meta, err := b.GetAccount(t.Context())
	if err != nil {
		t.Fatalf("GetAccount: %v", err)
	}
	if meta.Exchange != execution.ExchangeBybit || meta.Health != execution.HealthActive {
		t.Errorf("meta identity = %+v", meta)
	}
	if meta.APIKeyMasked == nil || *meta.APIKeyMasked != "tes...001" {
		t.Errorf("APIKeyMasked = %v, want tes...001", meta.APIKeyMasked)
	}
	if meta.Label == nil || *meta.Label != "main bot" {
		t.Errorf("Label = %v, want note", meta.Label)
	}
	if !meta.Permissions.Read || meta.Permissions.SpotTrade == nil || !*meta.Permissions.SpotTrade ||
		meta.Permissions.FuturesTrade == nil || !*meta.Permissions.FuturesTrade ||
		meta.Permissions.Withdraw == nil || !*meta.Permissions.Withdraw {
		t.Errorf("permissions = %+v, want all reported grants", meta.Permissions)
	}

	meta, err = b.GetAccount(t.Context())
	if err != nil {
		t.Fatalf("GetAccount (quiet): %v", err)
	}
	if !meta.Permissions.Read {
		t.Errorf("quiet key: Read = false, want true")
	}
	// The venue reported no permission list: honest nils, never inferred.
	if meta.Permissions.SpotTrade != nil || meta.Permissions.FuturesTrade != nil || meta.Permissions.Withdraw != nil {
		t.Errorf("quiet key: permissions = %+v, want nil trade/withdraw", meta.Permissions)
	}

	meta, err = b.GetAccount(t.Context())
	if err != nil {
		t.Fatalf("GetAccount (readOnly): %v", err)
	}
	if meta.Permissions.Read {
		t.Errorf("readOnly key: Read = true, want false")
	}
	if meta.Permissions.SpotTrade == nil || *meta.Permissions.SpotTrade != false {
		t.Errorf("readOnly key: SpotTrade = %v, want reported false", meta.Permissions.SpotTrade)
	}

	// Auth failure: health is the strict validation verdict, error travels too.
	authFail := fail(10004, "invalid sign")
	ab, _ := newStub(t, execution.MarketLinearPerp, authFail)
	meta, err = ab.GetAccount(t.Context())
	if err == nil {
		t.Fatal("GetAccount over an invalid sign must fail")
	}
	if meta.Health != execution.HealthPermissionError {
		t.Errorf("auth failure health = %q, want PERMISSION_ERROR", meta.Health)
	}
}

func TestGetOrderHistoryFallback(t *testing.T) {
	notFound := fail(110001, "order does not exist")
	historyRow := ok(`{"list":[{"orderId":"OID-9","orderLinkId":"cli-9","symbol":"BTCUSDT","side":"Buy","orderType":"Limit","price":"1","qty":"2","cumExecQty":"2","orderStatus":"Filled","createdTime":"1655890000000","updatedTime":"1655890009000"}]}`)

	b, stub := newStub(t, execution.MarketLinearPerp, notFound, historyRow)
	order, err := b.GetOrder(t.Context(), "BTC/USDT", "OID-9")
	if err != nil {
		t.Fatalf("GetOrder: %v", err)
	}
	if got := stub.reqs[0].URL.Path; got != "/v5/order/realtime" {
		t.Errorf("first query path = %q, want /v5/order/realtime", got)
	}
	if got := stub.reqs[1].URL.Path; got != "/v5/order/history" {
		t.Errorf("fallback query path = %q, want /v5/order/history", got)
	}
	if order.ExchangeOrderID != "OID-9" || order.Status != execution.ChildFilled ||
		order.FilledQuantity != "2" || order.Symbol != "BTC/USDT" || order.IsExit {
		t.Errorf("history order = %+v", order)
	}
	if order.SubmittedAt != 1655890000000 || order.UpdatedAt != 1655890009000 {
		t.Errorf("order timestamps = %+v", order)
	}

	// Both views unknown → ErrOrderNotFound, with the venue error preserved.
	b2, _ := newStub(t, execution.MarketLinearPerp, notFound, notFound)
	_, err = b2.GetOrder(t.Context(), "BTC/USDT", "OID-404")
	if !errors.Is(err, exchanges.ErrOrderNotFound) {
		t.Errorf("GetOrder(unknown) error = %v, want ErrOrderNotFound", err)
	}
	var ve *exchanges.VenueError
	if !errors.As(err, &ve) || ve.Code != "110001" {
		t.Errorf("GetOrder(unknown) lost the venue error: %v", err)
	}
}

func TestGetOpenOrdersFixture(t *testing.T) {
	list := ok(`{"list":[
		{"orderId":"OID-1","orderLinkId":"cli-1","symbol":"BTCUSDT","side":"Buy","orderType":"Limit","price":"1","qty":"2","cumExecQty":"0.5","orderStatus":"PartiallyFilled","reduceOnly":true,"createdTime":"1655890000000","updatedTime":"1655890001000"},
		{"orderId":"OID-2","orderLinkId":"cli-2","symbol":"BTCUSDT","side":"Sell","orderType":"Market","price":"","qty":"3","cumExecQty":"","orderStatus":"Whatever","createdTime":"","updatedTime":""}
	]}`)
	b, _ := newStub(t, execution.MarketLinearPerp, list)
	orders, err := b.GetOpenOrders(t.Context(), "BTC/USDT")
	if err != nil {
		t.Fatalf("GetOpenOrders: %v", err)
	}
	if len(orders) != 2 {
		t.Fatalf("orders = %+v, want 2", orders)
	}
	o := orders[0]
	if o.Status != execution.ChildPartial || o.FilledQuantity != "0.5" || !o.IsExit {
		t.Errorf("order 1 = %+v", o)
	}
	p := orders[1]
	if p.Status != execution.ChildUnknown || p.FilledQuantity != "0" || p.Type != "market" {
		t.Errorf("order 2 = %+v, want UNKNOWN/0/market", p)
	}
	// Missing timestamps fall back to the read instant (parity with TS mapOrder).
	if p.SubmittedAt != testMillis || p.UpdatedAt != testMillis {
		t.Errorf("order 2 timestamps = %+v, want %d", p, testMillis)
	}
}

func TestCancelOrderFixture(t *testing.T) {
	b, stub := newStub(t, execution.MarketLinearPerp, ok(`{"orderId":"OID-1","orderLinkId":"cli-1"}`))
	order, err := b.CancelOrder(t.Context(), "BTC/USDT", "OID-1")
	if err != nil {
		t.Fatalf("CancelOrder: %v", err)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(stub.raws[0]), &body); err != nil {
		t.Fatalf("captured body not JSON: %v", err)
	}
	if body["orderId"] != "OID-1" || body["symbol"] != "BTCUSDT" || body["category"] != "linear" {
		t.Errorf("cancel body = %v", body)
	}
	if order.ExchangeOrderID != "OID-1" || order.ClientOrderID != "cli-1" || order.Status != execution.ChildCancelled {
		t.Errorf("cancel ack = %+v", order)
	}
	if order.Quantity != "" || order.Side != "" {
		t.Errorf("cancel ack fabricated unreported fields: %+v", order)
	}
}

func TestInvalidInputRefusals(t *testing.T) {
	b, _ := newStub(t, execution.MarketLinearPerp) // no calls are made
	base := execution.OrderRequest{
		ClientOrderID: "cli-1", Symbol: "BTC/USDT", Side: execution.SideBuy,
		Quantity: "0.5", OrderType: "market", TimeInForce: execution.TIFGTC,
		Intent: execution.IntentOpen, ExecutionID: "exec-1",
	}
	cases := []struct {
		name   string
		mutate func(*execution.OrderRequest)
	}{
		{"missing client order id", func(r *execution.OrderRequest) { r.ClientOrderID = "" }},
		{"missing quantity", func(r *execution.OrderRequest) { r.Quantity = "" }},
		{"non-decimal quantity", func(r *execution.OrderRequest) { r.Quantity = "0.5x" }},
		{"unknown side", func(r *execution.OrderRequest) { r.Side = "hold" }},
		{"unknown order type", func(r *execution.OrderRequest) { r.OrderType = "stop" }},
		{"limit without price", func(r *execution.OrderRequest) { r.OrderType = "limit"; r.Price = "" }},
		{"non-decimal price", func(r *execution.OrderRequest) { r.OrderType = "limit"; r.Price = "one dollar" }},
		{"unknown time in force", func(r *execution.OrderRequest) { r.TimeInForce = "GTD" }},
		{"bad symbol", func(r *execution.OrderRequest) { r.Symbol = "BTCUSDT" }},
		{"unknown quote", func(r *execution.OrderRequest) { r.Symbol = "BTC/XYZ" }},
	}
	for _, c := range cases {
		req := base
		c.mutate(&req)
		if _, err := b.CreateOrder(t.Context(), req); !errors.Is(err, exchanges.ErrInvalidOrder) &&
			!errors.Is(err, exchanges.ErrInvalidSymbol) && !errors.Is(err, exchanges.ErrUnknownQuote) {
			t.Errorf("CreateOrder(%s) error = %v, want a named refusal", c.name, err)
		}
	}
	if _, err := b.CancelOrder(t.Context(), "BTC/USDT", ""); !errors.Is(err, exchanges.ErrInvalidOrder) {
		t.Errorf("CancelOrder(empty id) error = %v, want ErrInvalidOrder", err)
	}
	if _, err := b.GetOrder(t.Context(), "BTC/USDT", ""); !errors.Is(err, exchanges.ErrInvalidOrder) {
		t.Errorf("GetOrder(empty id) error = %v, want ErrInvalidOrder", err)
	}
}

func TestSecretHygiene(t *testing.T) {
	// A refusal whose message tempts the naive logger with raw detail.
	leaky := fail(10004, "invalid sign\nraw: X-BAPI-SIGN=deadbeef "+testAPISecret)
	b, stub := newStub(t, execution.MarketLinearPerp, leaky, ok(`{"orderId":"OID-1","orderLinkId":"cli-1"}`))
	_, err := b.GetBalance(t.Context())
	if err == nil {
		t.Fatal("expected a venue failure")
	}
	msg := err.Error()
	for _, secret := range []string{testAPISecret, "\n"} {
		if strings.Contains(msg, secret) {
			t.Errorf("error message leaked %q: %q", secret, msg)
		}
	}

	if _, err := b.CreateOrder(t.Context(), execution.OrderRequest{
		ClientOrderID: "cli-1", Symbol: "BTC/USDT", Side: execution.SideBuy,
		Quantity: "0.5", Price: "30000.5", OrderType: "limit",
		TimeInForce: execution.TIFGTC, Intent: execution.IntentOpen, ExecutionID: "exec-1",
	}); err != nil {
		t.Fatalf("CreateOrder: %v", err)
	}
	req := stub.reqs[1]
	raw := stub.raws[1] + req.URL.String()
	for name, values := range req.Header {
		raw += name + strings.Join(values, ",")
	}
	if strings.Contains(raw, testAPISecret) {
		t.Errorf("secret reached the wire: %q", raw)
	}
}

package coinank

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// TestIntervalAllowlist is the guard against CoinAnk's quietest failure mode.
//
// An unsupported interval does NOT produce an error upstream: it produces HTTP
// 200 with the same 10-exchange row set and totalTurnover=0 on every row
// (measured: 8h, 24h, 7d, 30d, "1H", "bogus" -> 1636 B, all-zero). A pass-through
// endpoint would render that as a confident "no liquidations happened" table. The
// accepted set is therefore enforced locally.
func TestIntervalAllowlist(t *testing.T) {
	accepted := []string{"1h", "2h", "4h", "6h", "12h", "1d"}
	for _, iv := range accepted {
		if !ValidInterval(iv) {
			t.Errorf("interval %q was measured to return real data but is rejected", iv)
		}
	}
	// Values measured to return an all-zero table.
	zeroTrap := []string{"8h", "24h", "7d", "30d", "1H", "bogus", "1D", "12H"}
	for _, iv := range zeroTrap {
		if ValidInterval(iv) {
			t.Errorf("interval %q returns an all-zero table upstream and must be rejected locally, not sent", iv)
		}
	}
	// Hostile / malformed input must not reach upstream as a query fragment.
	for _, iv := range []string{"", " ", "1h ", "1h&interval=1d", "1h%00", "../1d", "1h'", "1h\n"} {
		if ValidInterval(iv) {
			t.Errorf("interval %q must be rejected", iv)
		}
	}
	if len(Intervals) != len(accepted) {
		t.Errorf("Intervals table drifted: %v", Intervals)
	}
}

// TestDefaultIntervalMatchesUpstreamDefault records WHY 1h is the default: an
// omitted interval and interval=1h returned byte-identical bodies when measured.
// It is still sent explicitly — relying on an undocumented upstream default is an
// invisible dependency.
func TestDefaultIntervalMatchesUpstreamDefault(t *testing.T) {
	if DefaultInterval != "1h" {
		t.Fatalf("DefaultInterval = %q; re-measure the omitted-interval body before changing it", DefaultInterval)
	}
	if !ValidInterval(DefaultInterval) {
		t.Fatal("the default must itself be an accepted value")
	}
	if got, want := UpstreamURL("liquidation", ""), Base+"/api/liquidation/allExchange?interval=1h"; got != want {
		t.Errorf("omitted interval\n got %s\nwant %s (explicit, never implicit)", got, want)
	}
}

// TestAcceptsRejectsNoOpParams: a param upstream ignores must not be accepted,
// because accepting it advertises behaviour the request does not have.
func TestAcceptsRejectsNoOpParams(t *testing.T) {
	// Measured no-ops: symbol/baseCoin on fundingRate (byte-identical 1,851,245 B
	// body, still 882 rows) and pageNum/pageSize on whales (identical body hash
	// across pageNum=1 vs 2).
	noops := []struct{ mode, param string }{
		{"fundingRate", "symbol"},
		{"fundingRate", "baseCoin"},
		{"whales", "pageNum"},
		{"whales", "pageSize"},
		{"etf", "symbol"},
		{"longShort", "symbol"},
	}
	for _, c := range noops {
		if Accepts(c.mode, c.param) {
			t.Errorf("mode=%s accepts %q, but upstream ignores it — a no-op param is a lie", c.mode, c.param)
		}
	}
	// interval is scoped to exactly one mode.
	for _, m := range Modes {
		want := m == "liquidation"
		if got := Accepts(m, ParamInterval); got != want {
			t.Errorf("Accepts(%q, interval) = %v, want %v", m, got, want)
		}
	}
	// mode and fresh are universal.
	for _, m := range Modes {
		if !Accepts(m, ParamMode) || !Accepts(m, ParamFresh) {
			t.Errorf("mode=%s must accept mode and fresh", m)
		}
	}
	if Accepts("fundingRate", "nope") {
		t.Error("an unknown param name must not be accepted")
	}
}

func TestKnownAndModeCount(t *testing.T) {
	for _, m := range Modes {
		if !Known(m) {
			t.Errorf("mode %q missing from the known set", m)
		}
	}
	if Known("") || Known("STATISTICS") || Known("fundingrate") {
		t.Error("mode matching must be exact and case-sensitive")
	}
	if ModeCount != len(Modes) || ModeCount != 5 {
		t.Errorf("ModeCount = %d, want 5 (Modes=%v)", ModeCount, Modes)
	}
}

// TestUpstreamURLsAreKeyless is the invariant behind the whole family: every mode
// resolves to the dashboard host, which needs no issued key. A URL pointing at
// open-api.coinank.com would silently require a credential we do not have, and it
// would fail as a 401 rather than as anything that names the mistake.
func TestUpstreamURLsAreKeyless(t *testing.T) {
	for _, m := range Modes {
		u := UpstreamURL(m, "1h")
		if !strings.HasPrefix(u, Base+"/api/") {
			t.Errorf("mode=%s URL %s is not on the keyless host %s", m, u, Base)
		}
		if strings.Contains(u, "open-api") {
			t.Errorf("mode=%s URL %s points at the DOCUMENTED host, which requires an issued apikey", m, u)
		}
		if strings.Contains(u, "apikey") || strings.Contains(u, "api_key") {
			t.Errorf("mode=%s URL %s carries a key in the query string", m, u)
		}
	}
	if got, want := UpstreamURL("whales", "1d"), Base+"/api/hyper/topPosition"; got != want {
		t.Errorf("a mode with no interval must ignore the argument: got %s", got)
	}
	if got, want := UpstreamURL("liquidation", "6h"), Base+"/api/liquidation/allExchange?interval=6h"; got != want {
		t.Errorf("liquidation URL\n got %s\nwant %s", got, want)
	}
	if got := UpstreamURL("unknown-mode", "1h"); !strings.HasPrefix(got, Base) {
		t.Errorf("an unknown mode must still resolve to a base-prefixed URL: %s", got)
	}
}

func newTestService(t *testing.T, d Doer) *Service {
	t.Helper()
	return &Service{F: newTestFetcher(t, d)}
}

// TestEnvelopeCountsArraysOnly: `upstreamCount` must be ABSENT for an object
// payload rather than 0. Reporting 0 would assert a measurement upstream never
// made — the "sparse renders as 0" failure this codebase forbids.
func TestEnvelopeCountsArraysOnly(t *testing.T) {
	svc := newTestService(t, &fakeDoer{status: 200, body: fundingBody})
	env, err := svc.Envelope(context.Background(), "fundingRate", "", false)
	if err != nil {
		t.Fatalf("Envelope: %v", err)
	}
	if env.UpstreamCount == nil {
		t.Fatal("an array payload must carry upstreamCount")
	}
	if *env.UpstreamCount != 2 {
		t.Errorf("upstreamCount = %d, want 2", *env.UpstreamCount)
	}
	if env.Kind != "fundingRate" || !strings.HasPrefix(env.Upstream, Base) {
		t.Errorf("provenance wrong: kind=%q upstream=%q", env.Kind, env.Upstream)
	}
	if env.Auth != AuthNote {
		t.Errorf("auth = %q, want %q", env.Auth, AuthNote)
	}
	if !strings.Contains(env.Derived, "2 rows") {
		t.Errorf("derived must state the row count, got %q", env.Derived)
	}
	// `data` is upstream verbatim.
	var rows []map[string]interface{}
	if err := json.Unmarshal(env.Data, &rows); err != nil {
		t.Fatalf("data is not the upstream array: %v", err)
	}
	if len(rows) != 2 || rows[0]["symbol"] != "BTC" {
		t.Errorf("data was re-shaped: %v", rows)
	}

	// Object payload.
	svc = newTestService(t, &fakeDoer{status: 200,
		body: `{"success":true,"code":"1","data":{"list":[{"address":"0xabc"}],"pagination":{"total":1484}}}`})
	env, err = svc.Envelope(context.Background(), "whales", "", false)
	if err != nil {
		t.Fatalf("Envelope(whales): %v", err)
	}
	if env.UpstreamCount != nil {
		t.Errorf("an object payload must leave upstreamCount absent, got %d", *env.UpstreamCount)
	}
	if !strings.Contains(env.Derived, "object") {
		t.Errorf("derived should say the payload is an object, got %q", env.Derived)
	}
}

// TestEnvelopeEchoesEffectiveInterval: the handler defaults the interval, so the
// body must state which value actually reached upstream.
func TestEnvelopeEchoesEffectiveInterval(t *testing.T) {
	body := `{"success":true,"code":"1","data":[{"exchangeName":"ALL","totalTurnover":13445415.7}]}`
	svc := newTestService(t, &fakeDoer{status: 200, body: body})

	env, err := svc.Envelope(context.Background(), "liquidation", "", false)
	if err != nil {
		t.Fatalf("Envelope: %v", err)
	}
	if env.Interval != "1h" {
		t.Errorf("interval echo = %q, want the applied default 1h", env.Interval)
	}
	if !strings.Contains(env.Upstream, "interval=1h") {
		t.Errorf("upstream URL should carry the explicit interval: %s", env.Upstream)
	}

	env, err = svc.Envelope(context.Background(), "liquidation", "6h", true)
	if err != nil {
		t.Fatalf("Envelope(6h): %v", err)
	}
	if env.Interval != "6h" || !strings.Contains(env.Upstream, "interval=6h") {
		t.Errorf("interval not propagated: echo=%q url=%s", env.Interval, env.Upstream)
	}

	// A mode with no interval must not invent the field.
	env, err = svc.Envelope(context.Background(), "fundingRate", "6h", false)
	if err != nil {
		t.Fatalf("Envelope(fundingRate): %v", err)
	}
	if env.Interval != "" {
		t.Errorf("fundingRate must not echo an interval it does not take, got %q", env.Interval)
	}
}

// TestEnvelopeRefusalPropagates: upstream's refusal must reach the caller with
// its own code and message so the handler can answer 502 — never a 200 with
// data:null.
func TestEnvelopeRefusalPropagates(t *testing.T) {
	svc := newTestService(t, &fakeDoer{status: 200, body: refusalBody})
	_, err := svc.Envelope(context.Background(), "longShort", "", false)
	var he *HardError
	if !errors.As(err, &he) || he.Kind != "upstream" {
		t.Fatalf("want an upstream HardError, got %T: %v", err, err)
	}
	if !strings.Contains(he.Detail, "system error!") {
		t.Errorf("detail must carry upstream's message, got %q", he.Detail)
	}
}

// TestEnvelopeNullDataIsAnError: success:true with data:null is still no
// measurement. Shipping it with upstreamCount=0 would fabricate a measurement.
func TestEnvelopeNullDataIsAnError(t *testing.T) {
	svc := newTestService(t, &fakeDoer{status: 200,
		body: `{"success":true,"code":"1","msg":null,"data":null}`})
	_, err := svc.Envelope(context.Background(), "etf", "", false)
	if err == nil {
		t.Fatal("success:true with null data must be an error")
	}
	var he *HardError
	if !errors.As(err, &he) || he.Kind != "non-json" {
		t.Fatalf("want a non-json HardError, got %T: %v", err, err)
	}
	if !strings.Contains(he.Detail, "null") {
		t.Errorf("detail should name the null payload, got %q", he.Detail)
	}
}

func TestUnexpectedParamDetail(t *testing.T) {
	got := UnexpectedParamDetail("symbol", "etf")
	if !strings.Contains(got, "symbol") || !strings.Contains(got, "etf") {
		t.Errorf("detail must name both the param and the mode: %q", got)
	}
	if !strings.Contains(DetailIntervalInvalid, "1h") || !strings.Contains(DetailIntervalInvalid, "1d") {
		t.Errorf("the interval error must list the accepted values: %q", DetailIntervalInvalid)
	}
	if !strings.Contains(DetailIntervalInvalid, "all-zero") {
		t.Errorf("the interval error should explain why it is rejected locally: %q", DetailIntervalInvalid)
	}
}

// TestTTLForPerModeAndFallback pins the per-mode cache TTLs and the fallback
// rule: an unclaimed path gets the caller's fallback (the SHORT default), never
// the longest per-mode value.
func TestTTLForPerModeAndFallback(t *testing.T) {
	cases := map[string]int{
		Base + "/api/fundingRate/current":                 300,
		Base + "/api/liquidation/allExchange?interval=1h": 300,
		Base + "/api/liquidation/allExchange?interval=1d": 300,
		Base + "/api/longshort/all":                       900,
		Base + "/api/etf/etfInflow":                       3600,
		Base + "/api/hyper/topPosition":                   300,
	}
	for u, want := range cases {
		if got := TTLFor(u, 60); got != want {
			t.Errorf("TTLFor(%s) = %d, want %d", u, got, want)
		}
	}
	if got := TTLFor(Base+"/api/nope", 60); got != 60 {
		t.Errorf("unknown path fallback = %d, want 60", got)
	}
}

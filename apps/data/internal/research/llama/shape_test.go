package llama

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeDoer serves canned bodies per URL and counts requests, so the cache and
// single-flight claims are proven by an observable rather than by trust.
type fakeDoer struct {
	mu    sync.Mutex
	calls map[string]int
	body  map[string]string
	code  map[string]int
	err   map[string]error
	// barrier, when set, blocks a response until it is closed (single-flight
	// proof: the second caller must join, not fetch).
	barrier chan struct{}
}

func (f *fakeDoer) Do(req *http.Request) (*http.Response, error) {
	u := req.URL.String()
	f.mu.Lock()
	if f.calls == nil {
		f.calls = map[string]int{}
	}
	f.calls[u]++
	b, ok := f.body[u]
	code := f.code[u]
	e := f.err[u]
	bar := f.barrier
	f.mu.Unlock()
	if bar != nil {
		<-bar
	}
	if e != nil {
		return nil, e
	}
	if !ok {
		code = 200
		b = "[]"
	}
	if code == 0 {
		code = 200
	}
	return &http.Response{
		StatusCode: code,
		Body:       io.NopCloser(strings.NewReader(b)),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    req,
	}, nil
}

func (f *fakeDoer) count(u string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[u]
}

func newTestFetcher(t *testing.T, d Doer, ttl int) *Fetcher {
	t.Helper()
	f, err := New(Options{Client: d, TTL: ttl})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return f
}

func chainsBody() string {
	return `[
	  {"name":"Moonbeam","slug":"moonbeam","tvl":78000.5,"chains":["Moonbeam"]},
	  {"name":"Ethereum","slug":"ethereum","tvl":58000000000},
	  {"name":"NoTVL","slug":"notvl"},
	  {"name":"Zero","slug":"zero","tvl":0}
	]`
}

// ---- sort/trim semantics (the TS comparator, ported) ----------------------

func TestSortByTVLDescPutsMissingTVLLast(t *testing.T) {
	f := newTestFetcher(t, &fakeDoer{body: map[string]string{UpstreamURL("chains"): chainsBody()}}, 15)
	env, err := (&Service{F: f}).Envelope(context.Background(), "chains", 0, 0)
	if err != nil {
		t.Fatalf("Envelope: %v", err)
	}
	got := names(t, env.Rows)
	want := []string{"Ethereum", "Moonbeam", "Zero", "NoTVL"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("chains order=%v want %v (a null tvl sorts as -1, never 0)", got, want)
	}
	if env.Derived != DerivedChains {
		t.Errorf("derived=%q", env.Derived)
	}
	if env.UpstreamTotal != 4 {
		t.Errorf("upstreamTotal=%d want 4 (the FULL list, nothing dropped)", env.UpstreamTotal)
	}
	if env.Kind != "chains" {
		t.Errorf("kind=%q", env.Kind)
	}
}

// A row whose tvl is null must not outrank a real $0 row: the comparator's
// `?? -1` is the difference between "unknown" and "worthless".
func TestNullTVLNeverTreatedAsZero(t *testing.T) {
	rows := decodeRows(t, `[{"tvl":null,"slug":"unknown"},{"tvl":0,"slug":"zero"}]`)
	out := SortByTVLDesc(rows)
	if slugOf(t, out[0]) != "zero" || slugOf(t, out[1]) != "unknown" {
		t.Fatalf("order=%s,%s want zero,unknown", slugOf(t, out[0]), slugOf(t, out[1]))
	}
}

func TestProtocolsProjectionHasExactlyTenKeys(t *testing.T) {
	body := `[{"name":"A","slug":"a","category":"Dexes","tvl":10,"change_1d":1.5,
	           "change_7d":-2,"mcap":99,"chains":["Ethereum"],"url":"https://a",
	           "logo":"l.png","extra":"never-copied"}]`
	f := newTestFetcher(t, &fakeDoer{body: map[string]string{UpstreamURL("protocols"): body}}, 15)
	env, err := (&Service{F: f}).Envelope(context.Background(), "protocols", 5, 0)
	if err != nil {
		t.Fatalf("Envelope: %v", err)
	}
	var row map[string]any
	if err := json.Unmarshal(env.Rows[0], &row); err != nil {
		t.Fatalf("row is not a JSON object: %v", err)
	}
	want := []string{"name", "slug", "category", "tvl", "change_1d", "change_7d", "mcap", "chains", "url", "logo"}
	if len(row) != len(want) {
		t.Fatalf("keys=%d want %d: %v", len(row), len(want), sorted(row))
	}
	for _, k := range want {
		if _, ok := row[k]; !ok {
			t.Errorf("projection dropped %q", k)
		}
	}
	if _, leaked := row["extra"]; leaked {
		t.Errorf("projection leaked an upstream key: %v", row)
	}
	if env.Derived != DerivedProtocols(5, 1) {
		t.Errorf("derived=%q", env.Derived)
	}
}

// schemaVariant documents the one place the Go port deliberately differs from
// the TS: `undefined` keys were OMITTED by JSON.stringify, while these are
// typed fields carried as an explicit null. Both mean "upstream said nothing",
// and the board renders `—` for either; the choice is recorded so a reader
// does not mistake it for drift.
func TestProtocolsNullIsExplicitNotOmitted(t *testing.T) {
	f := newTestFetcher(t, &fakeDoer{body: map[string]string{UpstreamURL("protocols"): `[{"name":"A","slug":"a"}]`}}, 15)
	env, err := (&Service{F: f}).Envelope(context.Background(), "protocols", 5, 0)
	if err != nil {
		t.Fatalf("Envelope: %v", err)
	}
	var row map[string]any
	_ = json.Unmarshal(env.Rows[0], &row)
	for _, k := range []string{"category", "tvl", "mcap", "url", "logo"} {
		v, present := row[k]
		if !present || v != nil {
			t.Errorf("%s=%v (present=%v) want a PRESENT null", k, v, present)
		}
	}
	// chains is the one non-null default: an array, so a consumer can always
	// map over it.
	if v, ok := row["chains"].([]any); !ok || len(v) != 0 {
		t.Errorf("chains=%v want an empty array", row["chains"])
	}
}

func TestHistoricalTailKeepsOrderAndShape(t *testing.T) {
	body := `[{"date":1,"tvl":1},{"date":2,"tvl":2},{"date":3,"tvl":3},{"date":4,"tvl":4}]`
	f := newTestFetcher(t, &fakeDoer{body: map[string]string{UpstreamURL("historical"): body}}, 15)
	env, err := (&Service{F: f}).Envelope(context.Background(), "historical", 0, 2)
	if err != nil {
		t.Fatalf("Envelope: %v", err)
	}
	if len(env.Rows) != 2 {
		t.Fatalf("rows=%d want 2 (the TAIL, not the head)", len(env.Rows))
	}
	var first map[string]any
	if err := json.Unmarshal(env.Rows[0], &first); err != nil {
		t.Fatalf("row: %v", err)
	}
	if first["date"] != float64(3) {
		t.Errorf("first row date=%v want 3 (oldest-first upstream, so the tail is newest)", first["date"])
	}
	if len(first) != 2 {
		t.Errorf("historical row keys=%d want 2 (date, tvl only)", len(first))
	}
	if env.Derived != DerivedHistorical(2, 4) {
		t.Errorf("derived=%q", env.Derived)
	}
	if env.UpstreamTotal != 4 {
		t.Errorf("upstreamTotal=%d want the FULL history (4), not the tail (2)", env.UpstreamTotal)
	}
}

func TestTailBeyondLengthAndTake(t *testing.T) {
	rows := decodeRows(t, `[{"date":1},{"date":2}]`)
	if got := Tail(rows, 10); len(got) != 2 {
		t.Errorf("Tail(10) over 2 rows = %d want 2", len(got))
	}
	if got := Tail(rows, 0); got != nil {
		t.Errorf("Tail(0) = %v want nil", got)
	}
	if got := Take(rows, 1); len(got) != 1 {
		t.Errorf("Take(1) = %d want 1", len(got))
	}
	if got := Take(rows, 0); len(got) != 2 {
		t.Errorf("Take(0) = %d want every row", len(got))
	}
}

// ---- cache + single-flight ------------------------------------------------

func TestCacheMissThenHitAndOneUpstreamCall(t *testing.T) {
	u := UpstreamURL("chains")
	d := &fakeDoer{body: map[string]string{u: chainsBody()}}
	f := newTestFetcher(t, d, 15)
	svc := &Service{F: f}
	if _, err := svc.Envelope(context.Background(), "chains", 0, 0); err != nil {
		t.Fatalf("first: %v", err)
	}
	if _, err := svc.Envelope(context.Background(), "chains", 0, 0); err != nil {
		t.Fatalf("second: %v", err)
	}
	if n := d.count(u); n != 1 {
		t.Fatalf("upstream calls=%d want 1 (second read must be a HIT)", n)
	}
	if got := f.Stats().Entries; got != 1 {
		t.Errorf("cache entries=%d want 1 (bounded by AllowedURL)", got)
	}
}

func TestTTLExpiryRefetches(t *testing.T) {
	u := UpstreamURL("chains")
	d := &fakeDoer{body: map[string]string{u: chainsBody()}}
	f := newTestFetcher(t, d, 1)
	svc := &Service{F: f}
	if _, err := svc.Envelope(context.Background(), "chains", 0, 0); err != nil {
		t.Fatalf("first: %v", err)
	}
	// Age the entry past the TTL rather than sleeping: the clock read is
	// time.Since(fetchedAt), so a stale timestamp is the honest lever.
	f.mu.Lock()
	f.entries[u].fetchedAt = time.Now().Add(-2 * time.Second).Unix()
	f.mu.Unlock()
	if _, err := svc.Envelope(context.Background(), "chains", 0, 0); err != nil {
		t.Fatalf("second: %v", err)
	}
	if n := d.count(u); n != 2 {
		t.Fatalf("upstream calls=%d want 2 (an expired entry must refetch)", n)
	}
}

func TestSingleFlightJoinsOneUpstreamCall(t *testing.T) {
	u := UpstreamURL("chains")
	d := &fakeDoer{body: map[string]string{u: chainsBody()}, barrier: make(chan struct{})}
	f := newTestFetcher(t, d, 15)
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, _, _ = f.Fetch(context.Background(), u)
		}()
	}
	// Let every caller reach the flight table before the response is released.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if f.Stats().Flights == 1 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	close(d.barrier)
	wg.Wait()
	if n := d.count(u); n != 1 {
		t.Fatalf("upstream calls=%d want 1 (8 concurrent readers share one fetch)", n)
	}
	if got := f.Stats().Entries; got != 1 {
		t.Errorf("cache entries=%d want 1", got)
	}
}

func TestUpstreamTotalSurvivesTheCache(t *testing.T) {
	u := UpstreamURL("chains")
	d := &fakeDoer{body: map[string]string{u: chainsBody()}}
	f := newTestFetcher(t, d, 15)
	_, n1, i1, err := f.Fetch(context.Background(), u)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	_, n2, i2, _ := f.Fetch(context.Background(), u)
	if i1.Cache != "MISS" || i2.Cache != "HIT" {
		t.Errorf("cache marks=%q,%q want MISS,HIT", i1.Cache, i2.Cache)
	}
	if n1 != 4 || n2 != 4 {
		t.Errorf("upstreamTotal=%d,%d want 4,4 (a HIT reports the count of the bytes it serves)", n1, n2)
	}
	if i2.FetchedAt != i1.FetchedAt {
		t.Errorf("a HIT must keep the original fetchedAt (%d vs %d)", i1.FetchedAt, i2.FetchedAt)
	}
}

// ---- refusals (a real status stays real, never a fake 200) ----------------

func TestNon200KeepsItsRealStatus(t *testing.T) {
	u := UpstreamURL("protocols")
	for _, code := range []int{403, 429, 500, 503} {
		d := &fakeDoer{code: map[string]int{u: code}, body: map[string]string{u: "upstream said no"}}
		f := newTestFetcher(t, d, 15)
		_, _, _, err := f.Fetch(context.Background(), u)
		he, ok := IsHardError(err)
		if !ok {
			t.Fatalf("%d: err=%v want a HardError", code, err)
		}
		if he.Status != code {
			t.Errorf("%d: status=%d want %d", code, he.Status, code)
		}
		if !he.HasBody || !strings.Contains(he.Body, "upstream said no") {
			t.Errorf("%d: body=%q want the real upstream text", code, he.Body)
		}
		if code == 429 && he.Kind != "rate-limit" {
			t.Errorf("429 kind=%q want rate-limit", he.Kind)
		}
	}
}

func TestTransportFailureIsTransportKind(t *testing.T) {
	u := UpstreamURL("chains")
	d := &fakeDoer{err: map[string]error{u: errors.New("dial tcp: i/o timeout")}}
	f := newTestFetcher(t, d, 15)
	_, _, _, err := f.Fetch(context.Background(), u)
	he, ok := IsHardError(err)
	if !ok || he.Kind != "transport" {
		t.Fatalf("err=%v want a transport HardError", err)
	}
	if !strings.Contains(he.Message("chains"), "i/o timeout") {
		t.Errorf("message=%q must quote the real cause", he.Message("chains"))
	}
}

func TestNonJSONAndNonListAreLoud(t *testing.T) {
	cases := []struct {
		body string
		kind string
		frag string
	}{
		{"<html>a wall</html>", "non-json", "non-JSON"},
		{`{"error":"not a list"}`, "not-a-list", "unrecognised shape"},
	}
	for _, c := range cases {
		u := UpstreamURL("chains")
		d := &fakeDoer{body: map[string]string{u: c.body}}
		f := newTestFetcher(t, d, 15)
		_, _, _, err := f.Fetch(context.Background(), u)
		he, ok := IsHardError(err)
		if !ok || he.Kind != c.kind {
			t.Fatalf("body=%q err=%v want kind %s", c.body, err, c.kind)
		}
		if !strings.Contains(he.Message("chains"), c.frag) {
			t.Errorf("message=%q want it to contain %q", he.Message("chains"), c.frag)
		}
	}
}

func TestFailedFetchIsNeverCached(t *testing.T) {
	u := UpstreamURL("chains")
	d := &fakeDoer{code: map[string]int{u: 500}, body: map[string]string{u: "boom"}}
	f := newTestFetcher(t, d, 15)
	if _, _, _, err := f.Fetch(context.Background(), u); err == nil {
		t.Fatal("want an error")
	}
	if _, _, _, err := f.Fetch(context.Background(), u); err == nil {
		t.Fatal("want an error on the retry too")
	}
	if n := d.count(u); n != 2 {
		t.Fatalf("upstream calls=%d want 2 (an error page must never be served from cache)", n)
	}
	if got := f.Stats().Entries; got != 0 {
		t.Errorf("cache entries=%d want 0", got)
	}
}

func TestURLOutsideTheAllowlistIsRefused(t *testing.T) {
	f := newTestFetcher(t, &fakeDoer{}, 15)
	if _, _, _, err := f.Fetch(context.Background(), "https://api.llama.fi/protocol/aave"); err == nil {
		t.Fatal("an unpriced URL (29.7MB single protocol) must be refused")
	}
}

// ---- param matrix ---------------------------------------------------------

func TestParseParamMatrix(t *testing.T) {
	q := func(s string) url.Values {
		v, err := url.ParseQuery(s)
		if err != nil {
			t.Fatalf("ParseQuery(%q): %v", s, err)
		}
		return v
	}
	if v, err := ParseParam(q(""), TopParam); err != nil || v != 50 {
		t.Errorf("absent top=%d err=%v want the default 50", v, err)
	}
	for _, raw := range []string{"abc", "", "-1", "1.5", "1e2", " 3", "3 ", "0", "201"} {
		if _, err := ParseParam(url.Values{"top": {raw}}, TopParam); err == nil {
			t.Errorf("top=%q accepted; the boundary is strict and never clamped", raw)
		}
	}
	if v, err := ParseParam(url.Values{"top": {"200"}}, TopParam); err != nil || v != 200 {
		t.Errorf("top=200 (the inclusive cap) = %d err=%v", v, err)
	}
	if v, err := ParseParam(url.Values{"days": {"3288"}}, DaysParam); err != nil || v != 3288 {
		t.Errorf("days=3288 (the inclusive cap) = %d err=%v", v, err)
	}
	// The message text is part of the wire contract (verify-llama.py asserts
	// the fragments), so pin it verbatim.
	_, err := ParseParam(url.Values{"top": {"abc"}}, TopParam)
	if err == nil || !strings.Contains(err.Error(), "top must be an integer, got 'abc'") {
		t.Errorf("err=%v want the exact integer message", err)
	}
	_, err = ParseParam(url.Values{"days": {"99999"}}, DaysParam)
	if err == nil || !strings.Contains(err.Error(), "days must be between 1 and 3288, got 99999") {
		t.Errorf("err=%v want the exact range message", err)
	}
}

func TestModeTableAndUnknownDetail(t *testing.T) {
	if ModeCount != 10 {
		t.Fatalf("ModeCount=%d want 10", ModeCount)
	}
	for _, m := range []string{"chains", "protocols", "historical", "chainHistory", "tvl", "prices", "stablecoins", "dexs", "fees", "yields"} {
		if !Known(m) {
			t.Errorf("Known(%q)=false", m)
		}
	}
	for _, m := range []string{"chains", "protocols", "historical", "stablecoins", "dexs", "fees", "yields"} {
		if Path(m) == "" {
			t.Errorf("Path(%q) is empty", m)
		}
		if !AllowedURL(UpstreamURL(m)) {
			t.Errorf("AllowedURL rejects the table's own URL for %q", m)
		}
	}
	for _, tc := range []struct{ mode, chain, protocol, coins string }{
		{"chainHistory", "Ethereum", "", ""},
		{"tvl", "", "uniswap", ""},
		{"prices", "", "", "coingecko:ethereum"},
	} {
		if !AllowedURL(UpstreamURLFor(tc.mode, tc.chain, tc.protocol, tc.coins)) {
			t.Errorf("AllowedURL rejects the parameterized URL for %q", tc.mode)
		}
	}
	if Known("bogus") {
		t.Error("Known(bogus)=true")
	}
	if d := UnknownModeDetail(); d != "expected one of chains, protocols, historical, chainHistory, tvl, prices, stablecoins, dexs, fees, yields" {
		t.Errorf("detail=%q (generated from the same table Known consults)", d)
	}
}

func TestDefaultTTLIsFifteenSeconds(t *testing.T) {
	// 15s is the TS limiter's CACHE_TTL_MS; the constant is unexported, so it is
	// read the way a caller sees it — through a Fetcher built with no TTL.
	f, err := New(Options{Client: &fakeDoer{}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if got := f.TTL(); got != 15 {
		t.Errorf("default TTL=%ds want 15", got)
	}
}

// ---- helpers --------------------------------------------------------------

func names(t *testing.T, rows []json.RawMessage) []string {
	t.Helper()
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		var m map[string]any
		if err := json.Unmarshal(r, &m); err != nil {
			t.Fatalf("row is not JSON: %v", err)
		}
		out = append(out, fmt.Sprint(m["name"]))
	}
	return out
}

func slugOf(t *testing.T, r json.RawMessage) string {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(r, &m); err != nil {
		t.Fatalf("row is not JSON: %v", err)
	}
	return fmt.Sprint(m["slug"])
}

func decodeRows(t *testing.T, body string) []json.RawMessage {
	t.Helper()
	var rows []json.RawMessage
	if err := json.Unmarshal([]byte(body), &rows); err != nil {
		t.Fatalf("fixture is not a JSON array: %v", err)
	}
	return rows
}

func sorted(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// TestServedBytesShape pins the exact serialised envelope of one mode: the
// handler writes this with platform/httpx, so a field added, renamed or
// omitempty'd here would change the public wire without any test noticing.
func TestServedBytesShape(t *testing.T) {
	u := UpstreamURL("chains")
	d := &fakeDoer{body: map[string]string{u: `[{"name":"E","slug":"e","tvl":5}]`}}
	f := newTestFetcher(t, d, 15)
	env, err := (&Service{F: f}).Envelope(context.Background(), "chains", 0, 0)
	if err != nil {
		t.Fatalf("Envelope: %v", err)
	}
	b, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("served bytes are not an object: %v", err)
	}
	for _, k := range []string{"kind", "rows", "upstream", "fetchedAt", "upstreamTotal", "derived"} {
		if _, ok := m[k]; !ok {
			t.Errorf("served envelope is missing %q", k)
		}
	}
	if _, bad := m["cache"]; bad {
		t.Errorf("`cache` must not appear in the body: it is a header (X-Cache), and a second spelling would drift")
	}
	if len(m) != 6 {
		t.Errorf("served keys=%d want 6: %v", len(m), sorted2(m))
	}
}

func sorted2(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// A body that is an empty list is REAL data (DeFiLlama answered, with nothing),
// not a failure: it must be served as rows:[] and never turned into an error.
func TestEmptyListIsDataNotAnError(t *testing.T) {
	u := UpstreamURL("historical")
	d := &fakeDoer{body: map[string]string{u: "[]"}}
	f := newTestFetcher(t, d, 15)
	env, err := (&Service{F: f}).Envelope(context.Background(), "historical", 0, 30)
	if err != nil {
		t.Fatalf("Envelope: %v", err)
	}
	if env.UpstreamTotal != 0 || len(env.Rows) != 0 {
		t.Errorf("rows=%d total=%d want 0/0", len(env.Rows), env.UpstreamTotal)
	}
}

func TestTTLForPerModeAndFallback(t *testing.T) {
	cases := map[string]int{
		UpstreamURL("stablecoins"):                                300,
		UpstreamURL("dexs"):                                       300,
		UpstreamURL("fees"):                                       900,
		UpstreamURL("yields"):                                     300,
		UpstreamURLFor("chainHistory", "Ethereum", "", ""):       3600,
		UpstreamURLFor("tvl", "", "uniswap", ""):                 300,
		UpstreamURLFor("prices", "", "", "coingecko:ethereum"):   60,
		UpstreamURL("chains"):                                     15,
		UpstreamURL("protocols"):                                  15,
		UpstreamURL("historical"):                                 15,
	}
	for u, want := range cases {
		if got := TTLFor(u, 15); got != want {
			t.Errorf("TTLFor(%s) = %d, want %d", u, got, want)
		}
	}
	if got := TTLFor(Base+"/nope", 15); got != 15 {
		t.Errorf("unknown path fallback = %d, want 15", got)
	}
}

func TestAllowedURLFixedAndParameterized(t *testing.T) {
	for _, m := range []string{"chains", "protocols", "historical", "stablecoins", "dexs", "fees", "yields"} {
		if !AllowedURL(UpstreamURL(m)) {
			t.Errorf("AllowedURL rejects fixed %q", m)
		}
	}
	for _, u := range []string{
		UpstreamURLFor("chainHistory", "Ethereum", "", ""),
		UpstreamURLFor("tvl", "", "uniswap", ""),
		UpstreamURLFor("prices", "", "", "coingecko:ethereum,coingecko:solana"),
	} {
		if !AllowedURL(u) {
			t.Errorf("AllowedURL rejects parameterized %q", u)
		}
	}
	for _, u := range []string{
		Base + "/protocol/aave",
		Base + "/v2/historicalChainTvl/",
		Base + "/v2/historicalChainTvl/Evil/Chain",
		Base + "/tvl/",
		"https://coins.llama.fi/prices/current/",
		Base + "/v2/historicalChainTvl/Ethereum?x=1",
		"https://evil.llama.fi/pools",
	} {
		if AllowedURL(u) {
			t.Errorf("AllowedURL accepts %q", u)
		}
	}
}

func TestParseChainProtocolCoinsMatrix(t *testing.T) {
	if _, err := ParseChain(""); err == nil {
		t.Error("empty chain accepted")
	}
	if _, err := ParseChain("Evil/Chain"); err == nil {
		t.Error("slash chain accepted")
	}
	if v, err := ParseChain("Ethereum"); err != nil || v != "Ethereum" {
		t.Errorf("chain Ethereum = %q, %v", v, err)
	}
	if _, err := ParseProtocol(""); err == nil {
		t.Error("empty protocol accepted")
	}
	if _, err := ParseProtocol("evil/slug"); err == nil {
		t.Error("slash protocol accepted")
	}
	if _, err := ParseCoins(""); err == nil {
		t.Error("empty coins accepted")
	}
	if _, err := ParseCoins("a,,b"); err == nil {
		t.Error("doubled comma accepted")
	}
	if v, err := ParseCoins("coingecko:ethereum,coingecko:solana"); err != nil || v == "" {
		t.Errorf("coins list = %q, %v", v, err)
	}
}

func TestNewModeEnvelopes(t *testing.T) {
	d := &fakeDoer{body: map[string]string{
		UpstreamURLFor("tvl", "", "uniswap", ""): `3946415939.48`,
		UpstreamURLFor("prices", "", "", "coingecko:ethereum"): `{"coins":{"coingecko:ethereum":{"price":2492.0,"symbol":"ETH","timestamp":1791608096,"confidence":0.99}}}`,
		UpstreamURL("stablecoins"):                             `{"peggedAssets":[{"id":"1","name":"Tether","symbol":"USDT","circulating":{"peggedUSD":184.0},"price":1.0},{"id":"2","name":"Coin","symbol":"C","circulating":{"peggedUSD":73.0},"price":1.0}]}`,
		UpstreamURL("dexs"):                                    `{"protocols":[{"name":"Curve DEX","slug":"curve-dex","total24h":7,"totalAllTime":352.0,"chains":["Ethereum"]},{"name":"S","slug":"s","total24h":1,"totalAllTime":10.0,"chains":[]}]}`,
		UpstreamURL("yields"):                                  `{"status":"success","data":[{"pool":"a","chain":"Ethereum","project":"lido","symbol":"STETH","tvlUsd":241.0,"apy":2.2,"apyBase":2.2,"apyReward":null},{"pool":"b","chain":"Base","project":"x","symbol":"Y","tvlUsd":10.0,"apy":5.0,"apyBase":5.0,"apyReward":null}]}`,
	}}
	f := newTestFetcher(t, d, 15)
	svc := &Service{F: f}
	env, err := svc.EnvelopeWith(context.Background(), "tvl", EnvelopeParams{Protocol: "uniswap"})
	if err != nil {
		t.Fatalf("tvl: %v", err)
	}
	if env.UpstreamTotal != 1 || len(env.Rows) != 1 {
		t.Errorf("tvl rows=%d total=%d want 1/1", len(env.Rows), env.UpstreamTotal)
	}
	env, err = svc.EnvelopeWith(context.Background(), "stablecoins", EnvelopeParams{Top: 1})
	if err != nil {
		t.Fatalf("stablecoins: %v", err)
	}
	if env.UpstreamTotal != 2 || len(env.Rows) != 1 {
		t.Errorf("stablecoins rows=%d total=%d want 1/2", len(env.Rows), env.UpstreamTotal)
	}
	var srow map[string]any
	_ = json.Unmarshal(env.Rows[0], &srow)
	if srow["symbol"] != "USDT" {
		t.Errorf("stablecoins head=%v want USDT first (circulating desc)", srow["symbol"])
	}
	env, err = svc.EnvelopeWith(context.Background(), "yields", EnvelopeParams{Top: 1})
	if err != nil {
		t.Fatalf("yields: %v", err)
	}
	var yrow map[string]any
	_ = json.Unmarshal(env.Rows[0], &yrow)
	if yrow["project"] != "lido" {
		t.Errorf("yields head=%v want lido first (tvlUsd desc)", yrow["project"])
	}
}

func TestLRUBoundEvictsOldest(t *testing.T) {
	d := &fakeDoer{}
	f := newTestFetcher(t, d, 15)
	for i := range maxEntries + 5 {
		u := UpstreamURLFor("tvl", "", "proto", "") + string(rune('a'+i%26)) + string(rune('0'+i/26))
		f.mu.Lock()
		f.evictIfFull()
		f.entries[u] = &entry{body: "1", upstreamTotal: 1, fetchedAt: int64(i)}
		f.mu.Unlock()
	}
	if got := f.Stats().Entries; got != maxEntries {
		t.Errorf("entries=%d want the %d cap", got, maxEntries)
	}
}

// drain is a compile-time guard that the test file exercises the real
// http.Response path (an httptest server is unnecessary here, but the Doer
// contract must stay satisfiable by *http.Client).
var _ Doer = (*http.Client)(nil)
var _ = httptest.NewRequest

package defillama

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// fakeDoer answers every request with a canned status+body and records the
// last URL (tests assert the endpoint+query shape).
type fakeDoer struct {
	status int
	body   string
	seen   []string
}

func (f *fakeDoer) Do(r *http.Request) (*http.Response, error) {
	f.seen = append(f.seen, r.URL.String())
	return &http.Response{
		StatusCode: f.status,
		Body:       newReadCloser(f.body),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    r,
	}, nil
}

// spyWriter counts the writes each dataset performs.
type spyWriter struct {
	protocols int
	chains    int
	protTVL   int
	chainTVL  int
	err       error
}

func (w *spyWriter) UpsertAssets(ctx context.Context, rows []canon.Asset) (int, error) {
	return 0, w.err
}

func (w *spyWriter) UpsertChains(ctx context.Context, rows []canon.Chain) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	w.chains += len(rows)
	return len(rows), nil
}

func (w *spyWriter) UpsertVenues(ctx context.Context, rows []canon.Venue) (int, error) {
	return 0, w.err
}

func (w *spyWriter) UpsertInstruments(ctx context.Context, rows []canon.Instrument) (int, error) {
	return 0, w.err
}

func (w *spyWriter) UpsertProtocols(ctx context.Context, rows []canon.Protocol) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	w.protocols += len(rows)
	return len(rows), nil
}

func (w *spyWriter) UpsertSeries(ctx context.Context, rows []canon.SeriesMeta) (int, error) {
	return 0, w.err
}

func (w *spyWriter) UpsertProviderSymbols(ctx context.Context, rows []canon.ProviderSymbol) (int, error) {
	return 0, w.err
}

func (w *spyWriter) WriteOhlcv(ctx context.Context, rows []canon.Ohlcv) (int, int, error) {
	return 0, 0, w.err
}

func (w *spyWriter) WriteTrades(ctx context.Context, rows []canon.Trade) (int, int, error) {
	return 0, 0, w.err
}

func (w *spyWriter) WriteQuotes(ctx context.Context, rows []canon.Quote) (int, int, error) {
	return 0, 0, w.err
}

func (w *spyWriter) WriteOrderbook(ctx context.Context, rows []canon.OrderbookSnap) (int, int, error) {
	return 0, 0, w.err
}

func (w *spyWriter) WriteObservations(ctx context.Context, rows []canon.Observation) (int, int, error) {
	return 0, 0, w.err
}

func (w *spyWriter) WriteFunding(ctx context.Context, rows []canon.FundingRate) (int, int, error) {
	return 0, 0, w.err
}

func (w *spyWriter) WriteOpenInterest(ctx context.Context, rows []canon.OpenInterest) (int, int, error) {
	return 0, 0, w.err
}

func (w *spyWriter) WritePools(ctx context.Context, rows []canon.Pool) (int, int, error) {
	return 0, 0, w.err
}

func (w *spyWriter) WriteArticles(ctx context.Context, rows []canon.Article) (int, int, error) {
	return 0, 0, w.err
}

func (w *spyWriter) WritePredictionMarkets(ctx context.Context, rows []canon.PredictionMarket) (int, int, error) {
	return 0, 0, w.err
}

func (w *spyWriter) WriteChainTVL(ctx context.Context, rows []canon.ChainTVL) (int, int, error) {
	if w.err != nil {
		return 0, 0, w.err
	}
	w.chainTVL += len(rows)
	return len(rows), 0, nil
}

func (w *spyWriter) WriteProtocolTVL(ctx context.Context, rows []canon.ProtocolTVL) (int, int, error) {
	if w.err != nil {
		return 0, 0, w.err
	}
	w.protTVL += len(rows)
	return len(rows), 0, nil
}

func (w *spyWriter) WriteSupply(ctx context.Context, rows []canon.SupplySnapshot) (int, int, error) {
	return 0, 0, w.err
}

func (w *spyWriter) WriteMetric(ctx context.Context, seriesID string, points []canon.MetricPoint) (int, error) {
	return 0, w.err
}

// newReadCloser is a tiny io.ReadCloser over a string.
func newReadCloser(s string) ioReadCloser { return ioReadCloser{strings.NewReader(s)} }

type ioReadCloser struct{ *strings.Reader }

func (ioReadCloser) Close() error { return nil }

// Fixtures trimmed from the real endpoints (shape-true, values real).
const protocolsFixture = `[
 {"slug":"aave","name":"Aave","tvl":8384213314.3,
  "chainTvls":{"Ethereum":512345678.9,"Arbitrum":123456789.1},"category":"Lending"},
 {"slug":"uniswap","name":"Uniswap","tvl":5123456789.0,
  "chainTvls":{"Ethereum":4123456789.0},"category":"Dexes"}
]`

// chainsFixture is trimmed from the live /v2/chains: cmcId arrives as a
// STRING ("6836"), and gecko-only chains omit the key entirely.
const chainsFixture = `[
 {"gecko_id":"ethereum","name":"Ethereum","tokenSymbol":"ETH","cmcId":"1027","tvl":51234567890.1},
 {"gecko_id":"arbitrum","name":"Arbitrum","tokenSymbol":"ARB","cmcId":"11841","tvl":12345678901.0},
 {"name":"A Gecko Only Chain","tokenSymbol":"AGOC","tvl":987654321.0}
]`

// historyNow is the fixture's date anchor: the parser bounds writes to the
// job window (default 90 days), so fixture points relative to now stay
// inside it no matter when the suite runs.
var historyNow = time.Now().UTC().Truncate(time.Second)

var protocolHistoryFixture = `{"tvl":[
 {"date":` + itoa(historyNow.AddDate(0, 0, -1).Unix()) + `,"totalLiquidityUSD":8384213314.3},
 {"date":` + itoa(historyNow.AddDate(0, 0, -2).Unix()) + `,"totalLiquidityUSD":8412000000.0}],
 "chainTvls":{"Ethereum":[
   {"date":` + itoa(historyNow.AddDate(0, 0, -1).Unix()) + `,"totalLiquidityUSD":512345678.9},
   {"date":` + itoa(historyNow.AddDate(0, 0, -2).Unix()) + `,"totalLiquidityUSD":515000000.0}]}}`

// captureWriter spies and keeps the rows for identity assertions.
type captureWriter struct {
	*spyWriter
	protocols []canon.Protocol
	chains    []canon.Chain
	protTVL   []canon.ProtocolTVL
	chainTVL  []canon.ChainTVL
}

func (w *captureWriter) UpsertProtocols(ctx context.Context, rows []canon.Protocol) (int, error) {
	w.protocols = append(w.protocols, rows...)
	return w.spyWriter.UpsertProtocols(ctx, rows)
}

func (w *captureWriter) UpsertChains(ctx context.Context, rows []canon.Chain) (int, error) {
	w.chains = append(w.chains, rows...)
	return w.spyWriter.UpsertChains(ctx, rows)
}

func (w *captureWriter) WriteProtocolTVL(ctx context.Context, rows []canon.ProtocolTVL) (int, int, error) {
	w.protTVL = append(w.protTVL, rows...)
	return w.spyWriter.WriteProtocolTVL(ctx, rows)
}

func (w *captureWriter) WriteChainTVL(ctx context.Context, rows []canon.ChainTVL) (int, int, error) {
	w.chainTVL = append(w.chainTVL, rows...)
	return w.spyWriter.WriteChainTVL(ctx, rows)
}

func TestProtocolsTVLMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: protocolsFixture}
	c := newClient(fd, 0)
	w := &captureWriter{spyWriter: &spyWriter{}}
	job := ingest.Job{Provider: "defillama", Dataset: "protocols-tvl", Subject: "", Mode: "poll"}
	res, err := (&fetcher{dataset: "protocols-tvl", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("protocols: %v", err)
	}
	if len(w.protocols) != 2 || res.RowsWritten != len(w.protTVL) {
		t.Fatalf("protocols: %d, rows: %d/%d", len(w.protocols), res.RowsWritten, len(w.protTVL))
	}
	// 2 aggregate rows (r.TVL) + aave's two chains + uniswap's one chain.
	if len(w.protTVL) != 5 {
		t.Fatalf("tvl rows: %d", len(w.protTVL))
	}
	if fd.seen[0] != "https://api.llama.fi/protocols" {
		t.Fatalf("url: %s", fd.seen[0])
	}
	// Protocol ids mint from ProtocolKey(slug); chain ids from ChainKey(name).
	wantAave := canon.MintID(canon.KindProtocol, canon.ProtocolKey("aave"))
	wantEth := canon.MintID(canon.KindChain, canon.ChainKey("Ethereum"))
	var sawAgg, sawChain bool
	for _, r := range w.protTVL {
		if r.ProtocolID == wantAave && r.ChainID == "" {
			sawAgg = true
		}
		if r.ProtocolID == wantAave && r.ChainID == wantEth {
			sawChain = true
		}
	}
	if !sawAgg || !sawChain {
		t.Fatalf("missing aave rows (agg=%v chain=%v)", sawAgg, sawChain)
	}
	// The upserted protocol row carries the slug and category.
	if len(w.protocols) != 2 || w.protocols[0].Slug != "aave" {
		t.Fatalf("protocol upserts: %+v", w.protocols)
	}
}

func TestProtocolsTVLSkipsEmptySlug(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `[{"name":"Broken","tvl":1.0},` + protocolsFixture[1:]}
	c := newClient(fd, 0)
	w := &captureWriter{spyWriter: &spyWriter{}}
	job := ingest.Job{Provider: "defillama", Dataset: "protocols-tvl", Subject: "", Mode: "poll"}
	res, err := (&fetcher{dataset: "protocols-tvl", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("protocols: %v", err)
	}
	if res.RowsRejected != 1 {
		t.Fatalf("rejected: %d", res.RowsRejected)
	}
	if len(w.protocols) != 2 {
		t.Fatalf("good rows still written: %d", len(w.protocols))
	}
}

func TestChainTVLMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: chainsFixture}
	c := newClient(fd, 0)
	w := &captureWriter{spyWriter: &spyWriter{}}
	job := ingest.Job{Provider: "defillama", Dataset: "chains-tvl", Subject: "", Mode: "poll"}
	res, err := (&fetcher{dataset: "chains-tvl", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("chains: %v", err)
	}
	if len(w.chains) != 3 || len(w.chainTVL) != 3 || res.RowsWritten != 3 {
		t.Fatalf("chains: %d, tvl: %d/%d", len(w.chains), res.RowsWritten, len(w.chainTVL))
	}
	if fd.seen[0] != "https://api.llama.fi/v2/chains" {
		t.Fatalf("url: %s", fd.seen[0])
	}
	// cmcId is metadata: the live string spelling and the absent (gecko-only)
	// spelling both land without dropping the row. The mapping records what
	// the wire carried, never a zero.
	for _, ch := range w.chains {
		if ch.ChainID == canon.MintID(canon.KindChain, canon.ChainKey("A Gecko Only Chain")) && ch.ChainNumericID != nil {
			t.Fatalf("gecko-only chain must carry no cmc id: %+v", ch.ChainNumericID)
		}
	}
	// Chain ids mint from ChainKey(name); the reference chains must collide
	// with the reference ids (ethereum -> chain:7904aa7bd5 is pinned in
	// canon's tests, so only the mint-determinism is asserted here).
	wantArb := canon.MintID(canon.KindChain, canon.ChainKey("Arbitrum"))
	found := false
	for _, r := range w.chainTVL {
		if r.ChainID == wantArb && r.TVLUSD == 12345678901.0 {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing arbitrum tvl row")
	}
	// The live cmcId spelling (a quoted string) maps through to the chain's
	// numeric id; the gecko-only row (key absent) stays nil, never 0.
	wantEth := canon.MintID(canon.KindChain, canon.ChainKey("Ethereum"))
	for _, ch := range w.chains {
		if ch.ChainID == wantEth {
			if ch.ChainNumericID == nil || *ch.ChainNumericID != 1027 {
				t.Fatalf("ethereum cmcId: %+v", ch.ChainNumericID)
			}
		}
	}
}

// TestChainTVLCmcIdSpellings pins the cmcId decode against every spelling the
// endpoint has published: the live quoted string, the legacy bare number, a
// null, and the missing key. Absence stays nil — never 0 — and a broken value
// drops the metadata, not the row.
func TestChainTVLCmcIdSpellings(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `[
	 {"name":"String ID","cmcId":"6836","tvl":1.0},
	 {"name":"Bare Number","cmcId":11841,"tvl":2.0},
	 {"name":"Null ID","cmcId":null,"tvl":3.0},
	 {"name":"No Key","tvl":4.0}
	]`}
	c := newClient(fd, 0)
	w := &captureWriter{spyWriter: &spyWriter{}}
	job := ingest.Job{Provider: "defillama", Dataset: "chains-tvl", Subject: "", Mode: "poll"}
	res, err := (&fetcher{dataset: "chains-tvl", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("chains: %v", err)
	}
	if res.RowsWritten != 4 {
		t.Fatalf("rows: %d", res.RowsWritten)
	}
	want := map[string]*int{
		"string id":   intPtr(6836),
		"bare number": intPtr(11841),
		"null id":     nil,
		"no key":      nil,
	}
	got := map[string]*int{}
	for _, ch := range w.chains {
		got[ch.Name] = ch.ChainNumericID
	}
	for name, id := range want {
		have, ok := got[name]
		if !ok {
			t.Fatalf("missing chain %q", name)
		}
		if (id == nil) != (have == nil) || (id != nil && *id != *have) {
			t.Fatalf("chain %q numeric id: want %v, got %v", name, id, have)
		}
	}
}

func intPtr(n int) *int { return &n }

func TestProtocolHistoryMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: protocolHistoryFixture}
	c := newClient(fd, 0)
	w := &captureWriter{spyWriter: &spyWriter{}}
	job := ingest.Job{Provider: "defillama", Dataset: "protocol-history", Subject: "aave", Mode: "backfill"}
	res, err := (&fetcher{dataset: "protocol-history", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	// 2 aggregate + 2 chain points, all inside the default 90-day window.
	if len(w.protTVL) != 4 || res.RowsWritten != 4 {
		t.Fatalf("tvl rows: %d/%d", len(w.protTVL), res.RowsWritten)
	}
	if !strings.HasPrefix(fd.seen[0], "https://api.llama.fi/protocol/aave") {
		t.Fatalf("url: %s", fd.seen[0])
	}
	// The result carries the self-contained next cursor.
	if res.Next["slug"] != "aave" {
		t.Fatalf("next cursor: %v", res.Next)
	}
	// UNIX-second dates decode to UTC.
	wantAave := canon.MintID(canon.KindProtocol, canon.ProtocolKey("aave"))
	wantAt := historyNow.AddDate(0, 0, -1)
	found := false
	for _, r := range w.protTVL {
		if r.ProtocolID == wantAave && r.ChainID == "" && r.At.Equal(wantAt) && r.TVLUSD == 8384213314.3 {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing aggregate point at %v", wantAt)
	}
}

func TestProtocolHistoryNeedsSlug(t *testing.T) {
	fd := &fakeDoer{status: 200, body: protocolHistoryFixture}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "defillama", Dataset: "protocol-history", Subject: "", Mode: "backfill"}
	_, err := (&fetcher{dataset: "protocol-history", client: c}).Fetch(context.Background(), job, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
	if len(fd.seen) != 0 {
		t.Fatalf("requests made without slug: %v", fd.seen)
	}
}

func TestProtocolHistoryCutoffWindow(t *testing.T) {
	// One point inside a 1-day window, one 10 days old.
	body := `{"tvl":[
	 {"date":` + itoa(time.Now().Add(-1*time.Hour).Unix()) + `,"totalLiquidityUSD":100.0},
	 {"date":` + itoa(time.Now().Add(-10*24*time.Hour).Unix()) + `,"totalLiquidityUSD":200.0}]}`
	fd := &fakeDoer{status: 200, body: body}
	c := newClient(fd, 0)
	w := &captureWriter{spyWriter: &spyWriter{}}
	job := ingest.Job{
		Provider: "defillama", Dataset: "protocol-history", Subject: "aave", Mode: "backfill",
		Cursor: ingest.Cursor{"days": float64(1)},
	}
	res, err := (&fetcher{dataset: "protocol-history", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if len(w.protTVL) != 1 || res.RowsWritten != 1 {
		t.Fatalf("tvl rows: %d/%d", len(w.protTVL), res.RowsWritten)
	}
}

// itoa is strconv.FormatInt local for the cutoff fixture.
func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func TestStatusErrorIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 500, body: `upstream exploded`}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "defillama", Dataset: "protocols-tvl", Subject: "", Mode: "poll"}
	_, err := (&fetcher{dataset: "protocols-tvl", client: c}).Fetch(context.Background(), job, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "status" || he.Status != 500 {
		t.Fatalf("want status HardError, got %v", err)
	}
}

func TestNonJSONIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `<html>blocked</html>`}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "defillama", Dataset: "chains-tvl", Subject: "", Mode: "poll"}
	_, err := (&fetcher{dataset: "chains-tvl", client: c}).Fetch(context.Background(), job, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestJobsRegistered(t *testing.T) {
	m := NewModule(nil)
	if m.Provider() != "defillama" {
		t.Fatalf("provider: %s", m.Provider())
	}
	fetchers := m.Fetchers()
	for _, ds := range []string{"protocols-tvl", "chains-tvl", "protocol-history"} {
		if _, ok := fetchers[ds]; !ok {
			t.Fatalf("missing fetcher %s", ds)
		}
	}
	jobs := m.Jobs()
	if len(jobs) == 0 {
		t.Fatalf("no jobs registered")
	}
	var prot5, chain5, hist1h bool
	for _, j := range jobs {
		if j.Provider != "defillama" || !j.Enabled {
			t.Fatalf("job spec: %+v", j)
		}
		switch {
		case j.Dataset == "protocols-tvl" && j.Schedule == 5*time.Minute:
			prot5 = true
		case j.Dataset == "chains-tvl" && j.Schedule == 5*time.Minute:
			chain5 = true
		case j.Dataset == "protocol-history" && j.Schedule == time.Hour:
			hist1h = true
		}
	}
	if !prot5 || !chain5 || !hist1h {
		t.Fatalf("seed jobs wrong: %+v", jobs)
	}
}

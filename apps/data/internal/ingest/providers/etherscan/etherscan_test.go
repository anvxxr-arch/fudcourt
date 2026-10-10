package etherscan

import (
	"context"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
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

// newReadCloser is a tiny io.ReadCloser over a string.
func newReadCloser(s string) ioReadCloser { return ioReadCloser{strings.NewReader(s)} }

type ioReadCloser struct{ *strings.Reader }

func (ioReadCloser) Close() error { return nil }

// spyWriter counts the writes each dataset performs.
type spyWriter struct {
	supply     int
	lastSupply []canon.SupplySnapshot
	metrics    int
	series     int
	lastSerie  string
	lastPts    []canon.MetricPoint
	err        error
}

func (w *spyWriter) UpsertAssets(ctx context.Context, rows []canon.Asset) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertChains(ctx context.Context, rows []canon.Chain) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertVenues(ctx context.Context, rows []canon.Venue) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertInstruments(ctx context.Context, rows []canon.Instrument) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertProtocols(ctx context.Context, rows []canon.Protocol) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertSeries(ctx context.Context, rows []canon.SeriesMeta) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	w.series += len(rows)
	if len(rows) > 0 {
		w.lastSerie = rows[0].SeriesID
	}
	return len(rows), nil
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
	return 0, 0, w.err
}
func (w *spyWriter) WriteProtocolTVL(ctx context.Context, rows []canon.ProtocolTVL) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteSupply(ctx context.Context, rows []canon.SupplySnapshot) (int, int, error) {
	if w.err != nil {
		return 0, 0, w.err
	}
	w.supply += len(rows)
	w.lastSupply = rows
	return len(rows), 0, nil
}
func (w *spyWriter) WriteMetric(ctx context.Context, seriesID string, points []canon.MetricPoint) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	w.metrics += len(points)
	w.lastSerie = seriesID
	w.lastPts = points
	return len(points), nil
}

// Fixtures trimmed from the real endpoints (shape-true, values real). The
// supply value is the documented example wei string; the gas oracle matches
// the live v2 gasoracle object.
const supplyFixture = `{"status":"1","message":"OK","result":"120473186340000000000000000"}`
const gasFixture = `{"status":"1","message":"OK","result":{"LastBlock":"23467872",
 "SafeGasPrice":"0.496839934","ProposeGasPrice":"0.496840168","FastGasPrice":"0.55411917",
 "suggestBaseFee":"0.496839934","gasUsedRatio":"0.405"}}`
const apiKeyErrFixture = `{"status":"0","message":"NOTOK","result":"Missing/Invalid API Key"}`

// withTestKey sets ETHERSCAN_API_KEY for one test and restores it after.
func withTestKey(t *testing.T) {
	t.Helper()
	old, had := os.LookupEnv(APIKeyEnv)
	os.Setenv(APIKeyEnv, "test-key-123")
	t.Cleanup(func() {
		if had {
			os.Setenv(APIKeyEnv, old)
		} else {
			os.Unsetenv(APIKeyEnv)
		}
	})
}
func TestSupplyMapping(t *testing.T) {
	withTestKey(t)
	fd := &fakeDoer{status: 200, body: supplyFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "etherscan", Dataset: "supply", Subject: "ethereum", Mode: "poll"}
	res, err := (&fetcher{dataset: "supply", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("supply: %v", err)
	}
	if w.supply != 1 || res.RowsWritten != 1 {
		t.Fatalf("supply rows: %d/%d", w.supply, res.RowsWritten)
	}
	if !strings.HasPrefix(fd.seen[0], "https://api.etherscan.io/v2/api?chainid=1&module=stats&action=ethsupply") {
		t.Fatalf("url: %s", fd.seen[0])
	}
	// Wei -> whole ETH.
	if got := *w.lastSupply[0].TotalSupply; got != 120473186.34 {
		t.Fatalf("total supply: %v", got)
	}
	// Native coin anchor: chain ethereum, address "", asset ETH.
	wantChain := canon.MintID(canon.KindChain, canon.ChainKey("ethereum"))
	wantAsset := canon.MintID(canon.KindAsset, canon.AssetKey(canon.AssetNative, "ETH"))
	row := w.lastSupply[0]
	if row.ChainID != wantChain || row.Address != "" || row.AssetID == nil || *row.AssetID != wantAsset {
		t.Fatalf("supply identity: %+v", row)
	}
	if row.Source != "etherscan" {
		t.Fatalf("source: %s", row.Source)
	}
}
func TestSupplyUnsupportedChain(t *testing.T) {
	withTestKey(t)
	fd := &fakeDoer{status: 200, body: supplyFixture}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "etherscan", Dataset: "supply", Subject: "solana", Mode: "poll"}
	_, err := (&fetcher{dataset: "supply", client: c}).Fetch(context.Background(), job, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
	if len(fd.seen) != 0 {
		t.Fatalf("requests made for unsupported chain: %v", fd.seen)
	}
}
func TestGasMapping(t *testing.T) {
	withTestKey(t)
	fd := &fakeDoer{status: 200, body: gasFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "etherscan", Dataset: "gas", Subject: "ethereum", Mode: "poll"}
	res, err := (&fetcher{dataset: "gas", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("gas: %v", err)
	}
	// Three tiers -> three metric points on one series.
	if w.metrics != 3 || res.RowsWritten != 3 {
		t.Fatalf("metric points: %d/%d", w.metrics, res.RowsWritten)
	}
	if !strings.HasPrefix(fd.seen[0], "https://api.etherscan.io/v2/api?chainid=1&module=gastracker&action=gasoracle") {
		t.Fatalf("url: %s", fd.seen[0])
	}
	// The series id mints from SeriesKey(blockchain, gas_price_gwei, chain:<id>).
	chain := canon.MintID(canon.KindChain, canon.ChainKey("ethereum"))
	want := canon.MintID(canon.KindSeries, canon.SeriesKey("blockchain", "gas_price_gwei", "chain:"+chain))
	if w.lastSerie != want {
		t.Fatalf("series id: %s want %s", w.lastSerie, want)
	}
	// Tier order is fixed and values parse through.
	wantTiers := []string{"safe", "propose", "fast"}
	wantVals := []float64{0.496839934, 0.496840168, 0.55411917}
	for i, p := range w.lastPts {
		if p.Meta["tier"] != wantTiers[i] {
			t.Fatalf("point %d tier: %v", i, p.Meta["tier"])
		}
		if *p.Value != wantVals[i] {
			t.Fatalf("point %d value: %v", i, *p.Value)
		}
	}
	// The fetch upserts the series meta before writing points.
	if w.series != 1 || w.lastSerie != w.lastSerie {
		t.Fatalf("series upserts: %d", w.series)
	}
}
func TestAPIErrorEnvelopeIsHardError(t *testing.T) {
	withTestKey(t)
	fd := &fakeDoer{status: 200, body: apiKeyErrFixture}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "etherscan", Dataset: "supply", Subject: "ethereum", Mode: "poll"}
	_, err := (&fetcher{dataset: "supply", client: c}).Fetch(context.Background(), job, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok {
		t.Fatalf("want HardError, got %T: %v", err, err)
	}
	if he.Kind != "api-error" {
		t.Fatalf("HardError = %+v", he)
	}
	// The key must not leak into the error text.
	if strings.Contains(he.Error(), "test-key-123") {
		t.Fatalf("api key leaked into error: %s", he.Error())
	}
}
func TestNoCredentialsIsHardError(t *testing.T) {
	os.Unsetenv(APIKeyEnv)
	fd := &fakeDoer{status: 200, body: supplyFixture}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "etherscan", Dataset: "supply", Subject: "ethereum", Mode: "poll"}
	_, err := (&fetcher{dataset: "supply", client: c}).Fetch(context.Background(), job, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "no-credentials" {
		t.Fatalf("want no-credentials HardError, got %v", err)
	}
	// No request may leave the process without a key.
	if len(fd.seen) != 0 {
		t.Fatalf("requests made without key: %v", fd.seen)
	}
}
func TestJobsSeedDisabledWithoutKey(t *testing.T) {
	os.Unsetenv(APIKeyEnv)
	m := NewModule(nil)
	if m.HasCredentials() {
		t.Fatalf("HasCredentials with empty env")
	}
	jobs := m.Jobs()
	if len(jobs) != 2 {
		t.Fatalf("seed must be exactly supply+gas ethereum: %+v", jobs)
	}
	for _, j := range jobs {
		if j.Enabled {
			t.Fatalf("job seeded enabled without key: %+v", j)
		}
		if j.Provider != "etherscan" || j.Subject != "ethereum" {
			t.Fatalf("job spec: %+v", j)
		}
	}
	if jobs[0].Dataset != "supply" || jobs[1].Dataset != "gas" {
		t.Fatalf("datasets: %+v", jobs)
	}
}
func TestJobsSeedEnabledWithKey(t *testing.T) {
	withTestKey(t)
	m := NewModule(nil)
	jobs := m.Jobs()
	if len(jobs) != 2 {
		t.Fatalf("seed must be exactly supply+gas ethereum: %+v", jobs)
	}
	var ethSupply, ethGas bool
	for _, j := range jobs {
		if !j.Enabled || j.Subject != "ethereum" {
			t.Fatalf("job seeded wrong: %+v", j)
		}
		if j.Dataset == "supply" && j.Schedule == 24*time.Hour {
			ethSupply = true
		}
		if j.Dataset == "gas" && j.Schedule == 5*time.Minute {
			ethGas = true
		}
	}
	if !ethSupply || !ethGas {
		t.Fatalf("ethereum seeds wrong: %+v", jobs)
	}
	fetchers := m.Fetchers()
	for _, ds := range []string{"supply", "gas"} {
		if _, ok := fetchers[ds]; !ok {
			t.Fatalf("missing fetcher %s", ds)
		}
	}
}
func TestErrorURLRedactsKey(t *testing.T) {
	withTestKey(t)
	fd := &fakeDoer{status: 500, body: `upstream exploded`}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "etherscan", Dataset: "gas", Subject: "ethereum", Mode: "poll"}
	_, err := (&fetcher{dataset: "gas", client: c}).Fetch(context.Background(), job, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "status" {
		t.Fatalf("want status HardError, got %v", err)
	}
	if strings.Contains(he.URL, "test-key-123") || strings.Contains(he.Error(), "test-key-123") {
		t.Fatalf("api key leaked: %s / %s", he.URL, he.Error())
	}
	if !strings.Contains(he.URL, "apikey=REDACTED") {
		t.Fatalf("url not redacted: %s", he.URL)
	}
}
func TestWeiToETH(t *testing.T) {
	cases := []struct {
		wei string
		ok  bool
		out float64
	}{
		{"120473186340000000000000000", true, 120473186.34},
		{"1000000000000000000", true, 1},
		{"", false, 0},
		{"abc", false, 0},
		{"-5", false, 0},
	}
	for _, c := range cases {
		got, ok := weiToETH(c.wei)
		if ok != c.ok || (ok && got != c.out) {
			t.Fatalf("weiToETH(%q) = %v, %v; want %v, %v", c.wei, got, ok, c.out, c.ok)
		}
	}
}
func TestChainMapRoundTrip(t *testing.T) {
	for id, name := range chains {
		got, ok := chainID(name)
		if !ok || got != id {
			t.Fatalf("chain map round trip failed for %s -> %s", name, id)
		}
	}
	if _, ok := chainID("solana"); ok {
		t.Fatalf("solana must not resolve")
	}
	// The task pins the six-chain map.
	if len(chains) != 6 {
		t.Fatalf("chain map size: %d", len(chains))
	}
}

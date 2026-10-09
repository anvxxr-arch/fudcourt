package coinank

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// wallDoer serves one good body and then the measured transient refusal
// forever -- the shape of CoinAnk's abuse wall landing on a warm cache.
type wallDoer struct {
	body string
	mu   sync.Mutex
	reqs int
}

func (w *wallDoer) Do(req *http.Request) (*http.Response, error) {
	w.mu.Lock()
	w.reqs++
	first := w.reqs == 1
	w.mu.Unlock()
	body := transientRefusalBody
	if first {
		body = w.body
	}
	return &http.Response{
		StatusCode: 200,
		Header:     http.Header{},
		Body:       io.NopCloser(strings.NewReader(body)),
	}, nil
}

// TestStaleServedWhenUpstreamWalls is the labelled fallback's whole contract:
// a primed cache older than the mode TTL plus a wall upstream must yield the
// OLD data with Cache=STALE and the ORIGINAL FetchedAt -- not a 502, and never
// a fresh-looking 200. The retry must still have RUN first: stale is the
// fallback after the bounded attempts, not a bypass of them.
func TestStaleServedWhenUpstreamWalls(t *testing.T) {
	d := &wallDoer{body: fundingBody}
	f := newTestFetcher(t, d)
	url := Base + "/api/fundingRate/current"
	base := time.UnixMilli(1790969044000)
	f.now = func() time.Time { return base }

	if _, info, err := f.Fetch(context.Background(), url); err != nil || info.Cache != "MISS" {
		t.Fatalf("prime: info=%+v err=%v", info, err)
	}
	// Ten minutes later the fundingRate TTL (300s) has expired and upstream
	// is refusing every attempt.
	f.now = func() time.Time { return base.Add(600 * time.Second) }
	res, info, err := f.Fetch(context.Background(), url)
	if err != nil {
		t.Fatalf("Fetch with a wall + primed cache must serve stale, got %v", err)
	}
	if info.Cache != "STALE" {
		t.Errorf("Cache = %q, want STALE", info.Cache)
	}
	if info.FetchedAt != base.Unix() {
		t.Errorf("STALE FetchedAt = %d, want the ORIGINAL fetch time %d", info.FetchedAt, base.Unix())
	}
	if !res.Envelope.Success || len(res.Envelope.Data) == 0 {
		t.Error("the stale body must be the real decoded payload")
	}
	if want := 1 + maxAttempts; d.reqs != want {
		t.Errorf("upstream requests = %d, want %d (prime + maxAttempts)", d.reqs, want)
	}
}

// TestFreshNeverServesStale: fresh=1 asks for the LIVE truth, so it must fail
// rather than fall back. The live verifier depends on exactly this.
func TestFreshNeverServesStale(t *testing.T) {
	d := &wallDoer{body: fundingBody}
	f := newTestFetcher(t, d)
	url := Base + "/api/longshort/all"
	base := time.UnixMilli(1790969044000)
	f.now = func() time.Time { return base }
	if _, _, err := f.Fetch(context.Background(), url); err != nil {
		t.Fatalf("prime: %v", err)
	}
	f.now = func() time.Time { return base.Add(600 * time.Second) }
	_, info, err := f.FetchFresh(context.Background(), url)
	if err == nil {
		t.Fatal("fresh=1 must never fall back to a stale body")
	}
	if info.Cache == "STALE" {
		t.Errorf("fresh path reported STALE (info=%+v)", info)
	}
}

// TestStaleOlderThanMaxStaleIsRefused bounds the fallback: past maxStaleSec the
// numbers stop being usable even labelled, so the refusal goes loud again.
func TestStaleOlderThanMaxStaleIsRefused(t *testing.T) {
	d := &wallDoer{body: fundingBody}
	f := newTestFetcher(t, d)
	url := Base + "/api/hyper/topPosition"
	base := time.UnixMilli(1790969044000)
	f.now = func() time.Time { return base }
	if _, _, err := f.Fetch(context.Background(), url); err != nil {
		t.Fatalf("prime: %v", err)
	}
	f.now = func() time.Time { return base.Add((maxStaleSec + 600) * time.Second) }
	_, info, err := f.Fetch(context.Background(), url)
	if err == nil {
		t.Fatal("a body older than maxStaleSec must not be served as stale")
	}
	if info.Cache == "STALE" {
		t.Errorf("over-age body reported STALE (info=%+v)", info)
	}
}

// TestStaleRequiresADecodableBody: with an empty cache the refusal stands --
// the fallback serves data, never invents it.
func TestStaleRequiresADecodableBody(t *testing.T) {
	f := newTestFetcher(t, &fakeDoer{status: 200, body: transientRefusalBody})
	_, _, err := f.Fetch(context.Background(), Base+"/api/etf/etfInflow")
	if err == nil {
		t.Fatal("a wall with no cached body must be an error")
	}
	var he *HardError
	if !errors.As(err, &he) {
		t.Fatalf("want the upstream HardError, got %T: %v", err, err)
	}
}

// barrierDoer blocks every call until release and counts them -- the
// single-flight proof needs the leader parked upstream while joiners arrive.
type barrierDoer struct {
	mu      sync.Mutex
	calls   int
	entered chan struct{}
	release chan struct{}
}

func (b *barrierDoer) Do(req *http.Request) (*http.Response, error) {
	b.mu.Lock()
	b.calls++
	b.mu.Unlock()
	b.entered <- struct{}{}
	<-b.release
	return &http.Response{
		StatusCode: 200,
		Header:     http.Header{},
		Body:       io.NopCloser(strings.NewReader(fundingBody)),
	}, nil
}

// TestSingleFlightSharesOneUpstreamFetch: eight concurrent readers of one URL
// must produce exactly ONE upstream request. This is a burst-suppression
// property first (CoinAnk's wall trips on bursts) and a bandwidth saving
// second.
func TestSingleFlightSharesOneUpstreamFetch(t *testing.T) {
	b := &barrierDoer{entered: make(chan struct{}), release: make(chan struct{})}
	f := newTestFetcher(t, b)
	url := Base + "/api/fundingRate/current"

	const n = 8
	var wg sync.WaitGroup
	errs := make([]error, n)
	infos := make([]CacheInfo, n)
	for i := range n {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, infos[i], errs[i] = f.Fetch(context.Background(), url)
		}(i)
	}
	// The leader is parked upstream; give the other callers time to reach the
	// flight table before the response is released.
	<-b.entered
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	b.release <- struct{}{}
	wg.Wait()

	for i := range errs {
		if errs[i] != nil {
			t.Fatalf("caller %d: %v", i, errs[i])
		}
		if infos[i].Cache == "STALE" {
			t.Errorf("caller %d served STALE on a healthy upstream", i)
		}
	}
	b.mu.Lock()
	calls := b.calls
	b.mu.Unlock()
	if calls != 1 {
		t.Errorf("upstream calls = %d, want 1 (single-flight)", calls)
	}
}

// TestEnvelopeMarksStaleServe pins the envelope half: a stale fetch must reach
// the wire shape as stale + staleAgeSec, with a derived line that says so.
func TestEnvelopeMarksStaleServe(t *testing.T) {
	d := &wallDoer{body: fundingBody}
	f := newTestFetcher(t, d)
	svc := Service{F: f}
	base := time.UnixMilli(1790969044000)
	f.now = func() time.Time { return base }
	if _, err := svc.Envelope(context.Background(), "fundingRate", "", false); err != nil {
		t.Fatalf("prime: %v", err)
	}

	at := base.Add(600 * time.Second)
	f.now = func() time.Time { return at }
	Now = func() int64 { return at.Unix() }
	t.Cleanup(func() { Now = func() int64 { return time.Now().Unix() } })

	env, err := svc.Envelope(context.Background(), "fundingRate", "", false)
	if err != nil {
		t.Fatalf("Envelope over a wall must serve stale, got %v", err)
	}
	if !env.Stale || env.StaleAgeSec != 600 {
		t.Errorf("Stale=%v StaleAgeSec=%d, want true/600", env.Stale, env.StaleAgeSec)
	}
	if env.Cache != "STALE" {
		t.Errorf("Cache = %q, want STALE", env.Cache)
	}
	if !strings.Contains(env.Derived, "STALE") {
		t.Errorf("derived must say the serve is stale: %q", env.Derived)
	}
	if env.FetchedAt != base.Unix() {
		t.Errorf("fetchedAt = %d, want the ORIGINAL fetch time %d", env.FetchedAt, base.Unix())
	}
}

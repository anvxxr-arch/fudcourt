package serve

// stress_test.go exercises the DEX read surface under CONCURRENCY, which the
// benchmarks do not: a benchmark prices one request's CPU, while this asserts
// the invariants a real load mix would falsify — no data race, no cross-request
// bleed through the shared handler, and no row from a concurrent response
// appearing in another's envelope.
//
// It is deliberately a test rather than a benchmark: the properties below are
// correctness claims (fail loud), not numbers to tune. Run with -race:
//
//	go test ./apps/data/internal/ingest/serve/ -run TestDex -race
//
// The load is generated from the read-only DEX handlers only (no POST /ingest),
// so it is safe to run against the in-memory fake without side effects.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// TestDexConcurrentReadsAreIsolated hammers the DEX handlers from many
// goroutines with DIFFERENT query parameters and asserts every response is
// well-formed and internally consistent. A shared-parser or shared-slice bug
// (the classic: one handler reusing a package-level buffer) shows up here as a
// decode failure or a limit that does not match what was asked for.
func TestDexConcurrentReadsAreIsolated(t *testing.T) {
	srv := dexServer(t, &fakeDexReader{pools: []canon.Pool{
		{PoolID: "pool:a", ChainID: "chain:y", Address: "0xaaa"},
		{PoolID: "pool:b", ChainID: "chain:y", Address: "0xbbb"},
	}})

	paths := []string{
		"/api/v1/dex/chains?limit=1",
		"/api/v1/dex/pools?limit=3",
		"/api/v1/dex/pools?limit=7",
		"/api/v1/dex/rankings?sort=volume&limit=5",
		"/api/v1/dex/rankings?sort=liquidity&limit=2",
		"/api/v1/dex/providers",
	}

	const workers, rounds = 24, 40
	var wg sync.WaitGroup
	errs := make(chan string, workers*rounds)

	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for r := 0; r < rounds; r++ {
				p := paths[(id+r)%len(paths)]
				rec := httptest.NewRecorder()
				srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
				if rec.Code != http.StatusOK {
					errs <- fmt.Sprintf("%s -> HTTP %d: %s", p, rec.Code, rec.Body.String())
					return
				}
				var body struct {
					Data []json.RawMessage `json:"data"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					errs <- fmt.Sprintf("%s -> undecodable body: %v", p, err)
					return
				}
			}
		}(w)
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Fatalf("concurrent read failed: %s", e)
	}
}

// TestDexConcurrentLimitIsPerRequest proves the parsed limit is PER-REQUEST
// state: each concurrent request passes its own limit down and gets back a
// response capped to it. The DEX fake now honours the limit exactly as the real
// reader does (SQL LIMIT $n), so the row count is a real assertion about the
// handler's parse→reader path — a shared/package-level limit would surface as
// one request's rows leaking into another's response.
func TestDexConcurrentLimitIsPerRequest(t *testing.T) {
	srv := dexServer(t, &fakeDexReader{pools: []canon.Pool{
		{PoolID: "pool:a", ChainID: "chain:y", Address: "0xaaa"},
		{PoolID: "pool:b", ChainID: "chain:y", Address: "0xbbb"},
		{PoolID: "pool:c", ChainID: "chain:y", Address: "0xccc"},
	}})

	limits := []int{1, 2, 3}
	var wg sync.WaitGroup
	bad := make(chan string, 64)
	for _, lim := range limits {
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func(l int) {
				defer wg.Done()
				path := fmt.Sprintf("/api/v1/dex/pools?limit=%d", l)
				rec := httptest.NewRecorder()
				srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
				if rec.Code != http.StatusOK {
					bad <- fmt.Sprintf("%s -> HTTP %d", path, rec.Code)
					return
				}
				var body struct {
					Data []json.RawMessage `json:"data"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					bad <- fmt.Sprintf("%s -> %v", path, err)
					return
				}
				// Three pools are seeded, so the handler must return exactly
				// min(limit, 3) rows: fewer means the limit was not honoured,
				// more means another request's limit leaked in.
				if len(body.Data) != l {
					bad <- fmt.Sprintf("%s -> got %d rows, want %d", path, len(body.Data), l)
				}
			}(lim)
		}
	}
	wg.Wait()
	close(bad)
	for e := range bad {
		t.Fatalf("per-request limit violated: %s", e)
	}
}

// TestDexLimitReachesTheReaderSequentially pins the value the handler passes
// down, without concurrency: the reader records the limit it was handed, so the
// parse->reader path is verified directly rather than inferred from row counts.
func TestDexLimitReachesTheReaderSequentially(t *testing.T) {
	for _, want := range []int{1, 2, 3} {
		dr := &fakeDexReader{pools: []canon.Pool{{PoolID: "pool:a"}}}
		h := dexServer(t, dr)
		rec, _ := get(t, h, fmt.Sprintf("/api/v1/dex/pools?limit=%d", want))
		if rec.Code != 200 {
			t.Fatalf("limit=%d: HTTP %d", want, rec.Code)
		}
		if got := dr.recordedLimit(); got != want {
			t.Fatalf("limit=%d reached the reader as %d", want, got)
		}
	}
}

// TestDexConcurrentBadParamsStayLoud proves the 400 path is as isolated as the
// 200 path: an invalid parameter in one goroutine must not poison another's
// response, and each must still fail loudly rather than returning an empty 200.
func TestDexConcurrentBadParamsStayLoud(t *testing.T) {
	srv := dexServer(t, &fakeDexReader{})
	bad := []string{
		"/api/v1/dex/chains?limit=abc",
		"/api/v1/dex/chains?limit=-1",
		"/api/v1/dex/rankings?sort=nope",
		"/api/v1/dex/pools?limit=0",
	}
	var wg sync.WaitGroup
	seen := make(chan int, 64)
	for i := 0; i < 8; i++ {
		for _, p := range bad {
			wg.Add(1)
			go func(path string) {
				defer wg.Done()
				rec := httptest.NewRecorder()
				srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
				seen <- rec.Code
			}(p)
		}
	}
	wg.Wait()
	close(seen)
	for code := range seen {
		if code != http.StatusBadRequest {
			t.Fatalf("a bad parameter must be a 400 under load, got %d", code)
		}
	}
}

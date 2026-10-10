package serve

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/httpx"
)

// runTimeout bounds one synchronous manual fetch (contract "API surface":
// ctx timeout 60s).
const runTimeout = 60 * time.Second

// ingestRunRequest is the accepted POST body: {"provider","dataset",
// "subject","backfill"}. Subject selects one job's subject when a dataset has
// several (e.g. binance/ohlcv per symbol).
type ingestRunRequest struct {
	Provider string `json:"provider"`
	Dataset  string `json:"dataset"`
	Subject  string `json:"subject"`
	Backfill bool   `json:"backfill"`
}

// handleIngestRun serves POST /ingest/run: find the (provider, dataset)
// module+fetcher, run Fetch ONCE synchronously under a 60s timeout, and
// return the FetchResult JSON. backfill=1 (or JSON "backfill":true) switches
// the Job mode to backfill for the call. Failures are LOUD: 503 envelopes,
// never a fabricated empty result.
func (s *server) handleIngestRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed", "ingest/run is POST-only")
		return
	}
	var req ingestRunRequest
	// An empty body is allowed: provider/dataset must then come from the
	// query string so `curl -XPOST .../ingest/run?provider=binance&dataset=...`
	// works too.
	if r.Body != nil {
		if err := decodeJSONBody(r, &req); err != nil && !errors.Is(err, errEmptyBody) {
			badRequest(w, err.Error())
			return
		}
	}
	q := r.URL.Query()
	if req.Provider == "" {
		req.Provider = q.Get("provider")
	}
	if req.Dataset == "" {
		req.Dataset = q.Get("dataset")
	}
	if req.Subject == "" {
		req.Subject = q.Get("subject")
	}
	if v := q.Get("backfill"); v == "1" || v == "true" {
		req.Backfill = true
	}
	if req.Provider == "" || req.Dataset == "" {
		badRequest(w, "provider and dataset are required")
		return
	}

	m, fetcher, err := findFetcher(s.modules(), req.Provider, req.Dataset)
	if err != nil {
		badRequest(w, err.Error())
		return
	}

	mode := "poll"
	if req.Backfill {
		mode = "backfill"
	}
	job := ingest.Job{
		Provider:   m.Provider(),
		Dataset:    req.Dataset,
		Subject:    req.Subject,
		Mode:       mode,
		Schedule:   0,
		Priority:   3,
		RetryCount: 0,
	}

	ctx, cancel := context.WithTimeout(r.Context(), runTimeout)
	defer cancel()

	res, err := fetcher.Fetch(ctx, job, s.writer())
	if err != nil {
		s.log.Error("api/data: manual fetch failed", "provider", req.Provider,
			"dataset", req.Dataset, "subject", req.Subject, "err", err)
		writeErr(w, http.StatusServiceUnavailable, "fetch_failed", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}

// errEmptyBody marks a zero-byte request body.
var errEmptyBody = errors.New("serve: empty body")

// decodeJSONBody decodes one JSON object; an empty body returns errEmptyBody.
func decodeJSONBody(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	if !dec.More() {
		return errEmptyBody
	}
	if err := dec.Decode(v); err != nil {
		return err
	}
	return nil
}

// findFetcher locates the module by provider and the fetcher by dataset.
func findFetcher(modules []ingest.Module, provider, dataset string) (ingest.Module, ingest.Fetcher, error) {
	for _, m := range modules {
		if m.Provider() != provider {
			continue
		}
		f, ok := m.Fetchers()[dataset]
		if !ok {
			return m, nil, errors.New("unknown dataset " + dataset + " for provider " + provider)
		}
		return m, f, nil
	}
	return nil, nil, errors.New("unknown provider " + provider)
}

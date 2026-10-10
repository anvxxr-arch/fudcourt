// Package serve is the /api/data/* HTTP layer of the fudcourt-data sidecar:
// read handlers over the canon store (internal/canon.Reader), the health
// probe, and the POST-only manual ingest trigger that drives one provider
// fetcher synchronously.
//
// Mounting: main.go registers this package's handler under /api/data/ the
// same way it mounts the research families on its own ServeMux. The handler
// routes by the path AFTER an optional "/api/data" prefix, so it works both
// mounted at the root (full paths in the request URL) and behind a
// StripPrefix("/api/data") mount.
//
// Envelopes (contract "API surface"):
//
//   - reads return {"data": <rows>} with 200
//   - health returns {"ok","db","runs","providers"}
//   - an unknown path is a 404 JSON envelope {"error":{"code":"not_found"}}
//   - a bad query parameter is a 400 envelope {"error":{"code":"bad_request"}}
//   - an underlying store error is a loud 503 envelope
//     {"error":{"code":"unavailable"}} — a handler never substitutes an
//     empty payload for a failed read (never-fake doctrine)
//
// Every response body is written by platform/httpx.WriteJSON.
package serve

import (
	"log/slog"
	"net/http"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// New builds the /api/data/* handler. r is the canon read model, store the
// job registry (retained for the manual trigger's context; the engine owns
// its lifecycle), modules the provider adapters, logger the sidecar logger.
func New(r canon.Reader, store ingest.JobStore, modules func() []ingest.Module, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	s := &server{r: r, store: store, modules: modules, log: logger}
	s.mux = s.routeMux()
	return s
}

// WithWriter returns h with the canon.Writer manual /api/data/ingest/run
// fetches write through. A nil w keeps New's behavior (dynamic store assert,
// else the loud failingWriter). main.go passes the repo — the same Writer the
// engine uses — because the JobStore alone does not persist entities.
func WithWriter(h http.Handler, w canon.Writer) http.Handler {
	s, ok := h.(*server)
	if !ok || w == nil {
		return h
	}
	s.writerOverride = w
	return s
}

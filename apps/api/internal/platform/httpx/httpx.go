// Package httpx is the HTTP plumbing shared by every domain handler: JSON
// framing, the normalized error envelope, request correlation and panic
// containment. No business logic (objective §41).
//
// JSON framing matches apps/data/platform/httpx exactly (JSON.stringify
// compatible escaping, one trailing "\n") so diffing a Go body against a TS
// body never fires on framing.
package httpx

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"runtime/debug"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/errs"
)

type ctxKey int

const requestIDKey ctxKey = 0

// validRequestID bounds what an inbound X-Request-Id may contain. The id
// travels into log lines, so a caller-sent id must match [A-Za-z0-9._-]{1,128}
// or it is replaced with a generated one (log-forging guard).
func validRequestID(id string) bool {
	if len(id) == 0 || len(id) > 128 {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.', r == '_', r == '-':
		default:
			return false
		}
	}
	return true
}

// NewRequestID generates a 16-byte random hex correlation id.
func NewRequestID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "generated-unavailable" // a broken machine, not a routing decision
	}
	return hex.EncodeToString(b[:])
}

// RequestIDFrom returns the correlation id carried by ctx ("" when absent).
func RequestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
}

// RequestID middleware adopts a well-formed inbound X-Request-Id or generates
// one; exposes it on the context and the response header (objective §62).
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if !validRequestID(id) {
			id = NewRequestID()
		}
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey, id)))
	})
}

// Recover contains panics at the handler boundary: the caller gets the
// canonical internal envelope and the stack goes to the log, never the wire
// (objective §43: no internal stack traces to users).
func Recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("panic contained",
					"service", "api",
					"request_id", RequestIDFrom(r.Context()),
					"path", r.URL.Path,
					"panic", rec,
					"stack", string(debug.Stack()),
				)
				WriteError(w, r, errs.New(errs.CategoryInternal, "INTERNAL", "internal error"))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// WriteJSON emits v with JSON.stringify-compatible framing (see package doc).
func WriteJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

// WriteError writes the normalized envelope for err at the status implied by
// its category, stamped with the request id (objective §44).
func WriteError(w http.ResponseWriter, r *http.Request, err *errs.Error) {
	e := errs.From(err)
	if e == nil {
		e = errs.New(errs.CategoryInternal, "INTERNAL", "internal error")
	}
	status := errs.Status(e.Category)
	if status >= 500 {
		slog.Error("request failed",
			"service", "api",
			"request_id", RequestIDFrom(r.Context()),
			"path", r.URL.Path,
			"code", e.Code,
			"error", e.Error(),
		)
	}
	WriteJSON(w, status, errs.Envelope{Error: errs.EnvelopeBody{
		Code:      e.Code,
		Message:   e.Message,
		RequestID: RequestIDFrom(r.Context()),
	}})
}

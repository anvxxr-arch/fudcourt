package main

import (
	"net/http"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/httpx"
)

// errNotFound is the canonical "no route, no resource" refusal. Codes are
// stable (packages/contracts/schemas/error-envelope.json).
var errNotFound = errs.New(errs.CategoryNotFound, "NOT_FOUND", "no such resource")

// routeRefusal is the refusal body of a migrated TS route. Ground truth is the
// actual route files: they answer `{error, detail}` (e.g. admin/members
// `{error: 'unauthorized', detail: 'requires admin tier'}`), and every consumer
// reads exactly those two keys (admin/members-table.tsx reads `body.detail`).
// The error-envelope.json contract requires `code` + `message` and adds
// `request_id` (correlation); those ride ALONGSIDE the legacy keys under their
// schema names, so one body satisfies both shapes (the schema is
// additive-tolerant by design). Field order keeps the legacy keys first, in
// their TS order, so the body is byte-shape-compatible for any consumer.
type routeRefusal struct {
	Error  string `json:"error"`
	Detail string `json:"detail"`
	// Code is the error-envelope.json enum ("the normalized error category",
	// stable contract): validation | authorization | credential | exchange |
	// insufficient_balance | risk_limit | rate_limit | timeout | network |
	// conflict | not_found | internal.
	Code string `json:"code"`
	// Message is the schema's own text ("the server's own error text — display
	// verbatim"); the migrated routes only ever carry one message, so it is the
	// same string as Detail.
	Message string `json:"message"`
	// RequestID correlates the failure (also in the X-Request-Id header).
	RequestID string `json:"request_id"`
}

// wireCode maps an errs category onto the error-envelope.json enum. The enum
// has no `unauthenticated` member (documented divergence: a 401 reports as
// `authorization`, which the schema uses for the whole auth class — the legacy
// `error` token and the status carry the 401/403 nuance). Every emitted code
// is schema-valid; nothing outside the enum ever reaches the wire.
func wireCode(c errs.Category) string {
	if c == errs.CategoryUnauthenticated {
		return string(errs.CategoryAuthorization)
	}
	return string(c)
}

// writeRefusal emits routeRefusal at the status the TS route answered with.
// The status is explicit because the migrated surface must keep the exact
// status its callers already see (401 for "no session, or the session lacks
// the tier", 503 for "Discord is not configured or unavailable", …), which
// errs.Status's pure category mapping cannot express for every one of them.
func writeRefusal(w http.ResponseWriter, r *http.Request, status int, errorToken string, category errs.Category, detail string) {
	httpx.WriteJSON(w, status, routeRefusal{
		Error:     errorToken,
		Detail:    detail,
		Code:      wireCode(category),
		Message:   detail,
		RequestID: httpx.RequestIDFrom(r.Context()),
	})
}

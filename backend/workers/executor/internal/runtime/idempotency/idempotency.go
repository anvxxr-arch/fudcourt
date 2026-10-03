// Package idempotency owns the deterministic identity of executor side
// effects (objective §23): a child order's client order id is derived from its
// execution and sequence so a retried, duplicated or replayed placement maps
// onto the SAME venue order instead of creating a second one, and a fill is
// deduplicated by an account-scoped trade key (DR-021 §62).
//
// Every function here is pure. The invariants are structural: the id space is
// `fud_<executionID>_<sequence>` and nothing else may ever be parsed as one.
package idempotency

import (
	"errors"
	"strconv"
	"strings"
)

// clientOrderPrefix marks every client order id this system mints. A venue id
// or a foreign client id without it is never parsed as ours (objective §23).
const clientOrderPrefix = "fud_"

var (
	// ErrForeignID is returned for any id outside the `fud_<execution>_<sequence>`
	// space: foreign ids are refused, never mis-parsed into a plausible tuple.
	ErrForeignID = errors.New("idempotency: not a fudcourt client order id")
	// ErrInvalidExecutionID is returned when the execution part is empty or
	// contains whitespace: an execution id that cannot round-trip is refused at
	// parse time so it can never silently alias another execution.
	ErrInvalidExecutionID = errors.New("idempotency: invalid execution id")
)

// ClientOrderID returns the deterministic client order id
// `fud_<executionID>_<sequence>` (PRD §66; objective §23).
//
// INVARIANT: for any executionID free of whitespace and any sequence >= 0,
// ParseClientOrderID(ClientOrderID(executionID, sequence)) returns exactly
// (executionID, sequence). Invalid inputs still render deterministically but
// produce ids ParseClientOrderID refuses — the format never lies about content.
func ClientOrderID(executionID string, sequence int) string {
	return clientOrderPrefix + executionID + "_" + strconv.Itoa(sequence)
}

// ParseClientOrderID splits a client order id into (executionID, sequence).
//
// INVARIANT: only ids this package could have minted are accepted. Foreign
// ids, empty parts, signed/zero-padded/non-decimal sequences and execution ids
// containing whitespace are all refused with an error — a near-miss is never
// coerced into a plausible tuple, because a mis-parse here re-targets a live
// order.
func ParseClientOrderID(id string) (string, int, error) {
	if !strings.HasPrefix(id, clientOrderPrefix) {
		return "", 0, ErrForeignID
	}
	rest := id[len(clientOrderPrefix):]
	// The sequence is the trailing run of digits after the LAST underscore, so
	// execution ids may themselves contain underscores without ambiguity.
	i := strings.LastIndexByte(rest, '_')
	if i <= 0 || i == len(rest)-1 {
		return "", 0, ErrForeignID
	}
	executionID := rest[:i]
	seqText := rest[i+1:]
	if !canonicalSequence(seqText) {
		return "", 0, ErrForeignID
	}
	if !validExecutionID(executionID) {
		return "", 0, ErrInvalidExecutionID
	}
	sequence, err := strconv.Atoi(seqText)
	if err != nil || sequence < 0 {
		return "", 0, ErrForeignID
	}
	return executionID, sequence, nil
}

// FillDedupKey returns the account-scoped dedup key for one venue trade
// (DR-021 §62): the ACCOUNT scopes it, so the same trade id reported by two
// accounts (venues recycle trade ids across accounts) yields two distinct keys
// while a replayed event for one account yields exactly one.
//
// INVARIANT: the key is injective over (accountID, exchangeTradeID) — the
// account length prefix means no pair of distinct inputs can collide, whatever
// bytes the components carry.
func FillDedupKey(accountID, exchangeTradeID string) string {
	return strconv.Itoa(len(accountID)) + ":" + accountID + ":" + exchangeTradeID
}

// canonicalSequence reports whether s is a plain non-negative decimal integer
// in canonical form ("0" or a digit run without leading zeros).
func canonicalSequence(s string) bool {
	if s == "" {
		return false
	}
	if s == "0" {
		return true
	}
	if s[0] == '0' {
		return false // leading zeros are not canonical: "007" must not parse as 7
	}
	for i := range len(s) {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// validExecutionID reports whether the execution part can round-trip: non-empty
// and free of whitespace (which would make the id space ambiguous).
func validExecutionID(s string) bool {
	if s == "" {
		return false
	}
	for i := range len(s) {
		if c := s[i]; c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == 0 {
			return false
		}
	}
	return true
}

// RequestID mints a per-placement request id: `req_<executionID>_<sequence>`.
//
// PRD §66 / objective §23 names four identifiers that must exist before any
// live-mode cutover: execution_id, request_id, client_order_id, event_id. Three
// were already here; this is the fourth. It is NOT the same thing as
// ClientOrderID: the request id identifies the placement REQUEST (one per
// SubmitOrder call, so a retried submit is a duplicate request), while the
// client order id identifies the VENUE order it maps onto (a retry maps to the
// same order). Confusing the two is how a restart re-sends an order: the worker
// would see a "new" request id and place a second venue order for an execution
// that already has one.
//
// INVARIANT: ParseRequestID(RequestID(executionID, sequence)) returns exactly
// (executionID, sequence); foreign ids are refused, so a request id can never be
// mistaken for a client order id or vice versa (different prefixes).
func RequestID(executionID string, sequence int) string {
	return "req_" + executionID + "_" + strconv.Itoa(sequence)
}

// ParseRequestID splits a request id into (executionID, sequence). Only ids
// this package could have minted are accepted; a foreign id (e.g. a client
// order id `fud_...`) is refused, which is the whole point of the distinct
// prefix — the two id spaces must never be cross-parsed. It reuses the
// sequence/execution validators rather than ParseClientOrderID, which would
// reject the `req_` prefix it does not own.
func ParseRequestID(id string) (string, int, error) {
	if !strings.HasPrefix(id, "req_") {
		return "", 0, ErrForeignID
	}
	rest := id[len("req_"):]
	i := strings.LastIndexByte(rest, '_')
	if i <= 0 || i == len(rest)-1 {
		return "", 0, ErrForeignID
	}
	executionID := rest[:i]
	seqText := rest[i+1:]
	if !canonicalSequence(seqText) || !validExecutionID(executionID) {
		return "", 0, ErrForeignID
	}
	sequence, err := strconv.Atoi(seqText)
	if err != nil || sequence < 0 {
		return "", 0, ErrForeignID
	}
	return executionID, sequence, nil
}

// Package audit is the append-only record of what happened: who did what, to
// which object, and how it ended. Invariant: audit records are facts, never
// mutated in place — a correction is a NEW record referencing the wrong one,
// because rewriting history would make the trail untrustworthy exactly where
// it matters most (disputes, incident review, compliance).
package audit

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
)

// Action is a domain event verb. Invariant: only the named actions are
// modeled; a new event kind MUST get a constant here rather than a free
// string, so the trail stays greppable and schema'd.
type Action string

// The modeled domain events.
const (
	// ActionExecutionCreated records an execution being planned.
	ActionExecutionCreated Action = "EXECUTION_CREATED"
	// ActionExecutionStarted records an execution beginning to work.
	ActionExecutionStarted Action = "EXECUTION_STARTED"
	// ActionExecutionPaused records a manual or risk-driven pause.
	ActionExecutionPaused Action = "EXECUTION_PAUSED"
	// ActionExecutionCancelled records a terminal cancellation.
	ActionExecutionCancelled Action = "EXECUTION_CANCELLED"
	// ActionRiskLimitChanged records a risk ceiling being edited.
	ActionRiskLimitChanged Action = "RISK_LIMIT_CHANGED"
	// ActionCredentialCreated records a credential being minted.
	ActionCredentialCreated Action = "CREDENTIAL_CREATED"
	// ActionCredentialRevoked records a credential being killed.
	ActionCredentialRevoked Action = "CREDENTIAL_REVOKED"
	// ActionExchangeAccountConnected records a venue account link.
	ActionExchangeAccountConnected Action = "EXCHANGE_ACCOUNT_CONNECTED"
	// ActionAdminPermissionChanged records an admin grant/revoke.
	ActionAdminPermissionChanged Action = "ADMIN_PERMISSION_CHANGED"
)

// Refusal codes carried by this package's errors.
const (
	// CodeRecordInvalid is the stable code AUDIT_METADATA_INVALID — the sole
	// audit validation code in the stable code inventory. Invariant: EVERY
	// NewRecord refusal (a missing required field or metadata that cannot be
	// persisted as JSON) carries it and names the offending field in the
	// message; the message, never the code, identifies which input was wrong.
	CodeRecordInvalid = "AUDIT_METADATA_INVALID"
	// CodeMetadataInvalid is the same stable code under the name callers use
	// for metadata refusals.
	CodeMetadataInvalid = "AUDIT_METADATA_INVALID"
)

// Record is one immutable audit fact. Invariant: every field is fixed at
// NewRecord time; Metadata is a deep copy the caller can no longer mutate.
type Record struct {
	// ID uniquely identifies the record; the store must dedupe on it.
	ID string
	// ActorID is who acted (user id or service-account id).
	ActorID string
	// Action is the modeled domain event.
	Action Action
	// ResourceType is the kind of object affected ("execution", ...).
	ResourceType string
	// ResourceID identifies the object within ResourceType.
	ResourceID string
	// RequestID correlates the record with one inbound API request.
	RequestID string
	// ExecutionID correlates the record with one execution lifecycle.
	ExecutionID string
	// Origin is where the action came from ("api", "web", "scheduler", ...).
	Origin string
	// Result is the outcome ("created", "denied", "failed", ...).
	Result string
	// Metadata carries event-specific detail; it is copied and must be
	// JSON-serializable so the store can persist it verbatim.
	Metadata map[string]any
	// OccurredAtMs is when the event happened, epoch milliseconds.
	OccurredAtMs int64
}

// NewRecord validates a Record and returns it with a defensively copied
// Metadata. Refusals name the offending field: required fields are refused
// with AUDIT_RECORD_INVALID, Metadata that cannot be persisted as JSON with
// AUDIT_METADATA_INVALID (an audit record that cannot be stored must never be
// silently accepted and then dropped).
func NewRecord(rec Record) (Record, error) {
	for _, f := range []struct{ name, value string }{
		{"ID", rec.ID},
		{"ActorID", rec.ActorID},
		{"Action", string(rec.Action)},
		{"Result", rec.Result},
	} {
		if f.value == "" {
			return Record{}, errs.New(errs.CategoryValidation, CodeRecordInvalid,
				fmt.Sprintf("audit record field %s is required", f.name))
		}
	}
	if rec.OccurredAtMs <= 0 {
		return Record{}, errs.New(errs.CategoryValidation, CodeRecordInvalid,
			"audit record field OccurredAtMs must be a positive epoch-millisecond timestamp")
	}
	if rec.Metadata != nil {
		if _, err := json.Marshal(rec.Metadata); err != nil {
			return Record{}, errs.Wrap(errs.CategoryValidation, CodeRecordInvalid,
				"field Metadata must be JSON-serializable", err)
		}
		rec.Metadata = deepCopyMap(rec.Metadata)
	}
	return rec, nil
}

// deepCopyMap copies one metadata level and shares nothing mutable with the
// caller: nested maps and slices are rebuilt so later mutation of the input
// cannot rewrite the stored record.
func deepCopyMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = deepCopyValue(v)
	}
	return out
}

func deepCopyValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		return deepCopyMap(t)
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = deepCopyValue(e)
		}
		return out
	default:
		return v
	}
}

// sensitiveKeyFragments mark metadata keys whose values must never be stored
// or shown. Invariant: matching is case-insensitive and substring-based, so
// "X-Api-Key" and "myPassword" are both caught.
var sensitiveKeyFragments = []string{
	"secret", "token", "password", "passphrase", "api_key", "api_secret",
	"private_key", "authorization", "cookie",
}

func isSensitiveKey(key string) bool {
	low := strings.ToLower(key)
	for _, frag := range sensitiveKeyFragments {
		if strings.Contains(low, frag) {
			return true
		}
	}
	return false
}

// Redact returns a copy of metadata safe for storage and display: any value
// under a key whose name case-insensitively contains secret, token, password,
// passphrase, api_key, api_secret, private_key, authorization or cookie is
// replaced by "[REDACTED]". Invariant: redaction recurses through maps AND
// slices — secrets hide inside lists too — and non-secret keys keep their
// values untouched; the input is never mutated.
func Redact(metadata map[string]any) map[string]any {
	if metadata == nil {
		return nil
	}
	out := make(map[string]any, len(metadata))
	for k, v := range metadata {
		if isSensitiveKey(k) {
			out[k] = "[REDACTED]"
			continue
		}
		out[k] = redactValue(v)
	}
	return out
}

func redactValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		return Redact(t)
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = redactValue(e)
		}
		return out
	default:
		return v
	}
}

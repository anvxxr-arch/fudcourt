package repository

// The executor API's persistence port (objective §8.9). The worker's Store
// (store.go) is the runtime loop's narrow contract; this is the wider read/write
// surface the `/api/executor/*` handlers need — accounts, executions, plans,
// events, fills, profiles and the audit log. It lives in this package because
// this package owns the `executor.*` SQL (DR-020); the HTTP handlers in
// internal/api depend on the port, never on pgx.
//
// Every read and write is scoped by user id (PRD §108): ownership is enforced
// in SQL, not only in the handler, so a handler bug cannot read another user's
// row. The two exceptions are documented where they occur (worker-side reads
// and the emergency-stop scan).

import (
	"context"
	"encoding/json"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/platform/credentials"
)

// CredentialRecord is one stored (sealed) exchange account as the API exposes
// it: masked key only, no secret material anywhere. It mirrors the wire
// CredentialRecord and the exchange_accounts row.
type CredentialRecord struct {
	ID           string
	UserID       string
	Exchange     execution.ExchangeID
	Label        string
	APIKeyMasked string
	Permissions  execution.AccountPermissions
	Health       execution.CredentialHealth
	CreatedAt    int64
	UpdatedAt    int64
	LastUsedAt   *int64
	RevokedAt    *int64
}

// CredentialInput seals one credential set for insert. Envelope carries the
// ciphertext + IV + tag; plaintext never reaches this package.
type CredentialInput struct {
	UserID       string
	Exchange     execution.ExchangeID
	Label        string
	APIKeyMasked string
	Envelope     credentials.Envelope
	Permissions  execution.AccountPermissions
	At           int64
}

// AuditEntry is one audit_logs row (PRD §87). Payload is JSON.
type AuditEntry struct {
	UserID  string
	Action  string
	Target  *string
	Payload map[string]any
	At      int64
}

// ExecutorStore is the executor API persistence port. The Postgres-backed
// *Store implements it; tests substitute a memory implementation so the whole
// HTTP surface runs offline and deterministically.
type ExecutorStore interface {
	// --- credentials (PRD §42-47) -----------------------------------------
	ListCredentials(ctx context.Context, userID string) ([]CredentialRecord, error)
	GetCredential(ctx context.Context, userID, id string) (*CredentialRecord, error)
	CreateCredential(ctx context.Context, in CredentialInput) (CredentialRecord, error)
	RevokeCredential(ctx context.Context, userID, id string, at int64) (*CredentialRecord, error)
	UpdateCredentialHealth(ctx context.Context, userID, id string, health execution.CredentialHealth, at int64) error
	TouchCredential(ctx context.Context, userID, id string, at int64) error

	// --- executions (PRD §57-§63) -----------------------------------------
	GetExecution(ctx context.Context, userID, id string) (*execution.ExecutionRecord, error)
	ListExecutions(ctx context.Context, userID string, status *execution.ExecutionStatus, limit int) ([]execution.ExecutionRecord, error)
	// ListRunningExecutions is deliberately NOT user-scoped: it is the
	// emergency-stop scan (PRD §75), which the caller then filters by owner.
	ListRunningExecutions(ctx context.Context) ([]execution.ExecutionRecord, error)
	CreateExecution(ctx context.Context, rec execution.ExecutionRecord, plan json.RawMessage) (execution.ExecutionRecord, error)
	UpdateExecutionStatus(ctx context.Context, id string, status execution.ExecutionStatus, at int64) error
	UpdateExecutionStrategyState(ctx context.Context, id string, state any) error
	GetExecutionPlan(ctx context.Context, executionID string) (json.RawMessage, bool, error)

	// --- child orders, fills, events (PRD §61-§63) ------------------------
	ListChildOrders(ctx context.Context, executionID string) ([]execution.ChildOrderRecord, error)
	UpdateChildOrderStatus(ctx context.Context, executionID, clientOrderID string, status execution.ChildOrderStatus, at int64) error
	ListFills(ctx context.Context, executionID string) ([]execution.FillRecord, error)
	ListEvents(ctx context.Context, executionID string) ([]execution.ExecutionEventRecord, error)
	AppendEvent(ctx context.Context, ev execution.ExecutionEventRecord) (execution.ExecutionEventRecord, error)

	// --- risk profile (PRD §88) -------------------------------------------
	GetRiskProfile(ctx context.Context, userID string) (execution.RiskProfile, error)
	// SummarizePortfolioRisk rolls up the user's committed risk and the day's
	// realized P&L since `sinceMs` (PRD §73/§74). Both figures are decimal
	// strings; a user with no rows answers "0" for both, never an error.
	SummarizePortfolioRisk(ctx context.Context, userID string, sinceMs int64) (openRisk, realizedPnlToday string, err error)
	PutRiskProfile(ctx context.Context, userID string, profile execution.RiskProfile, at int64) (execution.RiskProfile, error)

	// --- audit (PRD §87) --------------------------------------------------
	Audit(ctx context.Context, entry AuditEntry) error
}

package repository

// MemoryStore is the offline, deterministic implementation of ExecutorStore.
// It exists so the executor HTTP surface can be exercised end to end without
// Postgres, Valkey or a venue (the objective's "testable offline" requirement)
// and mirrors the semantics of the Postgres store closely enough that the same
// handler tests are meaningful: user-scoped reads, an append-only event log with
// store-assigned ids, and honest (nil, nil) for a missing row.
//
// It is NOT a production store: nothing here is durable, and a restart loses
// everything (Postgres stays the durable truth, DR-020).

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/platform/decimal"
)

// MemoryStore is a goroutine-safe ExecutorStore held entirely in memory.
type MemoryStore struct {
	mu          sync.Mutex
	credentials map[string]CredentialRecord
	executions  map[string]execution.ExecutionRecord
	execOrder   []string
	plans       map[string]json.RawMessage
	children    map[string]execution.ChildOrderRecord
	fills       map[string]execution.FillRecord
	events      map[string][]execution.ExecutionEventRecord
	profiles    map[string]execution.RiskProfile
	audit       []AuditEntry
	seq         int
}

// NewMemoryStore returns an empty in-memory store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		credentials: map[string]CredentialRecord{},
		executions:  map[string]execution.ExecutionRecord{},
		plans:       map[string]json.RawMessage{},
		children:    map[string]execution.ChildOrderRecord{},
		fills:       map[string]execution.FillRecord{},
		events:      map[string][]execution.ExecutionEventRecord{},
		profiles:    map[string]execution.RiskProfile{},
	}
}

// nextID mints a deterministic uuid-shaped id (the Postgres store uses
// gen_random_uuid; this keeps the shape while staying reproducible in tests).
func (m *MemoryStore) nextID() string {
	m.seq++
	return fmt.Sprintf("00000000-0000-4000-8000-%012d", m.seq)
}

// SeedExecution inserts an execution (and optional plan) directly — the test
// seam for building fixtures.
func (m *MemoryStore) SeedExecution(rec execution.ExecutionRecord, plan json.RawMessage) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec.CreatedAt == 0 {
		rec.CreatedAt = time.Now().UnixMilli()
	}
	if rec.ID == "" {
		rec.ID = m.nextID()
	}
	m.executions[rec.ID] = rec
	m.execOrder = append(m.execOrder, rec.ID)
	if len(plan) > 0 {
		m.plans[rec.ID] = plan
	}
}

// SeedExecutionRecord inserts an execution under a caller-chosen id, returning
// it — the fixture entry point for tests that need a known execution id.
func (m *MemoryStore) SeedExecutionRecord(rec execution.ExecutionRecord) string {
	m.SeedExecution(rec, nil)
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.execOrder[len(m.execOrder)-1]
}

// SeedChild inserts a child order directly (test seam).
func (m *MemoryStore) SeedChild(rec execution.ChildOrderRecord) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.children[rec.ExecutionID+":"+rec.ClientOrderID] = rec
}

// --- credentials -----------------------------------------------------------

// ListCredentials returns the user's accounts newest first.
func (m *MemoryStore) ListCredentials(_ context.Context, userID string) ([]CredentialRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []CredentialRecord{}
	for _, rec := range m.credentials {
		if rec.UserID == userID {
			out = append(out, rec)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt != out[j].CreatedAt {
			return out[i].CreatedAt > out[j].CreatedAt
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// GetCredential returns one owned account or (nil, nil).
func (m *MemoryStore) GetCredential(_ context.Context, userID, id string) (*CredentialRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.credentials[id]
	if !ok || rec.UserID != userID {
		return nil, nil
	}
	return &rec, nil
}

// CreateCredential stores one sealed account.
func (m *MemoryStore) CreateCredential(_ context.Context, in CredentialInput) (CredentialRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec := CredentialRecord{
		ID:           m.nextID(),
		UserID:       in.UserID,
		Exchange:     in.Exchange,
		Label:        in.Label,
		APIKeyMasked: in.APIKeyMasked,
		Permissions:  in.Permissions,
		Health:       execution.HealthActive,
		CreatedAt:    in.At,
		UpdatedAt:    in.At,
	}
	m.credentials[rec.ID] = rec
	return rec, nil
}

// RevokeCredential marks one owned account revoked.
func (m *MemoryStore) RevokeCredential(_ context.Context, userID, id string, at int64) (*CredentialRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.credentials[id]
	if !ok || rec.UserID != userID {
		return nil, nil
	}
	rec.RevokedAt = &at
	rec.UpdatedAt = at
	rec.Health = execution.HealthRevoked
	m.credentials[id] = rec
	return &rec, nil
}

// UpdateCredentialHealth sets the health verdict.
func (m *MemoryStore) UpdateCredentialHealth(_ context.Context, userID, id string, health execution.CredentialHealth, at int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.credentials[id]
	if !ok || rec.UserID != userID {
		return nil
	}
	rec.Health = health
	rec.UpdatedAt = at
	m.credentials[id] = rec
	return nil
}

// TouchCredential records last use.
func (m *MemoryStore) TouchCredential(_ context.Context, userID, id string, at int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.credentials[id]
	if !ok || rec.UserID != userID {
		return nil
	}
	rec.LastUsedAt = &at
	rec.UpdatedAt = at
	m.credentials[id] = rec
	return nil
}

// --- executions ------------------------------------------------------------

// GetExecution returns one owned execution or (nil, nil).
func (m *MemoryStore) GetExecution(_ context.Context, userID, id string) (*execution.ExecutionRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.executions[id]
	if !ok || rec.UserID != userID {
		return nil, nil
	}
	return &rec, nil
}

// ListExecutions returns the user's history newest first, optionally filtered.
func (m *MemoryStore) ListExecutions(_ context.Context, userID string, status *execution.ExecutionStatus, limit int) ([]execution.ExecutionRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if limit < 1 {
		limit = 1
	}
	out := []execution.ExecutionRecord{}
	for i := len(m.execOrder) - 1; i >= 0; i-- {
		rec := m.executions[m.execOrder[i]]
		if rec.UserID != userID {
			continue
		}
		if status != nil && rec.Status != *status {
			continue
		}
		out = append(out, rec)
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

// ListRunningExecutions returns the emergency-stop scan set (unscoped).
func (m *MemoryStore) ListRunningExecutions(_ context.Context) ([]execution.ExecutionRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []execution.ExecutionRecord{}
	for _, id := range m.execOrder {
		rec := m.executions[id]
		switch rec.Status {
		case execution.StatusRunning, execution.StatusPartiallyFilled, execution.StatusReconciling:
			out = append(out, rec)
		}
	}
	return out, nil
}

// CreateExecution stores the execution and its immutable plan snapshot.
func (m *MemoryStore) CreateExecution(_ context.Context, rec execution.ExecutionRecord, plan json.RawMessage) (execution.ExecutionRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec.CreatedAt == 0 {
		rec.CreatedAt = time.Now().UnixMilli()
	}
	rec.ID = m.nextID()
	m.executions[rec.ID] = rec
	m.execOrder = append(m.execOrder, rec.ID)
	if len(plan) > 0 {
		m.plans[rec.ID] = plan
	}
	return rec, nil
}

// UpdateExecutionStatus moves the status and derives the lifecycle timestamps.
func (m *MemoryStore) UpdateExecutionStatus(_ context.Context, id string, status execution.ExecutionStatus, at int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.executions[id]
	if !ok {
		return nil
	}
	if status == execution.StatusRunning && rec.StartedAt == 0 {
		rec.StartedAt = at
	}
	switch status {
	case execution.StatusFilled, execution.StatusFailed, execution.StatusCancelled,
		execution.StatusRiskStopped, execution.StatusExpired, execution.StatusStopped:
		if rec.CompletedAt == 0 {
			rec.CompletedAt = at
		}
	}
	if status == execution.StatusCancelled && rec.CancelledAt == 0 {
		rec.CancelledAt = at
	}
	rec.Status = status
	m.executions[id] = rec
	return nil
}

// UpdateExecutionStrategyState writes the opaque engine state.
func (m *MemoryStore) UpdateExecutionStrategyState(_ context.Context, id string, state any) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.executions[id]
	if !ok {
		return nil
	}
	rec.EngineState = state
	m.executions[id] = rec
	return nil
}

// GetExecutionPlan returns the immutable plan JSON.
func (m *MemoryStore) GetExecutionPlan(_ context.Context, executionID string) (json.RawMessage, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	plan, ok := m.plans[executionID]
	return plan, ok, nil
}

// --- child orders, fills, events -------------------------------------------

// ListChildOrders returns the execution's children, oldest first.
func (m *MemoryStore) ListChildOrders(_ context.Context, executionID string) ([]execution.ChildOrderRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []execution.ChildOrderRecord{}
	for _, rec := range m.children {
		if rec.ExecutionID == executionID {
			out = append(out, rec)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].SubmittedAt != out[j].SubmittedAt {
			return out[i].SubmittedAt < out[j].SubmittedAt
		}
		return out[i].ClientOrderID < out[j].ClientOrderID
	})
	return out, nil
}

// UpdateChildOrderStatus updates one child by its row key.
func (m *MemoryStore) UpdateChildOrderStatus(_ context.Context, executionID, clientOrderID string, status execution.ChildOrderStatus, at int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := executionID + ":" + clientOrderID
	rec, ok := m.children[key]
	if !ok {
		return nil
	}
	rec.Status = status
	rec.UpdatedAt = at
	m.children[key] = rec
	return nil
}

// ListFills returns the execution's fills, oldest first.
func (m *MemoryStore) ListFills(_ context.Context, executionID string) ([]execution.FillRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []execution.FillRecord{}
	for _, rec := range m.fills {
		if rec.ExecutionID == executionID {
			out = append(out, rec)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Timestamp < out[j].Timestamp })
	return out, nil
}

// ListEvents returns the append-only event log (store-assigned ids).
func (m *MemoryStore) ListEvents(_ context.Context, executionID string) ([]execution.ExecutionEventRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]execution.ExecutionEventRecord, len(m.events[executionID]))
	copy(out, m.events[executionID])
	return out, nil
}

// AppendEvent appends one immutable event, assigning the store-owned id.
func (m *MemoryStore) AppendEvent(_ context.Context, ev execution.ExecutionEventRecord) (execution.ExecutionEventRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if ev.Payload == nil {
		ev.Payload = map[string]any{}
	}
	seq := int64(len(m.events[ev.ExecutionID]) + 1)
	ev.ID = EventID(ev.ExecutionID, seq)
	m.events[ev.ExecutionID] = append(m.events[ev.ExecutionID], ev)
	return ev, nil
}

// --- risk profile ----------------------------------------------------------

// GetRiskProfile returns the stored profile (zero value when absent).
func (m *MemoryStore) GetRiskProfile(_ context.Context, userID string) (execution.RiskProfile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.profiles[userID], nil
}

// PutRiskProfile upserts the profile.
func (m *MemoryStore) PutRiskProfile(_ context.Context, userID string, profile execution.RiskProfile, _ int64) (execution.RiskProfile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.profiles[userID] = profile
	return profile, nil
}

// --- portfolio rollup ------------------------------------------------------

// SummarizePortfolioRisk sums the user's open risk and the day's realized P&L.
// The realized-P&L part is the Postgres SQL's arithmetic expressed in Go over
// the seeded rows; a store with no fills answers 0 for both.
func (m *MemoryStore) SummarizePortfolioRisk(_ context.Context, userID string, sinceMs int64) (string, string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	openRisk := "0"
	for _, id := range m.execOrder {
		rec := m.executions[id]
		if rec.UserID != userID {
			continue
		}
		switch rec.Status {
		case execution.StatusReady, execution.StatusRunning, execution.StatusPartiallyFilled,
			execution.StatusPaused, execution.StatusReconciling:
			risk := rec.PlannedRisk
			if rec.CurrentRisk != nil {
				risk = rec.CurrentRisk
			}
			if risk != nil {
				openRisk = addOrZero(openRisk, *risk)
			}
		}
	}
	realized := "0"
	for _, id := range m.execOrder {
		rec := m.executions[id]
		if rec.UserID != userID || rec.CompletedAt == 0 || rec.CompletedAt < sinceMs || rec.AverageFillPrice == nil {
			continue
		}
		exitQty, exitValue, fees := "0", "0", "0"
		for _, f := range m.fills {
			if f.ExecutionID != rec.ID {
				continue
			}
			child, ok := m.children[f.ExecutionID+":"+f.ChildOrderID]
			if !ok {
				continue
			}
			fees = addOrZero(fees, f.Fee)
			if child.IsExit {
				exitQty = addOrZero(exitQty, f.Quantity)
				exitValue = addOrZero(exitValue, mulOrZero(f.Price, f.Quantity))
			}
		}
		entryCost := mulOrZero(exitQty, *rec.AverageFillPrice)
		realized = addOrZero(realized, subOrZero(subOrZero(exitValue, entryCost), fees))
	}
	return openRisk, realized, nil
}

// --- audit -----------------------------------------------------------------

// Audit appends one audit entry.
func (m *MemoryStore) Audit(_ context.Context, entry AuditEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.audit = append(m.audit, entry)
	return nil
}

// AuditLog returns the recorded audit entries (test surface).
func (m *MemoryStore) AuditLog() []AuditEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]AuditEntry, len(m.audit))
	copy(out, m.audit)
	return out
}

// decimal helpers local to the memory store (no float64 in financial paths).
func addOrZero(a, b string) string { return ratOp(a, b, "+") }
func subOrZero(a, b string) string { return ratOp(a, b, "-") }
func mulOrZero(a, b string) string { return ratOp(a, b, "*") }

// ratOp applies an exact decimal op via the platform decimal package, answering
// "0" when either operand is malformed (the operand came from a validated row).
func ratOp(a, b, op string) string {
	var (
		out string
		err error
	)
	switch op {
	case "+":
		out, err = decimal.Add(a, b)
	case "-":
		out, err = decimal.Sub(a, b)
	case "*":
		out, err = decimal.Mul(a, b)
	default:
		return "0"
	}
	if err != nil {
		return "0"
	}
	return out
}

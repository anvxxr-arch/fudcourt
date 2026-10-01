package repository

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/services/executor/internal/executor"
)

// uuid returns a deterministic-ish uuid-shaped string for tests.
func uuid(n int) string {
	return fmt.Sprintf("00000000-0000-0000-0000-%012d", n)
}

func newExec(id string) executor.ExecutionRecord {
	now := time.Now().UnixMilli()
	return executor.ExecutionRecord{
		ID:                id,
		UserID:            uuid(2),
		AccountID:         uuid(3),
		Exchange:          "binance",
		Symbol:            "BTCUSDT",
		MarketType:        "spot",
		Side:              "buy",
		Status:            "DRAFT",
		Mode:              "paper",
		SizingMode:        "risk_usd",
		SizingValue:       "100",
		EntryDefinition:   executor.EntryDefinition{Kind: "market"},
		TakeProfit:        []executor.TakeProfitLevel{},
		ExecutionStrategy: "market",
		ExecutionConfig:   executor.ExecutionConfig{},
		Constraints:       executor.ExecutionConstraints{},
		PlannedQuantity:   "0.001",
		PlannedNotional:   "100",
		ActualQuantity:    "0",
		ActualNotional:    "0",
		ActualFees:        "0",
		EngineState:       map[string]any{},
		CreatedAt:         now,
	}
}

func newChild(executionID, clientOrderID string) executor.ChildOrderRecord {
	return executor.ChildOrderRecord{
		ID:             childRowKey(executionID, clientOrderID),
		ExecutionID:    executionID,
		ClientOrderID:  clientOrderID,
		Symbol:         "BTCUSDT",
		Side:           "buy",
		Type:           "market",
		Quantity:       "0.001",
		FilledQuantity: "0",
		Status:         "PLANNED",
		IsExit:         false,
		SubmittedAt:    time.Now().UnixMilli(),
	}
}

func newEvent(executionID string) executor.ExecutionEventRecord {
	return executor.ExecutionEventRecord{
		ExecutionID: executionID,
		Name:        executor.EventExecutionCreated,
		Payload:     map[string]any{"status": "DRAFT"},
		CreatedAt:   time.Now().UnixMilli(),
	}
}

// ---------------------------------------------------------------------------
// Pure boundary conversions (no database required)
// ---------------------------------------------------------------------------

func TestDecRefusal(t *testing.T) {
	if _, err := dec("qty", "not-a-number"); err == nil {
		t.Fatal("dec: expected error for unparseable decimal, got nil")
	}
	empty := ""
	if _, err := decPtr("price", &empty); err == nil {
		t.Fatal("decPtr: expected error for empty-but-present string, got nil")
	}
	if v, err := decPtr("price", nil); err != nil || v != nil {
		t.Fatalf("decPtr(nil): expected nil,nil, got %v,%v", v, err)
	}
	if v, err := dec("qty", "1.5"); err != nil || v != 1.5 {
		t.Fatalf("dec(1.5): expected 1.5,nil, got %v,%v", v, err)
	}
}

// ---------------------------------------------------------------------------
// DSN-gated tests
// ---------------------------------------------------------------------------

func TestStoreNewFailLoud(t *testing.T) {
	u := os.Getenv("FUDCOURT_EXECUTOR_PG_URL")
	if u == "" {
		t.Skip("FUDCOURT_EXECUTOR_PG_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s, err := New(ctx, u)
	if err != nil {
		t.Fatalf("New(%q): %v", u, err)
	}
	s.Close()

	if _, err := New(ctx, "postgres://nope@127.0.0.1:1/nope"); err == nil {
		t.Fatal("New(bad url): expected error, got nil")
	}
}

func TestStoreEndToEnd(t *testing.T) {
	u := os.Getenv("FUDCOURT_EXECUTOR_PG_URL")
	if u == "" {
		t.Skip("FUDCOURT_EXECUTOR_PG_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s, err := New(ctx, u)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

	// Seed the exchange account the execution's FK points at
	// (executions.account_id → exchange_accounts.id). The store has NO
	// account-writing method — accounts are owned by the API service — so a
	// DSN-gated run must create the row directly, exactly as that service would.
	// Without it every SaveExecution violates the FK and this test could never
	// have passed against the real schema.
	if _, err := s.pool.Exec(ctx, `
		insert into executor.exchange_accounts
			(id, user_id, exchange, label, api_key_masked, api_key_encrypted,
			 api_secret_encrypted, iv, auth_tag, permissions, health, created_at, updated_at)
		values ($1,$2,'binance','e2e','****',$3,$4,$5,$6,'{}'::jsonb,'ACTIVE',$7,$7)
		on conflict (id) do nothing`,
		uuid(3), uuid(2), []byte{1}, []byte{2}, []byte{3}, []byte{4}, time.Now().UnixMilli()); err != nil {
		t.Fatalf("seed exchange account: %v", err)
	}

	exec := newExec(uuid(1))
	if err := s.SaveExecution(ctx, exec); err != nil {
		t.Fatalf("SaveExecution: %v", err)
	}

	// Upsert: saving the same id twice must not fork a row.
	if err := s.SaveExecution(ctx, exec); err != nil {
		t.Fatalf("SaveExecution(upsert): %v", err)
	}
	got, err := s.LoadRecoverable(ctx)
	if err != nil {
		t.Fatalf("LoadRecoverable: %v", err)
	}
	var count int
	for _, r := range got {
		if r.ID == exec.ID {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("LoadRecoverable: expected 1 row for id, got %d", count)
	}

	child := newChild(exec.ID, "fud_exec_1_1")
	if err := s.SaveChildOrder(ctx, child); err != nil {
		t.Fatalf("SaveChildOrder: %v", err)
	}
	if err := s.SaveChildOrder(ctx, child); err != nil {
		t.Fatalf("SaveChildOrder(upsert): %v", err)
	}
	children, err := s.ListChildOrders(ctx, exec.ID)
	if err != nil {
		t.Fatalf("ListChildOrders: %v", err)
	}
	if len(children) != 1 {
		t.Fatalf("ListChildOrders: expected 1 child, got %d", len(children))
	}

	ev := newEvent(exec.ID)
	saved, err := s.AppendEvent(ctx, ev)
	if err != nil {
		t.Fatalf("AppendEvent: %v", err)
	}
	if saved.ID == "" {
		t.Fatal("AppendEvent: returned empty id")
	}
	seq, ok := ParseEventSeq(saved.ID)
	if !ok {
		t.Fatalf("AppendEvent: id %q is not minted by this store", saved.ID)
	}
	if saved.ID != EventID(exec.ID, seq) {
		t.Fatalf("AppendEvent: id %q != EventID(%q,%d)", saved.ID, exec.ID, seq)
	}
	back, err := s.EventSeq(ctx, saved.ID)
	if err != nil {
		t.Fatalf("EventSeq: %v", err)
	}
	if back != seq {
		t.Fatalf("EventSeq: expected %d, got %d", seq, back)
	}

	ev2 := newEvent(exec.ID)
	saved2, err := s.AppendEvent(ctx, ev2)
	if err != nil {
		t.Fatalf("AppendEvent(2): %v", err)
	}
	seq2, _ := ParseEventSeq(saved2.ID)
	if seq2 <= seq {
		t.Fatalf("AppendEvent monotonic: seq %d not > %d", seq2, seq)
	}
}

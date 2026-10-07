package repository

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestListExecutionsSkipsUnreadableRow is the regression for a single malformed
// row blinding the whole list. The list endpoint must serve the healthy rows and
// skip the bad one (logging it), never 500 the entire list for its owner.
func TestListExecutionsSkipsUnreadableRow(t *testing.T) {
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

	// Seed the account the FK points at (executions.account_id →
	// exchange_accounts.id), exactly as the API service would.
	if _, err := s.pool.Exec(ctx, `
		insert into executor.exchange_accounts
			(id, user_id, exchange, label, api_key_masked, api_key_encrypted,
			 api_secret_encrypted, iv, auth_tag, permissions, health, created_at, updated_at)
		values ($1,$2,'binance','e2e','****',$3,$4,$5,$6,'{}'::jsonb,'ACTIVE',$7,$7)
		on conflict (id) do nothing`,
		uuid(3), uuid(2), []byte{1}, []byte{2}, []byte{3}, []byte{4}, time.Now().UnixMilli()); err != nil {
		t.Fatalf("seed exchange account: %v", err)
	}

	good := newExec(uuid(901))
	bad := newExec(uuid(902))
	if err := s.SaveExecution(ctx, good); err != nil {
		t.Fatalf("SaveExecution(good): %v", err)
	}
	if err := s.SaveExecution(ctx, bad); err != nil {
		t.Fatalf("SaveExecution(bad): %v", err)
	}

	// Corrupt ONE row through raw SQL, the way a hand edit or a schema drift
	// would: `price` as a JSON number, which the decimal-as-string contract
	// (EntryDefinition.Price is a string) refuses to unmarshal.
	if _, err := s.pool.Exec(ctx,
		`update executor.executions set entry_definition = '{"type":"limit","price":100000}'::jsonb where id = $1`,
		bad.ID); err != nil {
		t.Fatalf("corrupt row: %v", err)
	}
	// A deferred delete, registered AFTER `defer s.Close()`, so it runs BEFORE
	// the pool closes (defers are LIFO). t.Cleanup would run after Close and
	// silently fail against a dead pool, leaking the two rows.
	defer func() {
		_, _ = s.pool.Exec(context.Background(), `delete from executor.executions where id = any($1)`,
			[]string{good.ID, bad.ID})
	}()

	recs, err := s.ListExecutions(ctx, uuid(2), nil, 200)
	if err != nil {
		t.Fatalf("ListExecutions returned an error for one bad row: %v", err)
	}
	var sawGood, sawBad bool
	for _, r := range recs {
		switch r.ID {
		case good.ID:
			sawGood = true
		case bad.ID:
			sawBad = true
		}
	}
	if !sawGood {
		t.Fatalf("healthy row was not served (got %d rows)", len(recs))
	}
	if sawBad {
		t.Fatalf("unreadable row was served instead of skipped")
	}
}

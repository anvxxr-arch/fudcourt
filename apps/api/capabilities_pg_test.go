package main

import (
	"context"
	"os"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/access/capability"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestPGCapabilityMappingRoundTrip exercises the REAL SQL in capabilities.go against a live Postgres
// carrying db/schema/pg-schema.sql — the one thing a fake store cannot check: that every column the Go
// code reads or writes actually exists in the schema with the right type. Skipped unless
// FUDCOURT_TEST_PG_URL is set (the default `go test` has no database), so it is a no-op locally and a
// live guard wherever the schema is applied first.
func TestPGCapabilityMappingRoundTrip(t *testing.T) {
	url := os.Getenv("FUDCOURT_TEST_PG_URL")
	if url == "" {
		t.Skip("set FUDCOURT_TEST_PG_URL to run the live Postgres round-trip")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	store := newPGCapabilityStore(pool)
	// A unique guild id keeps a SHARED database undisturbed: everything this test writes is namespaced
	// to it and removed on the way out.
	guild := "cap-test-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM discord_role_capabilities WHERE guild_id = $1`, guild)
	})
	const roleA, roleB = "800000000000000001", "900000000000000002"

	for _, w := range []struct {
		role   string
		grants []string
	}{{roleA, []string{"moderation.*", "logs.read"}}, {roleB, []string{"feeds.read"}}} {
		if err := store.replaceRole(ctx, guild, w.role, w.grants, "42"); err != nil {
			t.Fatalf("replace %s: %v", w.role, err)
		}
	}
	got, err := store.listGrants(ctx, guild)
	if err != nil {
		t.Fatalf("listGrants: %v", err)
	}
	if want := []string{"logs.read", "moderation.*"}; !reflect.DeepEqual(got[roleA], want) {
		t.Fatalf("role A = %v, want %v (the SQL orders by capability)", got[roleA], want)
	}
	if want := []string{"feeds.read"}; !reflect.DeepEqual(got[roleB], want) {
		t.Fatalf("role B = %v, want %v", got[roleB], want)
	}

	// granted_by is STORED, not merely accepted: the column exists and carries the actor.
	var actor string
	if err := pool.QueryRow(ctx,
		`SELECT granted_by FROM discord_role_capabilities WHERE guild_id = $1 AND role_id = $2 AND capability = 'logs.read'`,
		guild, roleA).Scan(&actor); err != nil {
		t.Fatalf("granted_by: %v", err)
	}
	if actor != "42" {
		t.Fatalf("granted_by = %q, want the actor id", actor)
	}

	// A replace is a DECLARATION: the second write narrows role A and leaves role B alone.
	if err := store.replaceRole(ctx, guild, roleA, []string{"logs.read"}, "42"); err != nil {
		t.Fatalf("narrow: %v", err)
	}
	got, err = store.listGrants(ctx, guild)
	if err != nil {
		t.Fatalf("listGrants: %v", err)
	}
	if want := []string{"logs.read"}; !reflect.DeepEqual(got[roleA], want) {
		t.Fatalf("after a narrowing write role A = %v, want %v", got[roleA], want)
	}
	if want := []string{"feeds.read"}; !reflect.DeepEqual(got[roleB], want) {
		t.Fatalf("a write to one role changed another: %v", got[roleB])
	}

	// An empty declaration REVOKES: the role is absent from the mapping, not present and empty.
	if err := store.replaceRole(ctx, guild, roleA, nil, "42"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	got, err = store.listGrants(ctx, guild)
	if err != nil {
		t.Fatalf("listGrants: %v", err)
	}
	if grants, ok := got[roleA]; ok {
		t.Fatalf("role A still holds %v after a revoke", grants)
	}

	// What was stored resolves to the vocabulary's capabilities, so the round trip ends where the
	// permission check starts.
	set, unknown := capability.Resolve(got[roleB], false)
	if len(unknown) != 0 || !capability.Has(set, "feeds.read") || len(set) != 1 {
		t.Fatalf("resolved %v (unknown %v), want exactly feeds.read", set, unknown)
	}
}

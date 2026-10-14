package main

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestPGCustomCommandsRoundTrip exercises the REAL SQL in customcommands.go
// against a live Postgres carrying db/schema/pg-schema.sql — the one thing a fake
// store cannot check: that every column the Go code reads or writes actually
// exists in the schema, with the right type (text[] arrays, the jsonb responses
// blob, the boolean flags). It is skipped unless FUDCOURT_TEST_PG_URL is set.
func TestPGCustomCommandsRoundTrip(t *testing.T) {
	url := os.Getenv("FUDCOURT_TEST_PG_URL")
	if url == "" {
		t.Skip("set FUDCOURT_TEST_PG_URL to run the live Postgres round-trip")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	store := newPGCustomCommandStore(pool)

	// A guild id that is not any real guild, so the test cannot touch live rows.
	const guild = "999000000000000002"
	cleanup := func() { _ = store.replace(ctx, guild, nil) }
	cleanup()
	defer cleanup()

	cmds := []customCommand{{
		Name:            "rules",
		Aliases:         []string{"rulebook", "therules"},
		Responses:       []commandResponse{{Text: "be nice, {user}"}, {Embed: json.RawMessage(`{"title":"Hi {server}"}`)}},
		AllowedRoles:    []string{"420000000000000042"},
		AllowedChannels: []string{"555000000000000005"},
		CooldownSeconds: 30,
		DeleteTrigger:   true,
		Reply:           true,
		DM:              false,
		Enabled:         true,
	}}
	if err := store.replace(ctx, guild, cmds); err != nil {
		t.Fatalf("replace: %v", err)
	}
	got, err := store.list(ctx, guild)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 command, got %+v", got)
	}
	c := got[0]
	if c.Name != "rules" || len(c.Aliases) != 2 {
		t.Fatalf("name/aliases mismatch: %+v", c)
	}
	if len(c.Responses) != 2 || c.Responses[0].Text != "be nice, {user}" || len(c.Responses[1].Embed) == 0 {
		t.Fatalf("responses mismatch: %+v", c.Responses)
	}
	if len(c.AllowedRoles) != 1 || len(c.AllowedChannels) != 1 {
		t.Fatalf("allow-lists mismatch: %+v", c)
	}
	if c.CooldownSeconds != 30 || !c.DeleteTrigger || !c.Reply || c.DM {
		t.Fatalf("flag mismatch: %+v", c)
	}

	// An empty set must read back as an empty list, never nil (stable wire shape).
	if err := store.replace(ctx, guild, nil); err != nil {
		t.Fatalf("replace empty: %v", err)
	}
	empty, err := store.list(ctx, guild)
	if err != nil {
		t.Fatalf("list empty: %v", err)
	}
	if empty == nil || len(empty) != 0 {
		t.Fatalf("want empty non-nil slice, got %#v", empty)
	}

	// The schema's cooldown CHECK must refuse an out-of-range value.
	if _, err := pool.Exec(ctx,
		`INSERT INTO custom_commands (guild_id, name, cooldown_seconds) VALUES ($1,'bad',999999)`, guild); err == nil {
		t.Fatalf("expected the cooldown CHECK to reject 999999")
	}
}

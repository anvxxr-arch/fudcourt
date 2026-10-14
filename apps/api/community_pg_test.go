package main

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestPGCommunityRoundTrip exercises the REAL SQL in community.go against a
// live Postgres carrying db/schema/pg-schema.sql — the one thing a fake store
// cannot check: that every column the Go code reads or writes actually exists
// in the schema, with the right type. It is skipped unless
// FUDCOURT_TEST_PG_URL is set (the default `go test` has no database), so it is
// a no-op locally and a live guard in CI, where the schema is applied first.
//
// It exists because two schema↔code mismatches slipped past the fake-store
// tests: a welcome `embed` column the schema split into join_embed/leave_embed,
// and role_panel_options queried for `guild_id`/`exclusive_group` that the
// schema had not given it. Both were only visible against a real database.
func TestPGCommunityRoundTrip(t *testing.T) {
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
	store := newPGCommunityStore(pool)

	// A guild id that is not any real guild, so the test cannot touch live rows.
	const guild = "999000000000000001"
	cleanup := func() {
		_ = store.replacePanels(ctx, guild, nil)
		_ = store.replaceAutoroles(ctx, guild, nil)
		_, _ = pool.Exec(ctx, `DELETE FROM welcome_configs WHERE guild_id = $1`, guild)
		_, _ = pool.Exec(ctx, `DELETE FROM role_assignments WHERE guild_id = $1`, guild)
	}
	cleanup()
	defer cleanup()

	// --- panels + options: id is text, exclusive_group lives on the option ---
	panels := []rolePanel{{
		ID: "colors", ChannelID: "555000000000000007", MessageID: "666000000000000001",
		Title: "Colors", Description: "pick", Kind: "button", Mode: "exclusive", Enabled: true,
		Options: []rolePanelOption{
			{RoleID: "100000000000000010", Label: "Red", Emoji: "🔴", Style: "danger", Position: 0, ExclusiveGroup: "warm"},
			{RoleID: "100000000000000011", Label: "Blue", Emoji: "🔵", Style: "primary", Position: 1, ExclusiveGroup: "cool"},
		},
	}}
	if err := store.replacePanels(ctx, guild, panels); err != nil {
		t.Fatalf("replacePanels: %v", err)
	}
	gotPanels, err := store.listPanels(ctx, guild)
	if err != nil {
		t.Fatalf("listPanels: %v", err)
	}
	if len(gotPanels) != 1 || gotPanels[0].ID != "colors" || len(gotPanels[0].Options) != 2 {
		t.Fatalf("panel round-trip mismatch: %+v", gotPanels)
	}
	if gotPanels[0].Options[0].ExclusiveGroup != "warm" || gotPanels[0].Options[1].ExclusiveGroup != "cool" {
		t.Fatalf("exclusive_group not persisted: %+v", gotPanels[0].Options)
	}

	// --- welcome: the embed columns are join_embed / leave_embed ---
	if err := store.saveWelcome(ctx, guild, welcomeConfig{
		JoinEnabled: true, JoinChannelID: "555000000000000005", JoinMessage: "hi {user}",
		JoinEmbed: json.RawMessage(`{"title":"Welcome"}`), JoinDM: true, JoinDMMessage: "yo",
		LeaveEnabled: true, LeaveChannelID: "555000000000000006", LeaveMessage: "bye",
		LeaveEmbed: json.RawMessage(`{"title":"Goodbye"}`),
	}); err != nil {
		t.Fatalf("saveWelcome: %v", err)
	}
	w, err := store.welcome(ctx, guild)
	if err != nil {
		t.Fatalf("welcome: %v", err)
	}
	if w == nil || w.JoinMessage != "hi {user}" || len(w.JoinEmbed) == 0 || len(w.LeaveEmbed) == 0 {
		t.Fatalf("welcome round-trip mismatch: %+v", w)
	}

	// --- autoroles ---
	if err := store.replaceAutoroles(ctx, guild, []autoroleRule{
		{RoleID: "420000000000000042", Kind: "on_join", DelaySeconds: 0, AppliesTo: "human", Enabled: true, Priority: 5},
	}); err != nil {
		t.Fatalf("replaceAutoroles: %v", err)
	}
	rules, err := store.listAutoroles(ctx, guild)
	if err != nil || len(rules) != 1 || rules[0].RoleID != "420000000000000042" || rules[0].Priority != 5 {
		t.Fatalf("autorole round-trip mismatch: %v %+v", err, rules)
	}

	// --- role_assignments: a failed grant is persisted with its reason ---
	a, err := store.recordAssignment(ctx, guild, roleAssignmentInput{
		UserID: "100000000000000001", RoleID: "200000000000000002", Action: "add",
		Source: "autorole", Status: "failed", Error: "role above the bot highest role",
	})
	if err != nil {
		t.Fatalf("recordAssignment: %v", err)
	}
	if a.ID == 0 || a.Status != "failed" || a.Error == "" {
		t.Fatalf("assignment round-trip mismatch: %+v", a)
	}
	list, err := store.listAssignments(ctx, guild, 10)
	if err != nil || len(list) != 1 {
		t.Fatalf("listAssignments: %v %+v", err, list)
	}
}

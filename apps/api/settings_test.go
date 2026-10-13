package main

import (
	"context"
	"strings"
	"testing"
)

// fakeSettings is an in-memory settingsStore: load returns cfg, save records
// every write so a test can assert what was persisted.
type fakeSettings struct {
	cfg   discordConfig
	saved []discordConfig
}

func (f *fakeSettings) load(ctx context.Context) (discordConfig, error) { return f.cfg, nil }
func (f *fakeSettings) save(ctx context.Context, cfg discordConfig) error {
	f.cfg = cfg
	f.saved = append(f.saved, cfg)
	return nil
}

// TestEffectiveOverlaysDBOverEnv pins the resolution rule: a stored key wins
// over the env default, an absent stored key keeps the env default, and a nil
// store is env-only (fail-safe before the panel is ever used).
func TestEffectiveOverlaysDBOverEnv(t *testing.T) {
	dc, _ := fakeDiscord(t) // env: GuildID=100, RoleTeam=800, RoleAdmin=900, RoleMagang=700
	dc.settings = &fakeSettings{cfg: discordConfig{GuildID: "555", RoleTeam: "777"}}
	eff := dc.effective(context.Background())
	if eff.GuildID != "555" || eff.RoleTeam != "777" {
		t.Fatalf("a stored key must win over env: %+v", eff)
	}
	if eff.RoleAdmin != "900" || eff.RoleMagang != "700" {
		t.Fatalf("an absent stored key must keep the env default: %+v", eff)
	}
	dc.settings = nil
	if got := dc.effective(context.Background()); got.GuildID != "100" || got.RoleTeam != "800" {
		t.Fatalf("nil store must be env-only: %+v", got)
	}
}

func TestAdminSettingsRequiresAdmin(t *testing.T) {
	rec := do(t, newTestServer(t), "GET", "/api/admin/settings", "", "")
	if rec.Code != 401 {
		t.Fatalf("no session = %d, want 401", rec.Code)
	}
}

// TestAdminSettingsRoundTrip covers GET (effective config), a valid POST (saved),
// and an invalid id (refused before any write).
func TestAdminSettingsRoundTrip(t *testing.T) {
	srv := newTestServer(t)
	fake := &fakeSettings{}
	srv.discord.settings = fake

	rec := do(t, srv, "GET", "/api/admin/settings", adminCookie(t), "")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"guildId":"100"`) {
		t.Fatalf("GET = %d %s", rec.Code, rec.Body.String())
	}

	rec = do(t, srv, "POST", "/api/admin/settings", adminCookie(t), `{"guildId":"123456789012345678"}`)
	if rec.Code != 200 || len(fake.saved) != 1 || fake.saved[0].GuildID != "123456789012345678" {
		t.Fatalf("POST = %d saved=%+v", rec.Code, fake.saved)
	}
	// The untouched keys keep their effective value (env), not blank.
	if fake.saved[0].RoleAdmin != "900" {
		t.Fatalf("a partial body must keep the untouched keys: %+v", fake.saved[0])
	}

	rec = do(t, srv, "POST", "/api/admin/settings", adminCookie(t), `{"roleTeam":"not-an-id"}`)
	if rec.Code != 400 || len(fake.saved) != 1 {
		t.Fatalf("invalid id = %d saved=%d, want 400 and no write", rec.Code, len(fake.saved))
	}
}

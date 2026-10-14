package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// TestInternalDiscordConfigServesEffectiveConfig pins the contract the bot
// depends on: a loopback GET returns the SAME resolution the admin panel edits
// — the stored key wins, an absent stored key keeps the env default.
func TestInternalDiscordConfigServesEffectiveConfig(t *testing.T) {
	srv := newTestServer(t)
	srv.discord.settings = &fakeSettings{cfg: discordConfig{GuildID: "555", RoleAdmin: "999"}}
	req := httptest.NewRequest("GET", "/api/internal/discord-config", nil)
	req.RemoteAddr = "127.0.0.1:54321"
	rec := httptest.NewRecorder()
	srv.handler().ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{`"guildId":"555"`, `"roleAdmin":"999"`, `"roleTeam":"800"`, `"roleMagang":"700"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("body %s must carry %s (DB over env)", body, want)
		}
	}
}

// TestInternalDiscordConfigRefusesNonLoopback proves the endpoint is not a
// config leak for anything that is not the co-located bot.
func TestInternalDiscordConfigRefusesNonLoopback(t *testing.T) {
	srv := newTestServer(t)
	req := httptest.NewRequest("GET", "/api/internal/discord-config", nil)
	req.RemoteAddr = "203.0.113.7:1234"
	rec := httptest.NewRecorder()
	srv.handler().ServeHTTP(rec, req)
	if rec.Code != 404 {
		t.Fatalf("non-loopback = %d, want 404 (route invisible)", rec.Code)
	}
}

func TestInternalDiscordConfigRejectsNonGet(t *testing.T) {
	srv := newTestServer(t)
	req := httptest.NewRequest("POST", "/api/internal/discord-config", nil)
	req.RemoteAddr = "127.0.0.1:1"
	rec := httptest.NewRecorder()
	srv.handler().ServeHTTP(rec, req)
	if rec.Code != 405 {
		t.Fatalf("POST = %d, want 405", rec.Code)
	}
}

func TestIsLoopbackPeer(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1:1234": true,
		"[::1]:1234":     true,
		"127.0.0.1":      true,
		"::1":            true,
		"203.0.113.7:1":  false,
		"garbage":        false,
		"":               false,
	}
	for addr, want := range cases {
		if got := isLoopbackPeer(addr); got != want {
			t.Errorf("isLoopbackPeer(%q) = %v, want %v", addr, got, want)
		}
	}
}

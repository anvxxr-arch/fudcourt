package config

import "testing"

func TestFromEnvRequiresToken(t *testing.T) {
	if _, err := FromEnv(func(string) string { return "" }); err == nil {
		t.Fatal("expected an error when the bot token is empty")
	}
}

func TestFromEnvDefaults(t *testing.T) {
	cfg, err := FromEnv(func(key string) string {
		if key == EnvBotToken {
			return "  123:abc  "
		}
		return ""
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.BotToken != "123:abc" {
		t.Errorf("token not trimmed: %q", cfg.BotToken)
	}
	if cfg.DataURL != DefaultDataURL {
		t.Errorf("DataURL = %q, want %q", cfg.DataURL, DefaultDataURL)
	}
	if len(cfg.AdminIDs) != 0 || len(cfg.Wallets) != 0 {
		t.Errorf("expected no admins/wallets, got %d/%d", len(cfg.AdminIDs), len(cfg.Wallets))
	}
}

func TestFromEnvParsesAdminsAndWallets(t *testing.T) {
	env := map[string]string{
		EnvBotToken: "1:x",
		EnvAdminIDs: "722947356, 42;notanumber 7",
		EnvWallets:  "main:0xAAA, trading:0xBBB ,broken,empty:",
		EnvDataURL:  "http://127.0.0.1:3101/",
		EnvEVMRPC:   "https://rpc.example",
	}
	cfg, err := FromEnv(func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !cfg.IsAdmin(722947356) || !cfg.IsAdmin(42) || !cfg.IsAdmin(7) {
		t.Errorf("admin set wrong: %v", cfg.AdminIDs)
	}
	if cfg.IsAdmin(999) {
		t.Error("999 should not be an admin")
	}
	if cfg.DataURL != "http://127.0.0.1:3101" {
		t.Errorf("trailing slash not trimmed: %q", cfg.DataURL)
	}
	if len(cfg.Wallets) != 2 {
		t.Fatalf("wallets = %v, want 2 valid entries", cfg.Wallets)
	}
	if cfg.Wallets[0].Label != "main" || cfg.Wallets[0].Address != "0xAAA" {
		t.Errorf("wallet[0] = %+v", cfg.Wallets[0])
	}
	if cfg.Wallets[1].Label != "trading" || cfg.Wallets[1].Address != "0xBBB" {
		t.Errorf("wallet[1] = %+v", cfg.Wallets[1])
	}
}

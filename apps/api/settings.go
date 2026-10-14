package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/cache"
)

// The Discord wiring an admin tunes from the panel lives in the `settings`
// table (db/schema/pg-schema.sql), NOT in the environment: the site reads the
// live config from the database so a change takes effect without an edit or a
// restart. The same-named env vars are only the boot default — the resolver in
// discordClient.effective overlays the stored values on top of them.
const (
	keyGuildID    = "discord.guild_id"
	keyRoleAdmin  = "discord.role_admin"
	keyRoleTeam   = "discord.role_team"
	keyRoleMagang = "discord.role_magang"
)

// discordConfig is the admin-editable Discord wiring: which guild the site
// tiers against, and which guild role maps to each site tier. An empty field
// means "unset" — the resolver then keeps the environment default.
type discordConfig struct {
	GuildID    string `json:"guildId"`
	RoleAdmin  string `json:"roleAdmin"`
	RoleTeam   string `json:"roleTeam"`
	RoleMagang string `json:"roleMagang"`
}

// settingsStore reads and writes the admin-editable Discord config. The
// interface keeps the handlers testable without a database.
type settingsStore interface {
	load(ctx context.Context) (discordConfig, error)
	save(ctx context.Context, cfg discordConfig) error
}

// configTTL bounds how long a config read is served from memory. An admin save
// refreshes the cache immediately (Set), so the panel's own change is visible
// on the very next request; a foreign DB edit lands within one TTL.
const configTTL = 30 * time.Second

// pgSettingsStore is the Postgres-backed settingsStore. Reads are cached for
// configTTL with a stale-on-error fallback: if the database blinks, the last
// good config keeps serving instead of the site silently reverting to env.
type pgSettingsStore struct {
	pool  *pgxpool.Pool
	cache *cache.Cache[discordConfig]
}

func newPGSettingsStore(pool *pgxpool.Pool) *pgSettingsStore {
	return &pgSettingsStore{pool: pool, cache: cache.New[discordConfig](configTTL)}
}

func (s *pgSettingsStore) load(ctx context.Context) (discordConfig, error) {
	if v, stale, ok := s.cache.Get(keyGuildID); ok && !stale {
		return v, nil
	}
	cfg, err := s.fetch(ctx)
	if err != nil {
		if v, _, ok := s.cache.Get(keyGuildID); ok {
			return v, nil // serve the last good config through a DB blip
		}
		return discordConfig{}, err
	}
	s.cache.Set(keyGuildID, cfg)
	return cfg, nil
}

func (s *pgSettingsStore) fetch(ctx context.Context) (discordConfig, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT key, value FROM settings WHERE key = ANY($1)`,
		[]string{keyGuildID, keyRoleAdmin, keyRoleTeam, keyRoleMagang})
	if err != nil {
		return discordConfig{}, err
	}
	defer rows.Close()
	var cfg discordConfig
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return discordConfig{}, err
		}
		switch k {
		case keyGuildID:
			cfg.GuildID = v
		case keyRoleAdmin:
			cfg.RoleAdmin = v
		case keyRoleTeam:
			cfg.RoleTeam = v
		case keyRoleMagang:
			cfg.RoleMagang = v
		}
	}
	if err := rows.Err(); err != nil {
		return discordConfig{}, err
	}
	return cfg, nil
}

func (s *pgSettingsStore) save(ctx context.Context, cfg discordConfig) error {
	const stmt = `
		INSERT INTO settings (key, value) VALUES ($1,$2),($3,$4),($5,$6),($7,$8)
		ON CONFLICT (key) DO UPDATE
		  SET value = EXCLUDED.value,
		      updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`
	if _, err := s.pool.Exec(ctx, stmt,
		keyGuildID, cfg.GuildID,
		keyRoleAdmin, cfg.RoleAdmin,
		keyRoleTeam, cfg.RoleTeam,
		keyRoleMagang, cfg.RoleMagang,
	); err != nil {
		return fmt.Errorf("save settings: %w", err)
	}
	s.cache.Set(keyGuildID, cfg)
	return nil
}

// attachStores wires the Postgres-backed stores the api owns into the server:
// the Discord config store (discordClient.settings) and the moderation-case
// store (s.cases), both on ONE pool. The pool connects lazily (pgxpool dials
// on first use), so a down database never blocks startup — config reads then
// degrade to the env defaults (discordClient.effective) and case writes answer
// 503 (cases_unavailable). An unset or unparseable URL logs and leaves both
// stores nil.
func (s *server) attachStores() {
	dsn := os.Getenv("FUDCOURT_PG_URL")
	if dsn == "" {
		slog.Info("stores disabled", "service", "api", "reason", "FUDCOURT_PG_URL unset")
		return
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		slog.Error("stores disabled", "service", "api", "reason", "FUDCOURT_PG_URL unparseable")
		return
	}
	cfg.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		slog.Error("stores disabled", "service", "api", "error", err)
		return
	}
	s.discord.settings = newPGSettingsStore(pool)
	s.cases = newPGCasesStore(pool)
	s.automod = newPGAutomodStore(pool)
	s.logging = newPGLoggingStore(pool)
}

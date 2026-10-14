// Command api is the FUDCourt primary Go backend layer (docs/architecture/
// target.md): one process hosting the bounded contexts under internal/ —
// access/{identity,authorization,entitlements,credentials},
// accounts/{exchange,wallets}, finance/{ledger,portfolio,treasury,transactions},
// markets/{instruments,overview}, plus notifications, audit, jobs and
// platform/{errs,health,httpx}, and the /api/admin/members plane
// (admin/members/route.ts port). There is no api-side executor package yet: the
// executor here is orchestration (commands/queries over apps/executor),
// which no Go code in this module implements today, so no internal/
// executor directory exists — a placeholder would be a lie.
// The admin context is a route plane here, not an internal package:
// it reuses identity.TierAdmin ("admin") and the existing handlers in
// cmd/api/{routes,errors}.go. Splitting it into internal/admin is deferred
// (docs/architecture/final-review.md §6, debt item 5) — the comment must not
// claim a package that does not exist.
//
// Deliberately NOT one process per domain (objective §51): domains are modules;
// extraction needs an operational reason.
//
// Startup is fail-visible: configuration problems exit non-zero before the
// listener opens (objective §34).
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/access/identity"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/health"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/httpx"
)

// defaultAddr is loopback-only like every FUDCourt service (the only ingress is
// the Cloudflare tunnel to the web tier, DR-002).
const defaultAddr = "127.0.0.1:3103"

// readinessTimeout bounds the whole dependency probe pass of one /readyz call.
const readinessTimeout = 2 * time.Second

type server struct {
	health  *health.Registry
	discord *discordClient
	// cases is the moderation-case store (moderation_cases.go). nil means the
	// case log is disabled (no FUDCOURT_PG_URL): moderation still works in
	// Discord, the record simply is not persisted and the case routes answer 503.
	cases casesStore
	// automod is the AutoMod rule store (automod_rules.go). nil means the rule
	// set is unavailable (no FUDCOURT_PG_URL): the bot's loader then reads no
	// rules and AutoMod simply does nothing, rather than crashing.
	automod automodStore
	// logging is the activity-log routing + audit store (logging.go). nil means
	// the log config is unavailable (no FUDCOURT_PG_URL): the bot's router then
	// reads no destinations and mirrors nothing, and audit writes are dropped —
	// never a crash.
	logging loggingStore
	// community is the welcome/autorole/role-panel store (community.go). nil
	// means those features read no config and simply do nothing.
	community communityStore
	// customCommands is the declarative custom-command store (customcommands.go).
	// nil means the bot reads no custom commands and simply answers none.
	customCommands customCommandStore
	// feeds is the feed-source panel store (feeds.go). nil means the panel
	// answers 503: feeds are the worker's, and without a database there is
	// nothing to show or edit.
	feeds feedStore
	// schedules is the scheduler panel store (scheduler.go). nil means the panel
	// answers 503. It is read-only for now; write ownership is derived from
	// `job_kind` (see scheduler.go).
	schedules scheduleStore
	// secret is the HMAC session key (FUDCOURT_SESSION_SECRET). It is read
	// through identity.SessionSecret's fail-closed floor: without a usable
	// secret no session ever verifies and none can be minted — exactly the
	// degradation session.ts implements — while the service itself stays up.
	secret string
}

func newServer(reg *health.Registry) *server {
	secret, _ := identity.SessionSecret(os.Getenv("FUDCOURT_SESSION_SECRET"))
	dc := newDiscordClient(discordEnv{
		ClientID:     os.Getenv("FUDCOURT_CLIENT_ID"),
		ClientSecret: os.Getenv("FUDCOURT_CLIENT_SECRET"),
		RedirectURI:  os.Getenv("DISCORD_REDIRECT_URI"),
		GuildID:      os.Getenv("FUDCOURT_GUILD_ID"),
		BotToken:     os.Getenv("FUDCOURT_BOT_TOKEN"),
		RoleTeam:     os.Getenv("FUDCOURT_ROLE_TEAM"),
		RoleAdmin:    os.Getenv("FUDCOURT_ROLE_ADMIN"),
		RoleMagang:   os.Getenv("FUDCOURT_ROLE_MAGANG"),
		Prefix:       os.Getenv("FUDCOURT_PREFIX"),
	})
	// FUDCOURT_DISCORD_API optionally points the Discord REST client at another
	// base (hermetic tests and smoke runs); unset keeps the real endpoints.
	// Additive config seam — the TS oracles hardcode discord.com.
	if base := os.Getenv("FUDCOURT_DISCORD_API"); base != "" {
		dc.apiBase = strings.TrimRight(base, "/") + "/api/v10"
		dc.tokenURL = strings.TrimRight(base, "/") + "/api/oauth2/token"
	}
	return &server{health: reg, discord: dc, secret: secret}
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	// Liveness: process-local, dependency-free by contract (package health).
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteJSON(w, 200, map[string]any{"ok": true, "service": "api"})
	})
	// Readiness: every registered dependency usable, else 503 with the list.
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		results, ready := s.health.Run(r.Context(), readinessTimeout)
		code := 200
		if !ready {
			code = 503
		}
		httpx.WriteJSON(w, code, map[string]any{"ok": ready, "checks": results})
	})
	// Tranche-1 identity surface (migration-plan §20): the exact methods the TS
	// route files exported. The patterns carry no method on purpose — an
	// unexported method must reach the handler's methodGuard and answer 405
	// with an Allow header, exactly as Next does, instead of falling through
	// to the 404 envelope of an unregistered route.
	mux.HandleFunc("/api/auth/login", s.handleAuthLogin)
	mux.HandleFunc("/api/auth/callback", s.handleAuthCallback)
	mux.HandleFunc("/api/auth/logout", s.handleAuthLogout)
	mux.HandleFunc("/api/admin/members", s.handleAdminMembers)
	mux.HandleFunc("/api/admin/settings", s.handleAdminSettings)
	mux.HandleFunc("/api/admin/moderation/cases", s.handleAdminModerationCases)
	// Internal, loopback-only: the co-located Discord bot reads the effective
	// Discord wiring here (it has no Postgres driver of its own), so an admin
	// panel change reaches the bot without an .env edit or a restart.
	mux.HandleFunc("/api/internal/discord-config", s.handleInternalDiscordConfig)
	// Internal, loopback-only: the bot records every moderation action here and
	// reads case history back — the same hop, for the same reason.
	mux.HandleFunc("/api/internal/moderation/cases", s.handleInternalModerationCases)
	// Internal, loopback-only: the bot loads its AutoMod rule set here (it has
	// no Postgres driver), so an operator rule change reaches the bot without a
	// restart — the same hop, for the same reason.
	mux.HandleFunc("/api/internal/automod/rules", s.handleInternalAutomodRules)
	// Internal, loopback-only: the bot reads its activity-log routing map here
	// and records bot-originated audit entries — the same hop, for the same
	// reason (no Postgres driver in the bot).
	mux.HandleFunc("/api/internal/log-config", s.handleInternalLogConfig)
	mux.HandleFunc("/api/internal/audit", s.handleInternalAudit)
	// Dashboard: log-routing editor + audit viewer, both behind the admin tier.
	mux.HandleFunc("/api/admin/logs/destinations", s.handleAdminLogDestinations)
	mux.HandleFunc("/api/admin/logs/audit", s.handleAdminAuditLogs)
	// Internal, loopback-only: the bot reads welcome/autorole/panel config here
	// and records every role grant/revoke it attempts (incl. failures) — the
	// same hop, for the same reason.
	mux.HandleFunc("/api/internal/community/config", s.handleInternalCommunityConfig)
	mux.HandleFunc("/api/internal/role-assignments", s.handleInternalRoleAssignments)
	// Dashboard: welcome/goodbye, autoroles and role panels, behind the admin tier.
	mux.HandleFunc("/api/admin/welcome", s.handleAdminWelcome)
	mux.HandleFunc("/api/admin/autoroles", s.handleAdminAutoroles)
	mux.HandleFunc("/api/admin/role-panels", s.handleAdminRolePanels)
	mux.HandleFunc("/api/admin/role-assignments", s.handleAdminRoleAssignments)
	// Internal, loopback-only: the bot reads its declarative custom-command set
	// here (it has no Postgres driver) — the same hop, for the same reason.
	mux.HandleFunc("/api/internal/custom-commands", s.handleInternalCustomCommands)
	// Dashboard: the custom-command editor, behind the admin tier.
	mux.HandleFunc("/api/admin/custom-commands", s.handleAdminCustomCommands)
	mux.HandleFunc("/api/admin/feeds", s.handleAdminFeeds)
	mux.HandleFunc("/api/admin/scheduler", s.handleAdminScheduler)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteError(w, r, errNotFound)
	})
	// Outer to inner: Recover contains a panic from any layer below and
	// answers on the real writer (past Gzip's buffer); RequestID correlates
	// every response including that failure; Harden and CacheControl stamp
	// the shared header map before a body exists; Gzip buffers innermost,
	// where the final status, Content-Type and size are known.
	return httpx.Recover(httpx.RequestID(httpx.Harden(httpx.CacheControl(httpx.Gzip(mux)))))
}

// prewarmMembers fetches the guild-member list once at startup so the first
// /api/admin/members request after boot is a hot read instead of the
// 120-400ms Discord round trip. main() runs it detached: it owns its own 2s
// cap (listGuildMembers' cold path) and must never delay or gate the
// listener — an unconfigured or unreachable Discord logs one line and leaves
// the cold-miss inline path as the fallback; failures are never cached.
//
// Deliberately NOT registered with the health.Registry behind /readyz:
// Discord is an optional provider for one admin panel, not a dependency this
// process needs to serve its own traffic (objective §34 readiness lists
// required dependencies only) — a provider outage must not flip readiness
// and get the service restarted. The cold-miss fetch + 503 refusal is the
// degradation instead.
func (s *server) prewarmMembers() {
	if s.discord.env.GuildID == "" || s.discord.env.BotToken == "" {
		slog.Info("members prewarm skipped-or-failed", "service", "api", "reason", "discord not configured")
		return
	}
	members, ok := s.discord.listGuildMembers(context.Background(), membersListLimit)
	if !ok {
		slog.Info("members prewarm skipped-or-failed", "service", "api", "reason", "upstream unavailable; cold-miss fallback remains")
		return
	}
	slog.Info("members prewarm ok", "service", "api", "members", len(members))
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{})))

	addr := os.Getenv("FUDCOURT_API_ADDR")
	if addr == "" {
		addr = defaultAddr
	}

	reg := health.NewRegistry()
	api := newServer(reg)
	api.attachStores()
	srv := &http.Server{
		Addr:              addr,
		Handler:           api.handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// The api handler set is small (auth + admin, request/response JSON), so
		// the whole request must land well inside a request budget; a slow-body
		// client is a connection held open, which ReadHeaderTimeout alone does
		// not bound.
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		// Keep-alive reuse from the web layer is the point; the idle ceiling is
		// what stops an abandoned keep-alive connection from lingering.
		IdleTimeout: 120 * time.Second,
		// The web layer forwards a small header set; 64 KiB is far above anything
		// a legitimate caller sends and well under the 1 MiB stdlib default, so
		// an oversized-header request is refused at the listener.
		MaxHeaderBytes: 1 << 16,
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		slog.Info("api listening", "service", "api", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("listen failed", "service", "api", "addr", addr, "error", err)
			os.Exit(1)
		}
	}()
	// Pre-warm fires after the listener goroutine starts and never blocks it:
	// one detached fetch, one log line, cold-miss fallback on any failure.
	go api.prewarmMembers()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	sig := <-stop
	slog.Info("shutting down", "service", "api", "signal", sig.String())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("graceful shutdown failed", "service", "api", "error", err)
		os.Exit(1)
	}
	<-done
}

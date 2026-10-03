// Command api is the FUDCourt primary Go backend layer (docs/architecture/
// target.md): one process hosting the bounded contexts under internal/ —
// access/{identity,authorization,entitlements,credentials},
// accounts/{exchange,wallets}, finance/{ledger,portfolio,treasury,transactions},
// markets/{instruments,overview}, plus notifications, audit, jobs and
// platform/{errs,health,httpx}, and the /api/admin/members plane
// (admin/members/route.ts port). There is no api-side executor package yet: the
// executor here is orchestration (commands/queries over backend/workers/
// executor), which no Go code in this module implements today, so no internal/
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

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/access/identity"
	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/health"
	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/httpx"
)

// defaultAddr is loopback-only like every FUDCourt service (the only ingress is
// the Cloudflare tunnel to the web tier, DR-002).
const defaultAddr = "127.0.0.1:3103"

// readinessTimeout bounds the whole dependency probe pass of one /readyz call.
const readinessTimeout = 2 * time.Second

type server struct {
	health  *health.Registry
	discord *discordClient
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
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteError(w, r, errNotFound)
	})
	return httpx.Recover(httpx.RequestID(mux))
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{})))

	addr := os.Getenv("FUDCOURT_API_ADDR")
	if addr == "" {
		addr = defaultAddr
	}

	reg := health.NewRegistry()
	srv := &http.Server{
		Addr:              addr,
		Handler:           newServer(reg).handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// The api handler set is small (auth + admin, request/response JSON), so
		// the whole request must land well inside a request budget; a slow-body
		// client is a connection held open, which ReadHeaderTimeout alone does
		// not bound.
		ReadTimeout: 15 * time.Second,
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

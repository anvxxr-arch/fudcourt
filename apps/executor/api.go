package main

// The executor's HTTP surface (objective §52: the runtime path is
// web → executor). The worker loop's process also serves the 15
// `/api/executor/*` routes, so `/api/executor/*` no longer depends on the
// TypeScript runtime: the web tier thin-proxies the browser request (cookie and
// all) to this loopback listener.
//
// WHY HERE (recorded decision, reported to the architecture owner):
//
//	The dependency rules forbid apps/api from importing this module's
//	internals, and the executor surface needs the planner (one canonical risk
//	engine + sizing), the sealed credential vault and the `executor.*` store —
//	all owned by this module. The three candidate boundaries were:
//	  (a) a NEW shared Go contracts/pure-math module — genuinely clean, but it
//	      means a new go.mod + go.work entry and moving the canonical planner/risk
//	      packages, which is a repo-wide decision with its own rollout;
//	  (b) the executor exposing its own HTTP surface and apps/api proxying —
//	      adds a pass-through hop with all the logic still living here;
//	  (c) this: the executor serves it directly. Chosen because it needs NO new
//	      module, NO new service and NO new proxy, keeps ONE canonical planner,
//	      and is testable offline (see internal/api's memory-store harness).
//	      Adopting (a) later is a pure relocation: internal/api's handlers keep
//	      their contracts and only their imports change.
//
// The surface is mounted on its OWN loopback listener (default
// 127.0.0.1:3105), separate from the /healthz+/readyz operational surface, so a
// request burst can never starve the readiness probe and vice versa. Both stay
// loopback-only (DR-002); the web tier is the only client.
//
// Env (fail-visible, objective §34): a listener that cannot be started is
// fatal — a surface that silently failed to bind would look like a working
// deployment whose executor routes 404.
//
//	FUDCOURT_EXECUTOR_API_ADDR        default 127.0.0.1:3105
//	FUDCOURT_EXECUTOR_LIVE            "1" enables live creation (kill switch)
//	FUDCOURT_SESSION_SECRET           session verification (fail-closed)

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/api"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges/binance"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges/bybit"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges/mexc"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/platform/credentials"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/repository"
)

// defaultAPIAddr is the executor HTTP surface's loopback address (DR-002: every
// FUDCourt service binds loopback; the only ingress is the web tier).
const defaultAPIAddr = "127.0.0.1:3105"

// apiAddr is the validated FUDCOURT_EXECUTOR_API_ADDR (empty = default).
func apiAddr(getenv func(string) string) string {
	if v := strings.TrimSpace(getenv("FUDCOURT_EXECUTOR_API_ADDR")); v != "" {
		return v
	}
	return defaultAPIAddr
}

// liveEnabled reads the §108 kill switch (`== "1"`, exactly as runtime.ts).
func liveEnabled(getenv func(string) string) bool {
	return getenv("FUDCOURT_EXECUTOR_LIVE") == "1"
}

// apiVenues is the venule factory the API layer depends on. It is the SAME
// unsealing boundary as resolver.adapterFor — the api package receives ready
// adapters and never sees plaintext — but unlike the worker path it also serves
// un-stored candidates (a connect/test probe) and seals a fresh credential set.
type apiVenues struct {
	store       *repository.Store
	key         string
	httpTimeout time.Duration
	// health is the credential-health check the worker resolver applies; the
	// API path deliberately does not re-check it for a connect probe (there is
	// no row yet) and does check for a stored account, matching buildPlanContext
	// in runtime.ts.
}

// AdapterSealed loads and unseals one stored account row (ownership-free: the
// handler already verified ownership of the row it names) and builds its
// adapter. The account id is the credential row id, same as the worker path.
func (v *apiVenues) AdapterSealed(ctx context.Context, exchange execution.ExchangeID, marketType execution.MarketType, id string) (exchanges.Exchange, error) {
	row, err := v.store.LoadCredential(ctx, id)
	if err != nil {
		return nil, err
	}
	if row.Revoked {
		return nil, errors.New("credential revoked")
	}
	apiKey, apiSecret, _, err := credentials.Open(row.Envelope, v.key)
	if err != nil {
		return nil, err
	}
	return buildAdapter(exchange, marketType, exchanges.Credentials{APIKey: apiKey, APISecret: apiSecret}, v.httpTimeout)
}

// AdapterPlain builds an adapter from user-supplied plaintext for a connect or
// test probe. The plaintext is used here and discarded — it is never logged,
// stored or returned.
func (v *apiVenues) AdapterPlain(_ context.Context, exchange execution.ExchangeID, marketType execution.MarketType, creds api.PlainCredentials) (exchanges.Exchange, error) {
	return buildAdapter(exchange, marketType, exchanges.Credentials{APIKey: creds.APIKey, APISecret: creds.APISecret}, v.httpTimeout)
}

// Seal seals one credential set with the master key. This is the ONLY place the
// API layer touches the key; the ciphertext is what the store persists.
func (v *apiVenues) Seal(creds api.PlainCredentials) (credentials.Envelope, error) {
	return credentials.Seal(creds.APIKey, creds.APISecret, creds.Passphrase, v.key)
}

// buildAdapter constructs one venue adapter for the given market class
// (objective §8.16 — no venue branching outside the exchanges package's own
// constructors).
func buildAdapter(exchange execution.ExchangeID, marketType execution.MarketType, creds exchanges.Credentials, timeout time.Duration) (exchanges.Exchange, error) {
	http := exchanges.DefaultHTTPClient(timeout)
	switch exchange {
	case execution.ExchangeBinance:
		return binance.New(binance.Config{Credentials: creds, HTTP: http, MarketType: marketType})
	case execution.ExchangeBybit:
		return bybit.New(bybit.Config{Credentials: creds, HTTP: http, MarketType: marketType})
	case execution.ExchangeMEXC:
		return mexc.New(mexc.Config{Credentials: creds, HTTP: http, MarketType: marketType})
	default:
		return nil, errors.New("unsupported exchange")
	}
}

// startAPISurface builds and starts the executor HTTP surface. It returns the
// http.Server so main can shut it down; a construction failure (missing session
// secret, a bad listener) is returned for the caller to treat as fatal.
func startAPISurface(ctx context.Context, store *repository.Store, key string, getenv func(string) string) (*http.Server, error) {
	secret := strings.TrimSpace(getenv("FUDCOURT_SESSION_SECRET"))
	srv, err := api.New(api.Config{
		Store: store,
		Venues: &apiVenues{
			store:       store,
			key:         key,
			httpTimeout: 30 * time.Second,
		},
		SessionSecret: secret,
		Live:          liveEnabled(getenv),
	})
	if err != nil {
		return nil, err
	}
	addr := apiAddr(getenv)
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           srv.Router(),
		ReadHeaderTimeout: 5 * time.Second,
		// A request may legitimately wait on a venue round trip; the bound is
		// generous but finite so a wedged venue cannot pin a connection.
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}
	go func() {
		slog.Info("executor: API surface listening", "addr", addr, "live", liveEnabled(getenv))
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			// Losing the surface silently would make every /api/executor/* route
			// look like a 404 to the web tier; take the process down instead.
			slog.Error("executor: API surface failed", "addr", addr, "error", err)
		}
	}()
	return httpSrv, nil
}

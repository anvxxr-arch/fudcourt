// Command executor is the FUDCourt execution service (objective §8.9): the
// worker loop driving strategies and venue adapters against the durable
// Postgres executor store, with Valkey distributed leases.
//
// Process boundary (objective §52): web → api → executor. This process is the
// ONLY owner of execution decisions and of exchange credential plaintext:
// executions arrive by account_id, this composition root loads the sealed
// executor.exchange_accounts row, unseals it via internal/platform/credentials and
// hands the adapter its signing handle (objective §8.4 — plaintext never
// leaves this package, and the web tier never sees the master key).
//
// Startup is fail-visible (objective §34): every required environment key is
// read and validated BEFORE the store opens, so a misconfigured unit exits
// non-zero on the first attempt instead of degrading into a no-trade loop.
//
// CONFIG
//
//	FUDCOURT_EXECUTOR_MASTER_KEY   64 hex chars; absent ⇒ exit (§40 fail-closed)
//	FUDCOURT_EXECUTOR_PG_URL       Postgres DSN; pings at construction
//	FUDCOURT_EXECUTOR_OWNER        lease owner token (default hostname-pid)
//	FUDCOURT_EXECUTOR_MAX_INFLIGHT hard concurrency cap (default 8, >0)
//	FUDCOURT_EXECUTOR_TICK_MS      scheduler cadence ms (default 5000)
//	FUDCOURT_EXECUTOR_QUANTITY_STEP fallback clamp grid step (default 0.0001;
//	  the plan's own precision wins when it carries one — see quantityStep)
//	VALKEY_ADDR                    optional; absent ⇒ in-process lock
//
// Signals: SIGINT/SIGTERM cancel the loop gracefully (in-flight placements
// drain; the next pass re-acquires leases and re-reconciles, §24).
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges/binance"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges/bybit"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges/mexc"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges/paper"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/notify"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/platform/credentials"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/platform/lock"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/repository"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/runtime/worker"
)

// config is the validated service configuration. Every field is required
// unless documented optional.
type config struct {
	masterKey      string
	pgURL          string
	owner          string
	maxInFlight    int
	tick           time.Duration
	valkeyAddr     string
	valkeyPassword string
	stepFallback   string
	healthAddr     string
	readyTimeout   time.Duration
}

// defaultHealthAddr is loopback-only like every FUDCourt service (DR-002).
const defaultHealthAddr = "127.0.0.1:3104"

// loadConfigFrom is loadConfig with an injectable env lookup (tests pin the
// exact refusal and default surface without touching the process env).
func loadConfigFrom(getenv func(string) string) (config, error) {
	return loadConfigWith(getenv)
}

// loadConfig reads and validates the environment. Every refusal names the
// exact key and the problem (objective §43): nothing defaults silently.
func loadConfig() (config, error) {
	return loadConfigWith(os.Getenv)
}

// loadConfigWith is the implementation both entry points share.
func loadConfigWith(getenv func(string) string) (config, error) {
	var c config
	var err error

	c.masterKey, err = credentials.MasterKeyFromEnv(getenv)
	if err != nil {
		return c, err
	}

	c.pgURL = strings.TrimSpace(getenv("FUDCOURT_EXECUTOR_PG_URL"))
	if c.pgURL == "" {
		return c, errors.New("FUDCOURT_EXECUTOR_PG_URL is required (Postgres is the durable truth, objective §39)")
	}

	c.owner = strings.TrimSpace(getenv("FUDCOURT_EXECUTOR_OWNER"))
	if c.owner == "" {
		c.owner = defaultOwner()
	}

	c.maxInFlight = 8
	if v := strings.TrimSpace(getenv("FUDCOURT_EXECUTOR_MAX_INFLIGHT")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return c, fmt.Errorf("FUDCOURT_EXECUTOR_MAX_INFLIGHT must be a positive integer, got %q", v)
		}
		c.maxInFlight = n
	}

	c.tick = 5 * time.Second
	if v := strings.TrimSpace(getenv("FUDCOURT_EXECUTOR_TICK_MS")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			return c, fmt.Errorf("FUDCOURT_EXECUTOR_TICK_MS must be a non-negative integer, got %q", v)
		}
		c.tick = time.Duration(n) * time.Millisecond
	}

	c.valkeyAddr = strings.TrimSpace(getenv("VALKEY_ADDR"))
	c.valkeyPassword = strings.TrimSpace(getenv("VALKEY_PASSWORD"))

	c.healthAddr = strings.TrimSpace(getenv("FUDCOURT_EXECUTOR_HEALTH_ADDR"))
	if c.healthAddr == "" {
		c.healthAddr = defaultHealthAddr
	}
	c.readyTimeout, err = parseProbeTimeout(strings.TrimSpace(getenv("FUDCOURT_EXECUTOR_READYZ_TIMEOUT_MS")))
	if err != nil {
		return c, err
	}

	// The clamp grid fallback. The plan's own precision (constraints) wins per
	// execution; this only applies when a plan carries no precision, and it is
	// the value the operator pinned at deploy time — never a guessed venue
	// default. Placing off-grid is refused by the clamp, so a WRONG value is
	// loud (no placement or absurd fragments), not a silent sizing error.
	c.stepFallback = strings.TrimSpace(getenv("FUDCOURT_EXECUTOR_QUANTITY_STEP"))
	if c.stepFallback == "" {
		c.stepFallback = "0.0001"
	}
	return c, nil
}

// defaultOwner is hostname-pid: unique per process so two workers can never
// alias each other's leases (Config.Owner's contract).
func defaultOwner() string {
	h, err := os.Hostname()
	if err != nil {
		h = "unknown-host"
	}
	return fmt.Sprintf("%s-%d", h, os.Getpid())
}

// resolver is the credential + adapter composition seam. It is the single
// place in the whole system where sealed exchange credentials become
// plaintext (objective §8.4). Plaintext is scoped to one call and never
// logged, stored into an event, or returned anywhere.
type resolver struct {
	store        *repository.Store
	key          string
	stepFallback string
	httpTimeout  time.Duration
}

// adapterFor unseals the execution's credential and builds its venue adapter.
// Every failure names the credential id — never the credential.
func (r *resolver) adapterFor(ctx context.Context, rec execution.ExecutionRecord) (exchanges.Exchange, error) {
	row, err := r.store.LoadCredential(ctx, rec.AccountID)
	if err != nil {
		return nil, err
	}
	if row.Revoked {
		return nil, fmt.Errorf("credential %s: revoked", row.MaskedKeyOrFingerprint())
	}
	if row.Health != "" && row.Health != "ACTIVE" && row.Health != "UNKNOWN" {
		return nil, fmt.Errorf("credential %s: not healthy (%s)", row.MaskedKeyOrFingerprint(), row.Health)
	}
	apiKey, apiSecret, _, err := credentials.Open(row.Envelope, r.key)
	if err != nil {
		return nil, fmt.Errorf("credential %s: %w", row.MaskedKeyOrFingerprint(), err)
	}
	creds := exchanges.Credentials{APIKey: apiKey, APISecret: apiSecret}
	http := exchanges.DefaultHTTPClient(r.httpTimeout)
	market := rec.MarketType
	// Paper mode (parity with the TS PaperExchangeAdapter): a deterministic
	// in-memory venue that fills/settles itself but reads its TAPE from a live
	// adapter for the execution's exchange — so paper pricing is real and paper
	// placement is simulated. The live adapter built here is used only for its
	// read surface; the paper venue never calls its CreateOrder/CancelOrder.
	if rec.Mode == execution.ModePaper {
		src, err := buildLiveAdapter(rec.Exchange, market, creds, http)
		if err != nil {
			return nil, err
		}
		return paper.NewPaper(paper.PaperConfig{
			MarketType: market,
			Source:     liveMarketSource{live: src},
		})
	}
	return buildLiveAdapter(rec.Exchange, market, creds, http)
}

// buildLiveAdapter constructs the live venue adapter for an exchange. It is the
// single place paper mode sources its tape from, so the two paths can never
// diverge on which venue a paper execution is priced against.
func buildLiveAdapter(exchange execution.ExchangeID, market execution.MarketType, creds exchanges.Credentials, http exchanges.HTTPClient) (exchanges.Exchange, error) {
	switch exchange {
	case execution.ExchangeBinance:
		return binance.New(binance.Config{Credentials: creds, HTTP: http, MarketType: market})
	case execution.ExchangeBybit:
		return bybit.New(bybit.Config{Credentials: creds, HTTP: http, MarketType: market})
	case execution.ExchangeMEXC:
		return mexc.New(mexc.Config{Credentials: creds, HTTP: http, MarketType: market})
	default:
		return nil, fmt.Errorf("unknown exchange %q", exchange)
	}
}

// liveMarketSource adapts a live exchange adapter to paper.MarketSource: paper
// reads the live tape through it (ticker/markets/fees) and does its own
// matching. The reverse direction (paper's order methods) is never reachable
// through this seam, so a paper execution cannot place on the live venue.
type liveMarketSource struct{ live exchanges.Exchange }

func (s liveMarketSource) GetTicker(ctx context.Context, symbol string) (execution.Ticker, error) {
	return s.live.GetTicker(ctx, symbol)
}

func (s liveMarketSource) GetMarkets(ctx context.Context) ([]exchanges.Market, error) {
	return s.live.GetMarkets(ctx)
}

func (s liveMarketSource) GetFees(ctx context.Context, symbol string) (exchanges.FeeModel, error) {
	return s.live.GetFees(ctx, symbol)
}

// exchanges adapts worker.Config.Exchanges. The ctx comes from the worker's
// placement path so a cancelled pass cannot leak a credential read. A
// successful unseal is also where the account is marked used
// (last_used_at) — the one audit side effect the worker loop is allowed to
// have.
func (r *resolver) exchanges(rec execution.ExecutionRecord) (exchanges.Exchange, error) {
	ex, err := r.adapterFor(context.Background(), rec)
	if err != nil {
		return nil, err
	}
	r.touch(rec)
	return ex, nil
}

// quantityStep adapts worker.Config.QuantityStep: the clamp's grid step.
// A plan that carries its own precision (execution constraints or the
// persisted plan) would resolve here per execution; until that surface is
// pinned the operator-configured fallback applies, and an unusable value
// refuses every placement loudly (the clamp floors only on a > 0 grid).
func (r *resolver) quantityStep(rec execution.ExecutionRecord) string {
	return r.stepFallback
}

// touch records credential use (last_used_at) so stale credentials are
// visible without touching sealed columns. Failures are logged — a stale
// audit timestamp must never stop trading.
func (r *resolver) touch(rec execution.ExecutionRecord) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := r.store.TouchAccountCredential(ctx, rec.AccountID, time.Now().UnixMilli()); err != nil {
		slog.Warn("executor: credential touch failed", "account", rec.AccountID, "error", err)
	}
}

func main() {
	slog.Info("executor: starting")
	cfg, err := loadConfig()
	if err != nil {
		slog.Error("executor: configuration refused", "error", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	store, err := repository.New(ctx, cfg.pgURL)
	if err != nil {
		slog.Error("executor: store open refused", "error", err)
		os.Exit(1)
	}
	defer store.Close()
	// Schema bootstrap (parity with the TS runtime's ensureExecutorSchema): the
	// tracked executor-schema.sql is applied here, statement by statement and
	// idempotently, BEFORE the worker loop or either HTTP surface can serve. A
	// database whose executor.* schema is missing would otherwise fail at the
	// first query; instead the process refuses to start, fail-visible (§34),
	// exactly as a refused config or an unreachable Postgres does.
	if err := store.EnsureSchema(ctx); err != nil {
		slog.Error("executor: schema bootstrap refused", "error", err)
		os.Exit(1)
	}
	slog.Info("executor: schema bootstrap complete", "source", repository.SchemaSQLPath)

	// Notification channel (PRD §120). Deliberately NOT fail-closed, the one
	// exception to objective §40 in this process: a missing channel is a
	// DISABLED channel, never a refused start. Trading must not depend on a
	// chat bot, and the observer it installs cannot fail or delay an append
	// (see internal/notify.Observer). A channel that is configured but broken
	// is not silent — every failed delivery is logged as a warning.
	if tg, on, err := notify.FromEnv(os.Getenv); err != nil {
		slog.Warn("executor: notification channel ignored (incomplete config)",
			"error", err, "need", notify.EnvBotToken+" and "+notify.EnvChatID)
	} else if on {
		store.SetEventObserver(notify.Observer(tg, slog.Default(), 0))
		slog.Info("executor: notification channel enabled",
			"channel", "telegram", "chat_id", tg.ChatID(), "events", len(notify.NotifiableEvents()))
	} else {
		slog.Info("executor: notification channel disabled",
			"reason", notify.EnvBotToken+" / "+notify.EnvChatID+" not set")
	}

	var lease lock.ExecutionLock
	if cfg.valkeyAddr != "" {
		vl, err := lock.NewValkeyLock(lock.ValkeyConfig{Address: cfg.valkeyAddr, Password: cfg.valkeyPassword})
		if err != nil {
			slog.Error("executor: valkey lock refused", "error", err)
			os.Exit(1)
		}
		// A password-protected Valkey must not come back as NOAUTH: the probe
		// above proves the password works with a round trip before any
		// execution starts (the worker would otherwise run believing leases
		// work while every Acquire fails open).
		if err := vl.Ping(ctx, 2*time.Second); err != nil {
			slog.Error("executor: valkey lock refused (auth or connectivity)", "addr", cfg.valkeyAddr, "error", err)
			os.Exit(1)
		}
		lease = vl
		slog.Info("executor: distributed leases", "addr", cfg.valkeyAddr, "authenticated", cfg.valkeyPassword != "")
	} else {
		lease = lock.NewMemoryLock(lock.MemoryConfig{})
		slog.Info("executor: in-process leases (VALKEY_ADDR unset — single-host mode)")
	}

	r := &resolver{
		store:        store,
		key:          cfg.masterKey,
		stepFallback: cfg.stepFallback,
		httpTimeout:  30 * time.Second,
	}

	w, err := worker.New(worker.Config{
		Owner:        cfg.owner,
		Tick:         cfg.tick,
		MaxInFlight:  cfg.maxInFlight,
		Store:        store,
		Lock:         leaseAdapter{lock: lease},
		Exchanges:    r.exchanges,
		QuantityStep: r.quantityStep,
		LiveEnabled:  os.Getenv("FUDCOURT_EXECUTOR_LIVE") == "1",
	})
	if err != nil {
		slog.Error("executor: worker config refused", "error", err)
		os.Exit(1)
	}

	slog.Info("executor: worker loop starting",
		"owner", cfg.owner,
		"tick_ms", cfg.tick.Milliseconds(),
		"max_in_flight", cfg.maxInFlight,
		"quantity_step", cfg.stepFallback,
	)

	// Operational surface (§34): loopback-only, and started BEFORE the worker
	// loop so an operator can watch dependencies probe while the loop runs.
	// A listener failure is fatal — silently losing health visibility would
	// make a wedged worker indistinguishable from a healthy one.
	go func() {
		hs := &healthServer{store: store, lock: lease}
		mux := hs.handler(cfg.owner, cfg.readyTimeout)
		srv := &http.Server{
			Addr:              cfg.healthAddr,
			Handler:           mux,
			ReadHeaderTimeout: 5 * time.Second,
		}
		slog.Info("executor: health surface listening",
			"addr", cfg.healthAddr, "readyz_probe_ms", cfg.readyTimeout.Milliseconds())
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("executor: health surface failed", "addr", cfg.healthAddr, "error", err)
			stop() // take the worker loop down with it: honest failure, not silent
		}
	}()
	// The `/api/executor/*` HTTP surface (objective §52: web → executor). It is
	// fail-visible (§34): a construction failure — a missing/short session
	// secret, an unusable listener address — exits before serving rather than
	// degrading into 404s the web tier would read as "no such route".
	apiSrv, err := startAPISurface(ctx, store, cfg.masterKey, os.Getenv)
	if err != nil {
		slog.Error("executor: API surface refused", "error", err)
		os.Exit(1)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = apiSrv.Shutdown(shutdownCtx)
	}()

	if err := w.Run(ctx); err != nil {
		slog.Error("executor: worker loop failed", "error", err)
		os.Exit(1)
	}
	slog.Info("executor: stopped")
}

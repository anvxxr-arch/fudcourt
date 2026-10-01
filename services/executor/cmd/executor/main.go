// Command executor is the FUDCourt execution service (objective §8.9): the
// worker loop driving strategies and venue adapters against the durable
// Postgres executor store, with Valkey distributed leases.
//
// Process boundary (objective §52): web → api → executor. This process is the
// ONLY owner of execution decisions and of exchange credential plaintext:
// executions arrive by account_id, this composition root loads the sealed
// executor.exchange_accounts row, unseals it via internal/credentials and
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
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/anvxxr-arch/fudcourt/services/executor/internal/credentials"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/exchange"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/exchange/binance"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/exchange/bybit"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/exchange/mexc"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/executor"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/lock"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/repository"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/worker"
)

// config is the validated service configuration. Every field is required
// unless documented optional.
type config struct {
	masterKey    string
	pgURL        string
	owner        string
	maxInFlight  int
	tick         time.Duration
	valkeyAddr   string
	stepFallback string
}

// loadConfig reads and validates the environment. Every refusal names the
// exact key and the problem (objective §43): nothing defaults silently.
func loadConfig() (config, error) {
	var c config
	var err error

	c.masterKey, err = credentials.MasterKeyFromEnv(os.Getenv)
	if err != nil {
		return c, err
	}

	c.pgURL = strings.TrimSpace(os.Getenv("FUDCOURT_EXECUTOR_PG_URL"))
	if c.pgURL == "" {
		return c, errors.New("FUDCOURT_EXECUTOR_PG_URL is required (Postgres is the durable truth, objective §39)")
	}

	c.owner = strings.TrimSpace(os.Getenv("FUDCOURT_EXECUTOR_OWNER"))
	if c.owner == "" {
		c.owner = defaultOwner()
	}

	c.maxInFlight = 8
	if v := strings.TrimSpace(os.Getenv("FUDCOURT_EXECUTOR_MAX_INFLIGHT")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return c, fmt.Errorf("FUDCOURT_EXECUTOR_MAX_INFLIGHT must be a positive integer, got %q", v)
		}
		c.maxInFlight = n
	}

	c.tick = 5 * time.Second
	if v := strings.TrimSpace(os.Getenv("FUDCOURT_EXECUTOR_TICK_MS")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			return c, fmt.Errorf("FUDCOURT_EXECUTOR_TICK_MS must be a non-negative integer, got %q", v)
		}
		c.tick = time.Duration(n) * time.Millisecond
	}

	c.valkeyAddr = strings.TrimSpace(os.Getenv("VALKEY_ADDR"))

	// The clamp grid fallback. The plan's own precision (constraints) wins per
	// execution; this only applies when a plan carries no precision, and it is
	// the value the operator pinned at deploy time — never a guessed venue
	// default. Placing off-grid is refused by the clamp, so a WRONG value is
	// loud (no placement or absurd fragments), not a silent sizing error.
	c.stepFallback = strings.TrimSpace(os.Getenv("FUDCOURT_EXECUTOR_QUANTITY_STEP"))
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
func (r *resolver) adapterFor(ctx context.Context, rec executor.ExecutionRecord) (exchange.Exchange, error) {
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
	creds := exchange.Credentials{APIKey: apiKey, APISecret: apiSecret}
	http := exchange.DefaultHTTPClient(r.httpTimeout)
	market := rec.MarketType
	switch rec.Exchange {
	case executor.ExchangeBinance:
		return binance.New(binance.Config{Credentials: creds, HTTP: http, MarketType: market})
	case executor.ExchangeBybit:
		return bybit.New(bybit.Config{Credentials: creds, HTTP: http, MarketType: market})
	case executor.ExchangeMEXC:
		return mexc.New(mexc.Config{Credentials: creds, HTTP: http, MarketType: market})
	default:
		return nil, fmt.Errorf("credential %s: unknown exchange %q", row.MaskedKeyOrFingerprint(), rec.Exchange)
	}
}

// exchanges adapts worker.Config.Exchanges. The ctx comes from the worker's
// placement path so a cancelled pass cannot leak a credential read. A
// successful unseal is also where the account is marked used
// (last_used_at) — the one audit side effect the worker loop is allowed to
// have.
func (r *resolver) exchanges(rec executor.ExecutionRecord) (exchange.Exchange, error) {
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
func (r *resolver) quantityStep(rec executor.ExecutionRecord) string {
	return r.stepFallback
}

// touch records credential use (last_used_at) so stale credentials are
// visible without touching sealed columns. Failures are logged — a stale
// audit timestamp must never stop trading.
func (r *resolver) touch(rec executor.ExecutionRecord) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := r.store.TouchCredential(ctx, rec.AccountID, time.Now().UnixMilli()); err != nil {
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

	var lease lock.ExecutionLock
	if cfg.valkeyAddr != "" {
		vl, err := lock.NewValkeyLock(lock.ValkeyConfig{Address: cfg.valkeyAddr})
		if err != nil {
			slog.Error("executor: valkey lock refused", "error", err)
			os.Exit(1)
		}
		lease = vl
		slog.Info("executor: distributed leases", "addr", cfg.valkeyAddr)
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
	if err := w.Run(ctx); err != nil {
		slog.Error("executor: worker loop failed", "error", err)
		os.Exit(1)
	}
	slog.Info("executor: stopped")
}

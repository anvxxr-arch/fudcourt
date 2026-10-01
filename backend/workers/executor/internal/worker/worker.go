// Package worker is the executor runtime loop (objective §8.9/§39/§65): it
// owns every live execution through a per-execution lease, drives the strategy
// engine one deterministic tick at a time, and enforces the hard safety rules:
//
//  1. Bounded concurrency (Config.MaxInFlight is a HARD cap — the worker spawns
//     exactly that many drivers and never one more).
//  2. Fail-closed leases (§65): no lease = no trading. A failed/contended
//     acquire leaves the execution completely untouched.
//  3. Over-order clamp (PRD §107): every CreateOrder goes through
//     orders.ClampChild first; a clamp shrinks the order and emits PLAN_RESIZED.
//  4. Recovery semantics (PRD §114): the FIRST pass after start reconciles with
//     the venue — adopting this worker's own children by deterministic client
//     order id — and places NOTHING. Later passes drive strategies.
//
// The venue is monetary truth (PRD §41/§95): a tick never trusts local state
// over the exchange. Every state change emits the matching
// executor.ExecutionEventRecord through the Store (PRD §63).
package worker

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/exchange"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/executor"
)

// Clock is the injected time source (house rule: deterministic tests). All
// timestamps in this package come from Clock.Now — never time.Now directly.
type Clock interface {
	// Now returns unix milliseconds.
	Now() int64
}

// ClockFunc adapts a function to Clock.
type ClockFunc func() int64

// Now implements Clock.
func (f ClockFunc) Now() int64 { return f() }

// Lock is the per-execution lease (objective §65).
//
// NOTE: this is deliberately a MINIMAL local interface rather than an import of
// an internal/lock package — the worker must not couple to a specific lease
// backend (Valkey, Postgres advisory, in-test fakes all satisfy this shape).
// It is structurally satisfied by internal/lock's implementations.
//
// INVARIANT (fail-closed): every method answers conservatively on ANY failure.
// Acquire false/err = "do not trade", Renew false/err = "lease lost — stop
// placing immediately", Release is best-effort (there is nothing to lose).
type Lock interface {
	// Acquire tries to take the lease on executionID for owner with a TTL.
	Acquire(executionID, owner string, ttlMs int64) (bool, error)
	// Renew extends a held lease; false means the lease is gone.
	Renew(executionID, owner string, ttlMs int64) (bool, error)
	// Release drops a held lease. Releasing someone else's lease must be a no-op.
	Release(executionID, owner string) error
}

// Store is the executor persistence boundary (objective §8.9). The five
// methods are exactly what the runtime loop needs — child FilledQuantity on
// the child-order rows carries the fill truth the clamp and strategies consume,
// so no separate fill store is required here. Every method takes a
// context.Context (house convention: internal/lock.ExecutionLock) so a
// database backend can be bounded and cancelled per call.
type Store interface {
	// LoadRecoverable returns every execution the worker may need to act on:
	// all non-terminal executions past DRAFT (CALCULATED…RECONCILING). The
	// worker itself decides which of those it actively drives.
	LoadRecoverable(ctx context.Context) ([]executor.ExecutionRecord, error)
	// SaveExecution upserts one execution record (keyed by ID).
	SaveExecution(ctx context.Context, rec executor.ExecutionRecord) error
	// ListChildOrders returns the execution's child orders (venue truth is
	// merged into these rows during reconciliation).
	ListChildOrders(ctx context.Context, executionID string) ([]executor.ChildOrderRecord, error)
	// SaveChildOrder upserts one child order (keyed by ExecutionID +
	// ClientOrderID) — inserting and updating go through the same call so a
	// replayed reconcile can never fork a child row.
	SaveChildOrder(ctx context.Context, rec executor.ChildOrderRecord) error
	// AppendEvent appends one immutable event record (PRD §63) and returns it
	// as stored. The STORE assigns the event id — its format is
	// evt_<executionID>_<seq>, where <seq> is a durable per-execution sequence
	// the store hands out (a database sequence in the durable implementation,
	// see internal/repository) — so ids stay unique and per-execution monotonic
	// across PROCESS RESTARTS. A caller-supplied ID is ignored. Events are
	// append-only: an appended event is never rewritten or deleted.
	AppendEvent(ctx context.Context, ev executor.ExecutionEventRecord) (executor.ExecutionEventRecord, error)
}

// Config wires one Worker (objective §8.9).
type Config struct {
	// Owner is this worker's lease owner token (worker id). Two workers MUST
	// use different owners or they can alias each other's leases.
	Owner string
	// Tick is the scheduler cadence. Zero means "manual Tick() calls only" —
	// the deterministic-test mode.
	Tick time.Duration
	// LockTTL is the per-execution lease TTL. Renew is attempted before every
	// placement batch.
	LockTTL time.Duration
	// MaxInFlight is the HARD cap on executions driven at once. Zero or less
	// refuses to run: unbounded goroutines are forbidden (house rule).
	MaxInFlight int
	// Clock is the injected time source. Nil selects the real clock.
	Clock Clock
	// Store and Lock are the persistence and lease backends.
	Store Store
	Lock  Lock
	// Exchanges resolves the venue adapter for one execution (the composition
	// root knows credentials; core code only sees exchange.Exchange).
	Exchanges func(executor.ExecutionRecord) (exchange.Exchange, error)
	// QuantityStep returns the instrument quantity step for the clamp's grid
	// (PRD §71). Empty output is fail-closed: no placement can pass the clamp.
	QuantityStep func(executor.ExecutionRecord) string
	// RiskCheck is the objective §39 risk-stop hook: it inspects the execution
	// record (and whatever the composition root knows) and reports a breach. A
	// breach cancels entry children and lands the execution in RISK_STOPPED —
	// it never silently violates the user's bound. Nil disables the hook.
	RiskCheck func(executor.ExecutionRecord) (breached bool, reason string)
	// Seed seeds strategy PRNGs (PRD §28). Zero selects the deterministic
	// default — jitter stays opt-in per execution config (DR-021 §2g).
	Seed uint32
}

// ErrConfig is returned when a Config is unusable (missing store/lock, non-
// positive MaxInFlight). The worker refuses to start rather than run unbounded
// or fail-open.
var ErrConfig = errors.New("worker: invalid config")

// ErrUnknownExecution is returned by StartExecution for an id the store does
// not know.
var ErrUnknownExecution = errors.New("worker: unknown execution")

// Worker is the runtime loop (objective §8.9). It is safe for concurrent use:
// Tick and Run may interleave with StartExecution.
type Worker struct {
	cfg     Config
	clock   Clock
	mu      sync.Mutex
	first   bool // the next pass is the recovery pass (PRD §114)
	running bool
	stop    context.CancelFunc
	done    chan struct{}
}

// New validates Config and returns a Worker. The FIRST pass the worker runs —
// whether through Run or the first Tick — is a recovery pass (PRD §114).
func New(cfg Config) (*Worker, error) {
	if cfg.Store == nil || cfg.Lock == nil || cfg.Exchanges == nil {
		return nil, fmt.Errorf("%w: Store, Lock and Exchanges are required", ErrConfig)
	}
	if cfg.MaxInFlight <= 0 {
		return nil, fmt.Errorf("%w: MaxInFlight must be positive (bounded concurrency)", ErrConfig)
	}
	if cfg.Owner == "" {
		return nil, fmt.Errorf("%w: Owner is required (lease identity)", ErrConfig)
	}
	if cfg.LockTTL <= 0 {
		cfg.LockTTL = 30 * time.Second // §65 default
	}
	if cfg.Tick < 0 {
		return nil, fmt.Errorf("%w: negative Tick", ErrConfig)
	}
	clk := cfg.Clock
	if clk == nil {
		clk = ClockFunc(func() int64 { return time.Now().UnixMilli() })
	}
	return &Worker{cfg: cfg, clock: clk, first: true, done: make(chan struct{})}, nil
}

// Run performs the recovery pass immediately and then drives a pass every
// Config.Tick until ctx is cancelled or Stop is called. With Config.Tick == 0
// it performs the recovery pass and waits for cancellation (manual Tick mode).
//
// INVARIANT: Run never overlaps two passes — a slow venue call must not
// double-drive an execution.
func (w *Worker) Run(ctx context.Context) error {
	w.mu.Lock()
	if w.running {
		w.mu.Unlock()
		return nil
	}
	runCtx, cancel := context.WithCancel(ctx)
	w.stop = cancel
	w.running = true
	w.done = make(chan struct{})
	w.mu.Unlock()

	defer func() {
		w.mu.Lock()
		w.running = false
		w.mu.Unlock()
		close(w.done)
	}()
	w.Tick(runCtx) // the first tick after start IS the recovery pass (PRD §114)
	if w.cfg.Tick <= 0 {
		<-runCtx.Done()
		return nil
	}
	ticker := time.NewTicker(w.cfg.Tick)
	defer ticker.Stop()
	for {
		select {
		case <-runCtx.Done():
			return nil
		case <-ticker.C:
			w.Tick(runCtx)
		}
	}
}

// Stop cancels a running Run and waits for its loop to exit. Idempotent.
func (w *Worker) Stop() {
	w.mu.Lock()
	stop, done, running := w.stop, w.done, w.running
	w.mu.Unlock()
	if !running {
		return
	}
	stop()
	<-done
}

// Tick performs ONE scheduler pass over every recoverable execution with
// bounded concurrency. The first pass reconciles only (placementEnabled=false,
// PRD §114); every later pass drives strategies.
func (w *Worker) Tick(ctx context.Context) {
	w.mu.Lock()
	placementEnabled := !w.first
	w.first = false
	w.mu.Unlock()

	records, err := w.cfg.Store.LoadRecoverable(ctx)
	if err != nil {
		return // store down: nothing honest to drive this pass
	}
	// A strict pool of MaxInFlight drivers: the goroutine count is fixed, work
	// is queued to it — never spawned per execution (house rule).
	jobs := make(chan executor.ExecutionRecord)
	var wg sync.WaitGroup
	n := w.cfg.MaxInFlight
	if n > len(records) {
		n = len(records)
	}
	for range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for rec := range jobs {
				w.drive(ctx, rec, placementEnabled)
			}
		}()
	}
	for _, rec := range records {
		select {
		case <-ctx.Done():
			// Cancellation stops NEW work; in-flight drivers finish their pass so
			// no lease is leaked mid-drive.
			close(jobs)
			wg.Wait()
			return
		case jobs <- rec:
		}
	}
	close(jobs)
	wg.Wait()
}

// StartExecution applies the start intent to one execution (objective §8.10):
// READY → RUNNING with an EXECUTION_STARTED event.
//
// INVARIANT: a duplicate StartExecution of a RUNNING execution is a NO-OP — no
// event, no write, no re-drive (objective §23). An illegal transition is
// refused with an error naming both states (the caller maps it to 409).
func (w *Worker) StartExecution(ctx context.Context, executionID string) (executor.ExecutionRecord, error) {
	records, err := w.cfg.Store.LoadRecoverable(ctx)
	if err != nil {
		return executor.ExecutionRecord{}, err
	}
	var rec executor.ExecutionRecord
	found := false
	for _, r := range records {
		if r.ID == executionID {
			rec, found = r, true
			break
		}
	}
	if !found {
		return executor.ExecutionRecord{}, fmt.Errorf("%w: %s", ErrUnknownExecution, executionID)
	}
	agg := execution.New(rec)
	now := w.clock.Now()
	updated, transitioned, err := agg.Apply(execution.CommandStart, now)
	if err != nil {
		return rec, err // *execution.TransitionError names both states
	}
	if !transitioned {
		return updated, nil // idempotent repeat: already RUNNING (objective §23)
	}
	if err := w.cfg.Store.SaveExecution(ctx, updated); err != nil {
		return rec, err
	}
	w.event(ctx, updated.ID, executor.EventExecutionStarted, map[string]any{
		"status": string(updated.Status),
	}, now)
	return updated, nil
}

// event appends one event record through the store, which ASSIGNS the event id
// from its own durable per-execution sequence (evt_<executionID>_<seq>, see
// worker.Store.AppendEvent). That is what makes the audit trail survive a
// process restart: the old per-process counter rewound to 1 on every restart
// and its duplicate-id appends were silently dropped. Logging stays
// best-effort at THIS call site — a failed append is the store's to report —
// exactly as before.
func (w *Worker) event(ctx context.Context, executionID string, name executor.ExecutionEventName, payload map[string]any, at int64) {
	if payload == nil {
		payload = map[string]any{}
	}
	_, _ = w.cfg.Store.AppendEvent(ctx, executor.ExecutionEventRecord{
		ExecutionID: executionID,
		Name:        name,
		Payload:     payload,
		CreatedAt:   at,
	})
}

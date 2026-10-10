package ingest

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// Engine runs the ingestion loop: seed the job registry from the provider
// modules, poll the store for due jobs, gate each candidate through its
// provider's rate limiter and circuit breaker, and dispatch the survivors to
// a bounded worker pool. Every attempt is journaled; failures back off
// exponentially; panics are recovered per job and dead-lettered.
//
// Engine is safe for concurrent use and shuts down gracefully: Run returns
// when ctx is cancelled, after in-flight jobs and workers have drained.
// With Config.Once, Run exits once every due job has been attempted (at most
// once) and the inflight set is empty — the "run what's scheduled, then stop"
// mode the scheduler/cron entry point uses.
type Engine struct {
	cfg       Config
	store     JobStore
	journal   RunJournal
	retention Retention
	modules   func() []Module
	logger    *slog.Logger
	writer    canon.Writer

	// jobs is the bounded dispatch channel workers consume from.
	jobs chan Job
	wg   sync.WaitGroup

	mu          sync.Mutex
	now         func() time.Time // injectable clock for tests
	limiter     map[string]*limiter
	breakers    map[string]*breaker
	suppress    map[string]time.Time // job key -> next eligible dispatch
	inflight    map[string]bool
	onceStarted bool // ONCE exit latch (see runOnce)
}

// Backoff constants (ADDENDUM C): exponential 2s * 2^attempt capped at 5m.
const (
	backoffBase = 2 * time.Second
	backoffMax  = 5 * time.Minute
)

// Status constants for data.job.status (idle <-> running) and
// data.ingestion_run.status. "running" is the pre-fetch guard that DueJobs
// excludes so a job cannot be double-dispatched while an attempt is in
// flight.
const (
	jobStatusIdle    = "idle"
	jobStatusFailed  = "failed"
	jobStatusRunning = "running"

	runStatusOK     = "ok"
	runStatusFailed = "failed"
)

// jobKey is the registry identity of a job: the (provider, dataset, subject,
// mode) tuple. It keys the in-memory maps (suppression, inflight) and the
// log lines.
func jobKey(j Job) string {
	return j.Provider + "|" + j.Dataset + "|" + j.Subject + "|" + j.Mode
}

// Config tunes the engine. Zero values fall back to the documented defaults:
// Workers 4, per-provider rate 5 rps with burst = rate, breaker open after 5
// consecutive failures, 60s half-open cooldown, 1s tick.
type Config struct {
	// Workers is the size of the bounded worker pool. <= 0 means 4.
	Workers int
	// Once runs every due job once, then returns (scheduler mode).
	Once bool
	// ProviderBurst overrides the per-provider token-bucket burst; the map
	// key is the provider name. Missing providers use the default rate
	// (5 rps) as their burst. Values <= 0 fall back to the default.
	ProviderBurst map[string]float64
	// BreakerThreshold is the consecutive-failure count that opens a
	// provider's breaker. <= 0 means 5.
	BreakerThreshold int
	// BreakerCooldown is how long an open breaker waits before going
	// half-open (one probe). <= 0 means 60s.
	BreakerCooldown time.Duration
	// Tick is the scheduler poll interval. <= 0 means 1s.
	Tick time.Duration
}

// New builds an Engine. modules is a function rather than a slice so the
// caller can wire provider adapters that are themselves constructed after the
// engine (e.g. because they share the engine's writer); returning nil or an
// empty slice is legal and simply means "no fetchers yet" — jobs with no
// fetcher for their dataset are skipped with a journal entry, never a crash.
func New(cfg Config, store JobStore, journal RunJournal, retention Retention, modules func() []Module, logger *slog.Logger, writer canon.Writer) *Engine {
	if cfg.Workers <= 0 {
		cfg.Workers = 4
	}
	if cfg.BreakerThreshold <= 0 {
		cfg.BreakerThreshold = 5
	}
	if cfg.BreakerCooldown <= 0 {
		cfg.BreakerCooldown = 60 * time.Second
	}
	if cfg.Tick <= 0 {
		cfg.Tick = time.Second
	}
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	} else {
		logger = slog.New(logger.Handler())
	}
	e := &Engine{
		cfg:       cfg,
		store:     store,
		journal:   journal,
		retention: retention,
		modules:   modules,
		logger:    logger,
		writer:    writer,
		jobs:      make(chan Job, 256),
		now:       time.Now,
		limiter:   map[string]*limiter{},
		breakers:  map[string]*breaker{},
		suppress:  map[string]time.Time{},
		inflight:  map[string]bool{},
	}
	return e
}

// Writer returns the engine-wide canon writer fetchers use when they were not
// constructed with their own handle.
func (e *Engine) Writer() canon.Writer { return e.writer }

// Run drives the loop until ctx is cancelled (graceful: workers drain) or,
// in ONCE mode, until every due job has been attempted once and the inflight
// set has drained. Retention sweeps continuously every sweepInterval; in
// ONCE mode it runs once before the dispatch loop starts.
func (e *Engine) Run(ctx context.Context) error {
	e.startWorkers(ctx)
	defer e.wg.Wait()

	// Seed/refresh the registry from the modules before the first tick.
	if e.modules != nil {
		var specs []JobSpec
		for _, m := range e.modules() {
			specs = append(specs, m.Jobs()...)
		}
		if len(specs) > 0 {
			if err := e.store.EnsureJobs(ctx, specs); err != nil {
				// Registry seed failure is not fatal: the store may be
				// reachable on the next tick and previously-registered jobs
				// keep running from their persisted rows.
				e.logger.ErrorContext(ctx, "ingest: EnsureJobs failed", "err", err)
			}
		}
	}

	if e.cfg.Once {
		if e.retention != nil {
			if _, err := e.retention.Sweep(ctx, e.now()); err != nil {
				e.logger.ErrorContext(ctx, "ingest: retention sweep failed", "err", err)
			}
		}
		return e.runOnce(ctx)
	}

	tick := time.NewTicker(e.cfg.Tick)
	defer tick.Stop()
	sweep := time.NewTicker(sweepInterval)
	defer sweep.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-sweep.C:
			if e.retention != nil {
				if _, err := e.retention.Sweep(ctx, e.now()); err != nil {
					e.logger.ErrorContext(ctx, "ingest: retention sweep failed", "err", err)
				}
			}
		case <-tick.C:
			e.tickOnce(ctx)
		}
	}
}

// sweepInterval is how often the continuous engine applies retention windows.
// Daily at heart; 6h bounds worst-case data age at half a day.
const sweepInterval = 6 * time.Hour

// runOnce implements ONCE mode: tick until the exit condition — no due jobs
// and nothing in flight. Jobs already attempted this Run drop out of the due
// list (their store state advanced), so the condition converges after every
// due job had exactly one attempt; backoff-suppressed jobs (or limiter/
// breaker-blocked ones) are also treated as "attempted" for ONCE purposes:
// retried runs belong to the next scheduled run, not this one.
func (e *Engine) runOnce(ctx context.Context) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		due, err := e.store.DueJobs(ctx, e.now(), 0)
		if err != nil {
			return fmt.Errorf("ingest: once mode: due jobs: %w", err)
		}
		e.mu.Lock()
		dispatched := e.dispatchDue(ctx, due, e.now())
		runnable := 0
		for _, j := range due {
			if e.runnableNow(j) {
				runnable++
			}
		}
		inflight := len(e.inflight)
		started := e.onceStarted
		e.mu.Unlock()
		// Exit when every due job has had its one attempt: nothing newly
		// dispatched, nothing in flight, and at least one pass saw a due job
		// (or the due list is empty). A job blocked the whole run by limiter
		// or breaker is skipped, not failed — its state is untouched and the
		// next scheduled run picks it up.
		if inflight == 0 && (len(due) == 0 || (dispatched == 0 && runnable == 0)) && (started || len(due) == 0) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(e.cfg.Tick):
		}
	}
}

// runnableNow reports whether job j would be dispatched this instant: not
// already in flight, not backoff-suppressed, limiter and breaker open.
// Caller holds e.mu.
func (e *Engine) runnableNow(j Job) bool {
	if e.inflight[jobKey(j)] {
		return false
	}
	if at, ok := e.suppress[jobKey(j)]; ok && e.now().Before(at) {
		return false
	}
	if !e.limiterFor(j.Provider).allow(e.now()) {
		return false
	}
	if !e.breakerFor(j.Provider).allow(e.now()) {
		return false
	}
	return true
}

// onceStarted records that this ONCE run saw at least one dispatchable job.
// It guards the (unlikely) empty-first-tick race where the registry seed has
// not landed yet; continuous mode never consults it.
// Caller holds e.mu.
func (e *Engine) markOnceStarted() {
	if e.cfg.Once && !e.onceStarted {
		e.onceStarted = true
	}
}

// tickOnce is one scheduler pass in continuous mode.
func (e *Engine) tickOnce(ctx context.Context) {
	due, err := e.store.DueJobs(ctx, e.now(), 0)
	if err != nil {
		e.logger.ErrorContext(ctx, "ingest: due jobs", "err", err)
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.dispatchDue(ctx, due, e.now())
}

// dispatchDue gates the due list through inflight/suppression/limiter/
// breaker and hands the survivors to the worker pool. Returns the number
// dispatched. Caller holds e.mu.
//
// Stream jobs (Mode "stream") flow through this identical gate: the per-
// provider rate limiter and circuit breaker protect the upstream exactly as
// for poll, and a stream fetcher's NextRunHint suppression is honored like
// any other job's, so a stream ticker can never hammer its provider beyond
// its limiter budget.
func (e *Engine) dispatchDue(ctx context.Context, due []Job, now time.Time) int {
	n := 0
	for _, job := range due {
		key := jobKey(job)
		if e.inflight[key] {
			continue
		}
		if at, ok := e.suppress[key]; ok && now.Before(at) {
			continue
		}
		if !e.limiterFor(job.Provider).allow(now) {
			continue
		}
		if !e.breakerFor(job.Provider).allow(now) {
			continue
		}
		// Consume the token at dispatch time; the limiter's refill is
		// lazily computed on the next allow().
		e.inflight[key] = true
		e.markOnceStarted()
		select {
		case e.jobs <- job:
			n++
		case <-ctx.Done():
			// Never leave a job marked inflight with no worker to run it.
			delete(e.inflight, key)
			return n
		}
	}
	return n
}

// startWorkers launches the bounded worker pool.
func (e *Engine) startWorkers(ctx context.Context) {
	for range e.cfg.Workers {
		e.wg.Add(1)
		go func() {
			defer e.wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case job, ok := <-e.jobs:
					if !ok {
						return
					}
					e.runJob(ctx, job)
				}
			}
		}()
	}
}

// runJob executes one attempt of one job: journal Start, fetch (panic-
// recovered), journal Finish, store bookkeeping, backoff/breaker updates.
// A panic in the fetcher is converted into a journal dead letter; it never
// takes down the worker.
func (e *Engine) runJob(ctx context.Context, job Job) {
	key := jobKey(job)
	defer func() {
		e.mu.Lock()
		delete(e.inflight, key)
		e.mu.Unlock()
	}()

	attempt := job.RetryCount + 1
	runID, jerr := e.journal.Start(ctx, job, attempt)
	if jerr != nil {
		// Fail-open: an unreachable journal must not stop the fetch. Finish
		// is skipped (no row to update) but the store bookkeeping below
		// still records the attempt outcome.
		e.logger.ErrorContext(ctx, "ingest: journal start failed", "job", key, "err", jerr)
	}

	var res FetchResult
	var ferr error
	func() {
		defer func() {
			if r := recover(); r != nil {
				ferr = &panicError{msg: fmt.Sprintf("panic in fetcher %s/%s: %v", job.Provider, job.Dataset, r)}
				res = FetchResult{}
				e.logger.ErrorContext(ctx, "ingest: fetcher panic", "job", key, "err", ferr)
			}
		}()
		res, ferr = e.fetcherFor(job).Fetch(ctx, job, e.writer)
	}()

	now := e.now()
	if ferr == nil {
		if jerr == nil {
			if err := e.journal.Finish(ctx, runID, runStatusOK, res, nil); err != nil {
				e.logger.ErrorContext(ctx, "ingest: journal finish failed", "job", key, "err", err)
			}
		}
		if err := e.store.MarkSuccess(ctx, job, now, res.Next); err != nil {
			e.logger.ErrorContext(ctx, "ingest: mark success failed", "job", key, "err", err)
		}
		e.mu.Lock()
		e.breakerFor(job.Provider).success()
		delete(e.suppress, key)
		e.mu.Unlock()
		if res.NextRunHint != nil && *res.NextRunHint > 0 {
			e.mu.Lock()
			e.suppressJob(key, now.Add(*res.NextRunHint))
			e.mu.Unlock()
		}
		return
	}

	// Failure path: journal, store attempt, breaker trip, backoff.
	if jerr == nil {
		if err := e.journal.Finish(ctx, runID, runStatusFailed, res, ferr); err != nil {
			e.logger.ErrorContext(ctx, "ingest: journal finish failed", "job", key, "err", err)
		}
	}
	if err := e.store.MarkAttempt(ctx, job, now, ferr); err != nil {
		e.logger.ErrorContext(ctx, "ingest: mark attempt failed", "job", key, "err", err)
	}
	delay := backoffDelay(job.RetryCount)
	terminal := delay >= backoffMax
	e.mu.Lock()
	e.breakerFor(job.Provider).failure(now)
	e.suppressJob(key, now.Add(delay))
	e.mu.Unlock()

	// Terminal failure (backoff cap reached) or a recovered panic:
	// dead-letter with the offending payload for later replay. A panic has
	// no result payload; a normal terminal failure carries whatever the
	// fetcher managed to produce.
	if terminal || isPanic(ferr) {
		payload := any(res.Next)
		if isPanic(ferr) {
			payload = map[string]any{"panic": ferr.Error()}
		}
		if err := e.journal.DeadLetter(ctx, job, ferr, payload); err != nil {
			e.logger.ErrorContext(ctx, "ingest: dead letter failed", "job", key, "err", err)
		}
	}
}

// isPanic reports whether the error came from the fetcher's recover().
func isPanic(err error) bool {
	var p *panicError
	return errors.As(err, &p)
}

// panicError marks a recovered fetcher panic (and carries the recovered
// value) so the failure path can distinguish "dead-letter always" from
// "dead-letter at backoff cap".
type panicError struct{ msg string }

func (p *panicError) Error() string { return p.msg }

// suppressJob records the next eligible dispatch time for a job. Caller
// holds e.mu.
func (e *Engine) suppressJob(key string, at time.Time) {
	e.suppress[key] = at
}

// fetcherFor resolves the fetcher for one job's (provider, dataset) pair from
// the module list. A missing fetcher yields a stub that fails the attempt
// (so it is journaled and backs off like any failure) instead of silently
// succeeding.
func (e *Engine) fetcherFor(job Job) Fetcher {
	if e.modules == nil {
		return missingFetcher{job: job}
	}
	for _, m := range e.modules() {
		if m.Provider() != job.Provider {
			continue
		}
		if f, ok := m.Fetchers()[job.Dataset]; ok && f != nil {
			return f
		}
	}
	return missingFetcher{job: job}
}

// missingFetcher fails jobs whose provider module is not loaded (or has no
// fetcher for the dataset). It exists so runJob has a single code path: the
// attempt is journaled, the store records the failure, and backoff keeps the
// engine from spinning on a job nobody can serve.
type missingFetcher struct{ job Job }

func (m missingFetcher) Fetch(_ context.Context, job Job, _ canon.Writer) (FetchResult, error) {
	return FetchResult{}, fmt.Errorf("ingest: no fetcher for %s/%s", job.Provider, job.Dataset)
}

// backoffDelay is the exponential backoff for the NEXT retry after a failed
// attempt: base 2s * 2^attempt, capped at 5m (ADDENDUM C). attempt is the
// zero-based count of prior failures carried by the job (Job.RetryCount).
// The loop is clamped so the shift can never overflow.
func backoffDelay(attempt int) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	d := backoffBase
	for range attempt {
		d *= 2
		if d >= backoffMax {
			return backoffMax
		}
	}
	if d > backoffMax {
		return backoffMax
	}
	return d
}

// limiter is a lazily-refilled token bucket: burst tokens, refilled at rate
// tokens/second, computed against the last time the bucket was touched. Not
// goroutine-safe by itself; the engine serializes access under e.mu (both
// the dispatch gate and the tests run under it), which keeps one bucket per
// provider consistent.
type limiter struct {
	rate     float64   // tokens per second
	burst    float64   // bucket capacity
	tokens   float64   // current tokens
	last     time.Time // last refill anchor
	zeroLast bool      // distinguishes "never touched" from t0
}

func (l *limiter) allow(now time.Time) bool {
	if !l.zeroLast {
		elapsed := now.Sub(l.last).Seconds()
		if elapsed > 0 {
			l.tokens = math.Min(l.burst, l.tokens+elapsed*l.rate)
		}
	}
	l.last = now
	l.zeroLast = false
	if l.tokens >= 1 {
		l.tokens--
		return true
	}
	return false
}

// limiterFor returns the bucket for one provider, creating it on first use
// with the configured burst (default: the provider's default rate, 5 rps).
// Caller holds e.mu.
func (e *Engine) limiterFor(provider string) *limiter {
	l, ok := e.limiter[provider]
	if !ok {
		burst := 5.0
		if v, ok := e.cfg.ProviderBurst[provider]; ok && v > 0 {
			burst = v
		}
		l = &limiter{rate: 5, burst: burst, tokens: burst, zeroLast: true}
		e.limiter[provider] = l
	}
	return l
}

// defaultRate is the per-provider token-bucket refill rate (rps).
const defaultRate = 5

// breaker is the per-provider circuit breaker: closed (normal), open
// (everything rejected), half-open (exactly one probe allowed through).
// Serialized under e.mu like the limiter.
type breaker struct {
	threshold   int
	cooldown    time.Duration
	consecutive int
	state       breakerState
	openedAt    time.Time
	probing     bool
}

type breakerState int

const (
	breakerClosed breakerState = iota
	breakerOpen
	breakerHalfOpen
)

func (b *breaker) allow(now time.Time) bool {
	switch b.state {
	case breakerClosed:
		return true
	case breakerOpen:
		if now.Sub(b.openedAt) >= b.cooldown {
			b.state = breakerHalfOpen
			b.probing = true
			return true
		}
		return false
	case breakerHalfOpen:
		// One probe at a time: a second caller while the probe is in flight
		// is rejected.
		if b.probing {
			return false
		}
		b.probing = true
		return true
	}
	return false
}

func (b *breaker) success() {
	switch b.state {
	case breakerHalfOpen:
		b.state = breakerClosed
		b.probing = false
	}
	b.consecutive = 0
}

func (b *breaker) failure(now time.Time) {
	b.consecutive++
	if b.state == breakerHalfOpen {
		// The probe failed: reopen for a fresh cooldown.
		b.state = breakerOpen
		b.openedAt = now
		b.probing = false
		return
	}
	if b.consecutive >= b.threshold {
		b.state = breakerOpen
		b.openedAt = now
		b.probing = false
	}
}

// breakerFor returns the breaker for one provider, creating it on first use.
// Caller holds e.mu.
func (e *Engine) breakerFor(provider string) *breaker {
	b, ok := e.breakers[provider]
	if !ok {
		b = &breaker{threshold: e.cfg.BreakerThreshold, cooldown: e.cfg.BreakerCooldown}
		e.breakers[provider] = b
	}
	return b
}

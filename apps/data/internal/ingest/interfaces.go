// Package ingest runs the fudcourt-data ingestion engine: the scheduler and
// worker pool that drive provider fetchers, the pgx-backed job store and run
// journal, the embedded schema applier, and the retention sweeper.
//
// The types in this file are the frozen ADDENDUM C surface (implementation
// contract): provider adapters (internal/ingest/providers/*) implement Module
// and Fetcher, the HTTP layer (internal/ingest/serve) drives Module/Fetcher
// directly for manual runs, and engine wires JobStore + RunJournal + Retention
// together. The pgx implementations of JobStore and RunJournal live in this
// package (jobstore.go, journal.go); the pgx implementation of the canon
// store the fetchers write through lives in internal/ingest/repo.
//
// Job lifecycle (contract §Job model): Module.Jobs() seeds data.job via
// JobStore.EnsureJobs at engine startup; the engine polls JobStore.DueJobs,
// gates each candidate through the per-provider rate limiter and circuit
// breaker, dispatches to a bounded worker pool, and journals every attempt in
// data.ingestion_run. A failed attempt is recorded by JobStore.MarkAttempt
// and retried on an exponential backoff (2s * 2^attempt, capped at 5m); a
// terminal failure (backoff cap reached, or a recovered panic) is dead-lettered
// into data.ingestion_error via RunJournal.DeadLetter. Provider failures never
// crash unrelated jobs; panics are recovered per job.
package ingest

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// Cursor is the provider-defined checkpoint a fetcher persists after a
// successful run (next page, next timestamp, ...). It round-trips through the
// job store as jsonb; its internal shape is owned by the fetcher that wrote it.
type Cursor map[string]any

// Job is one dataset job as stored in data.job: what to fetch, how often, and
// where the previous run stopped. Schedule/Priority mirror the job row's
// schedule_seconds/priority columns; the runtime state fields (Cursor,
// LastSuccess, LastAttempt, RetryCount) are whatever the store currently holds.
type Job struct {
	Provider    string
	Dataset     string
	Subject     string
	Mode        string // "poll" | "backfill"
	Schedule    time.Duration
	Priority    int
	Cursor      Cursor
	LastSuccess *time.Time
	LastAttempt *time.Time
	RetryCount  int
}

// FetchResult is one fetcher run's outcome: how many rows the provider
// returned, what the store accepted and rejected, and the checkpoint for the
// next run. NextRunHint, when set, overrides the job's fixed schedule for the
// NEXT dispatch only (an in-memory advisory; the store keeps applying the
// persisted schedule).
type FetchResult struct {
	RowsIn       int
	RowsWritten  int
	RowsRejected int
	Next         Cursor
	NextRunHint  *time.Duration
}

// Fetcher fetches one dataset for one job and writes canonical rows through
// the store writer. Adapters constructed with their own repo handle write
// through it; w, when non-nil, is the engine-wide writer to prefer.
type Fetcher interface {
	Fetch(ctx context.Context, job Job, w canon.Writer) (FetchResult, error)
}

// Module is one provider adapter's contribution to the engine: its name (the
// data.job provider column), one fetcher per dataset it serves, and the jobs
// it wants seeded into the registry.
type Module interface {
	Provider() string
	Fetchers() map[string]Fetcher // key = dataset
	Jobs() []JobSpec
}

// JobSpec is the seed form of a job: the identity tuple plus its schedule and
// priority. Enabled rows are seeded enabled; the job store preserves runtime
// state (cursor, last_success, retry_count) of an existing row on re-seed.
//
// Mode "stream" marks a higher-frequency ticker job. It is dispatched on
// Schedule exactly like "poll" — same limiter/breaker/suppression gates — but
// the fetcher owns its effective cadence via FetchResult.NextRunHint: the
// engine suppresses the next dispatch until the hinted cadence elapses. On
// success the fetched quotes additionally land in the Valkey hot cache
// (data:quote:<venue id>:<instrument id>) next to the Postgres write.
type JobSpec struct {
	Provider string
	Dataset  string
	Subject  string
	Mode     string
	Schedule time.Duration
	Priority int
	Enabled  bool
}

// JobStore persists the job registry (data.job). EnsureJobs upserts schedule/
// priority/enabled and preserves the runtime state of an existing row.
// DueJobs returns enabled jobs whose last_attempt + schedule <= now (limit 0
// means no limit). MarkAttempt records a FAILED attempt (status, last_attempt,
// retry_count+1); MarkSuccess resets the retry counter and stores the cursor.
type JobStore interface {
	EnsureJobs(ctx context.Context, specs []JobSpec) error
	DueJobs(ctx context.Context, now time.Time, limit int) ([]Job, error)
	MarkAttempt(ctx context.Context, job Job, at time.Time, jobErr error) error
	MarkSuccess(ctx context.Context, job Job, at time.Time, cursor Cursor) error
	ListEnabled(ctx context.Context) ([]Job, error)
}

// RunJournal writes the per-attempt audit trail: one data.ingestion_run row
// per attempt (Start/Finish) and dead letters into data.ingestion_error
// (DeadLetter) for terminal failures.
type RunJournal interface {
	Start(ctx context.Context, job Job, attempt int) (int64, error)
	Finish(ctx context.Context, runID int64, status string, res FetchResult, jobErr error) error
	DeadLetter(ctx context.Context, job Job, jobErr error, payload any) error
}

// Retention applies the dataset TTLs (contract §43): one Sweep deletes every
// row older than its dataset's window and returns the rows deleted. Datasets
// with a permanent window are never swept.
type Retention interface {
	Sweep(ctx context.Context, now time.Time) (int64, error)
}

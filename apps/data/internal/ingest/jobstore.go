package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// PGJobStore is the pgx implementation of JobStore over the data.job registry
// (ADDENDUM B table 12). The SQL mirrors the table shape exactly: the UNIQUE
// (provider, dataset, subject, mode) tuple is the identity, cursor is jsonb,
// and EnsureJobs upserts ONLY the seed columns (schedule, priority, enabled)
// while preserving the runtime state an existing row already carries
// (cursor, last_success, last_attempt, status, retry_count).
type PGJobStore struct {
	pool Executor
}

// Executor is the subset of *pgxpool.Pool the store and journal need (the
// same shape the executor's repository code programs against): query rows,
// one row, and plain exec.
type Executor interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (any, error)
	SendBatch(ctx context.Context, b *pgx.Batch) pgx.BatchResults
}

// NewPGJobStore builds a JobStore on a *pgxpool.Pool.
func NewPGJobStore(pool Executor) *PGJobStore { return &PGJobStore{pool: pool} }

// jobColumns is the SELECT projection of the data.job rows -> Job. Column
// order matches jobFromRow's scanner order and the ADDENDUM B table shape.
const jobColumns = `provider, dataset, subject, mode, schedule_seconds, priority,
	cursor, last_success, last_attempt, retry_count`

// EnsureJobs seeds/refreshes the registry. For each spec: insert, or on the
// identity conflict update ONLY schedule, priority and enabled (EXCLUDED
// values) and leave last_attempt, status,
// retry_count, cursor and last_success untouched — a re-seed must never wipe
// a job's runtime state. The upsert also refreshes updated_at.
func (s *PGJobStore) EnsureJobs(ctx context.Context, specs []JobSpec) error {
	if len(specs) == 0 {
		return nil
	}
	b := &pgx.Batch{}
	for _, spec := range specs {
		if spec.Provider == "" || spec.Dataset == "" {
			return fmt.Errorf("ingest: EnsureJobs: provider and dataset are required (got %q/%q)", spec.Provider, spec.Dataset)
		}
		if spec.Schedule <= 0 {
			return fmt.Errorf("ingest: EnsureJobs: %s/%s: schedule must be positive, got %s", spec.Provider, spec.Dataset, spec.Schedule)
		}
		mode := spec.Mode
		if mode == "" {
			mode = "poll"
		}
		priority := spec.Priority
		if priority == 0 {
			priority = defaultPriority
		}
		b.Queue(`INSERT INTO data.job
			(provider, dataset, subject, mode, schedule_seconds, priority, enabled)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (provider, dataset, subject, mode) DO UPDATE
			SET schedule_seconds = EXCLUDED.schedule_seconds,
				priority = EXCLUDED.priority,
				enabled = EXCLUDED.enabled,
				updated_at = now()`,
			spec.Provider, spec.Dataset, spec.Subject, mode,
			int(spec.Schedule/time.Second), priority, spec.Enabled)
	}
	return s.pool.SendBatch(ctx, b).Close()
}

// DueJobs returns enabled, dispatchable jobs: status is not 'running'
// (double-dispatch guard) and last_attempt + schedule <= now. limit <= 0
// means no limit. Ties order by priority ascending (lower runs first), then
// by last_attempt nulls first (never-attempted jobs first).
func (s *PGJobStore) DueJobs(ctx context.Context, now time.Time, limit int) ([]Job, error) {
	q := strings.Builder{}
	q.WriteString("SELECT " + jobColumns + " FROM data.job\n")
	q.WriteString("WHERE enabled AND status <> $1\n")
	q.WriteString("  AND (last_attempt IS NULL OR last_attempt + make_interval(secs => schedule_seconds) <= $2)\n")
	args := []any{jobStatusRunning, now}
	if limit > 0 {
		q.WriteString("ORDER BY priority, last_attempt NULLS FIRST\nLIMIT $" + fmt.Sprint(len(args)+1))
		args = append(args, limit)
	} else {
		q.WriteString("ORDER BY priority, last_attempt NULLS FIRST")
	}
	rows, err := s.pool.Query(ctx, q.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("ingest: due jobs: %w", err)
	}
	defer rows.Close()
	return scanJobs(rows)
}

// ListEnabled returns every enabled job regardless of due-ness (the serve
// layer's registry listing).
func (s *PGJobStore) ListEnabled(ctx context.Context) ([]Job, error) {
	rows, err := s.pool.Query(ctx,
		"SELECT "+jobColumns+" FROM data.job WHERE enabled ORDER BY provider, dataset, subject, mode")
	if err != nil {
		return nil, fmt.Errorf("ingest: list enabled jobs: %w", err)
	}
	defer rows.Close()
	return scanJobs(rows)
}

// MarkAttempt records a FAILED attempt: last_attempt = at, status = 'failed',
// retry_count = retry_count + 1. The 'failed' status keeps DueJobs returning
// the job (retry), while the engine's in-memory backoff suppression decides
// when it is actually dispatched again.
func (s *PGJobStore) MarkAttempt(ctx context.Context, job Job, at time.Time, _ error) error {
	// The failure text is already journaled in data.ingestion_run; the job
	// row deliberately stores no error column (ADDENDUM B shape), so only
	// the attempt bookkeeping lands here.
	_, err := s.pool.Exec(ctx, `UPDATE data.job
		SET last_attempt = $1, status = $2, retry_count = retry_count + 1, updated_at = now()
		WHERE provider = $3 AND dataset = $4 AND subject = $5 AND mode = $6`,
		at, jobStatusFailed, job.Provider, job.Dataset, job.Subject, job.Mode)
	if err != nil {
		return fmt.Errorf("ingest: mark attempt %s: %w", jobKey(job), err)
	}
	return nil
}

// MarkSuccess records a successful attempt: status back to 'idle',
// last_attempt/last_success = at, retry_count reset, cursor persisted
// (jsonb; nil cursor stores SQL NULL).
func (s *PGJobStore) MarkSuccess(ctx context.Context, job Job, at time.Time, cursor Cursor) error {
	var cur any
	if cursor != nil {
		b, err := json.Marshal(map[string]any(cursor))
		if err != nil {
			return fmt.Errorf("ingest: mark success %s: marshal cursor: %w", jobKey(job), err)
		}
		cur = b
	}
	_, err := s.pool.Exec(ctx, `UPDATE data.job
		SET last_attempt = $1, last_success = $2, status = $3, retry_count = 0, cursor = $4, updated_at = now()
		WHERE provider = $5 AND dataset = $6 AND subject = $7 AND mode = $8`,
		at, at, jobStatusIdle, cur, job.Provider, job.Dataset, job.Subject, job.Mode)
	if err != nil {
		return fmt.Errorf("ingest: mark success %s: %w", jobKey(job), err)
	}
	return nil
}

// scanJobs drains a data.job row set into Jobs. Scan errors are fail-visible:
// the first one aborts the scan.
func scanJobs(rows pgx.Rows) ([]Job, error) {
	var out []Job
	for rows.Next() {
		job, err := jobFromRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, job)
	}
	return out, rows.Err()
}

// jobScanner is the subset of pgx.Rows one data.job row needs.
type jobScanner interface {
	Scan(dest ...any) error
}

// jobFromRow scans one row (projection = jobColumns order) into a Job. The
// cursor jsonb round-trips through []byte; an empty/invalid cursor decodes to
// an empty non-nil map — a corrupt cursor must not wedge the job, and an
// absent one must not surface as a fake checkpoint.
func jobFromRow(r jobScanner) (Job, error) {
	var j Job
	var secs int
	var cursor []byte
	if err := r.Scan(&j.Provider, &j.Dataset, &j.Subject, &j.Mode, &secs, &j.Priority,
		&cursor, &j.LastSuccess, &j.LastAttempt, &j.RetryCount); err != nil {
		return Job{}, fmt.Errorf("ingest: scan job row: %w", err)
	}
	j.Schedule = time.Duration(secs) * time.Second
	if len(cursor) > 0 {
		c := Cursor{}
		if err := json.Unmarshal(cursor, &c); err != nil {
			return Job{}, fmt.Errorf("ingest: scan job row %s: cursor: %w", jobKey(j), err)
		}
		j.Cursor = c
	}
	return j, nil
}

// defaultPriority mirrors data.job's DEFAULT 5 (ADDENDUM B table 12).
const defaultPriority = 5

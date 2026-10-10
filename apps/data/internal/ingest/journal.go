package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
	"unicode/utf8"
)

// PGRunJournal is the pgx implementation of RunJournal over
// data.ingestion_run (per-attempt audit trail) and data.ingestion_error
// (dead letters) — ADDENDUM B tables 13 and 14.
type PGRunJournal struct {
	pool Executor
}

// NewPGRunJournal builds a RunJournal on a *pgxpool.Pool.
func NewPGRunJournal(pool Executor) *PGRunJournal { return &PGRunJournal{pool: pool} }

// Start opens one ingestion_run row: what is about to run and which attempt
// this is. The row is created with status 'running' and finished_at NULL; a
// crash between Start and Finish leaves exactly the audit trail a restart
// needs to see.
func (j *PGRunJournal) Start(ctx context.Context, job Job, attempt int) (int64, error) {
	var id int64
	err := j.pool.QueryRow(ctx, `INSERT INTO data.ingestion_run
		(provider, dataset, subject, mode, started_at, status, attempt)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id`,
		job.Provider, job.Dataset, job.Subject, job.Mode, time.Now(), jobStatusRunning, attempt).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("ingest: journal start %s: %w", jobKey(job), err)
	}
	return id, nil
}

// Finish closes one ingestion_run row with the outcome. status is the
// engine's verdict ("ok"/"failed"); counts come from the FetchResult; on
// failure the error text is truncated to 4000 chars so a huge upstream
// response body cannot overflow the column semantics (text, but log-safe).
func (j *PGRunJournal) Finish(ctx context.Context, runID int64, status string, res FetchResult, jobErr error) error {
	var errText any
	if jobErr != nil {
		errText = truncateErrText(jobErr.Error())
	}
	_, err := j.pool.Exec(ctx, `UPDATE data.ingestion_run
		SET finished_at = $2, status = $3, rows_in = $4, rows_written = $5,
			rows_rejected = $6, error = $7
		WHERE id = $1`,
		runID, time.Now(), status, res.RowsIn, res.RowsWritten, res.RowsRejected, errText)
	if err != nil {
		return fmt.Errorf("ingest: journal finish run %d: %w", runID, err)
	}
	return nil
}

// DeadLetter records a terminal failure into data.ingestion_error with the
// offending payload (marshalled to jsonb; a payload that cannot marshal is
// stored as its formatted string — the payload must survive, not the round-
// trip). run_id is set when the failure came from a journaled run; recovered
// panics before the journal row existed store NULL.
func (j *PGRunJournal) DeadLetter(ctx context.Context, job Job, jobErr error, payload any) error {
	var payloadJSON []byte
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			b = []byte(fmt.Sprintf("%v", payload))
		}
		payloadJSON = b
	}
	_, err := j.pool.Exec(ctx, `INSERT INTO data.ingestion_error
		(provider, dataset, subject, occurred_at, error, payload, run_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		job.Provider, job.Dataset, job.Subject, time.Now(),
		truncateErrText(jobErr.Error()), payloadJSON, nil)
	if err != nil {
		return fmt.Errorf("ingest: dead letter %s: %w", jobKey(job), err)
	}
	return nil
}

// truncateErrText bounds an error string for storage: cap 4000 chars, a hard
// stop at the last complete rune so a multi-byte character is never split.
func truncateErrText(s string) string {
	const max = 4000
	if len(s) <= max {
		return s
	}
	cut := s[:max]
	// Trim trailing partial rune: drop bytes until the tail is valid UTF-8.
	for len(cut) > 0 && !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut
}

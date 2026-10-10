// Package repo is the pgx implementation of the canon store (ADDENDUM A):
// the batch upserts and fact writers the fetchers call, and the windowed
// reads the /api/data handlers serve. The pool is narrowed to an interface
// (Executor: Query/QueryRow/Exec/SendBatch/CopyFrom) so tests inject fakes
// and the package never needs the concrete *pgxpool.Pool type.
//
// Validation is contract §35 and lives in validate.go as pure functions;
// writers use them to split every batch into accepted and rejected rows and
// return the counts (written rows were persisted, rejected rows were counted,
// never silently dropped, never faked with a zero).
package repo

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Executor is the subset of *pgxpool.Pool the repo needs.
type Executor interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (any, error)
	SendBatch(ctx context.Context, b *pgx.Batch) pgx.BatchResults
	CopyFrom(ctx context.Context, tableName pgx.Identifier, columnNames []string, rowSrc pgx.CopyFromSource) (int64, error)
}

// Repo is the pgx canon store. Construct with New; the zero value is not
// usable.
type Repo struct {
	pool Executor
}

// New builds a canon store on a *pgxpool.Pool.
func New(pool Executor) *Repo { return &Repo{pool: pool} }

// Pool exposes the underlying executor for adapters that need to run their
// own statements against the same pool.
func (r *Repo) Pool() Executor { return r.pool }

// HealthCheck is the liveness probe: SELECT 1.
func (r *Repo) HealthCheck(ctx context.Context) error {
	var one int
	return r.pool.QueryRow(ctx, "SELECT 1").Scan(&one)
}

// clampLimit applies the read-side limit semantics: zero (or negative) means
// the provider default, everything above the cap is clamped to the cap. The
// cap exists so one unbounded client cannot stream a hypertable through the
// API.
const (
	defaultLimit = 100
	maxLimit     = 1000
)

func clampLimit(limit int) int {
	if limit <= 0 {
		return defaultLimit
	}
	if limit > maxLimit {
		return maxLimit
	}
	return limit
}

// filter assembles a WHERE clause with positional $n placeholders. clauses
// and args stay in lockstep; numbering starts at 1 and increments per add.
type filter struct {
	clauses []string
	args    []any
}

func (f *filter) add(cond string, args ...any) {
	f.clauses = append(f.clauses, cond)
	f.args = append(f.args, args...)
}

func (f *filter) where() string {
	if len(f.clauses) == 0 {
		return ""
	}
	return " WHERE " + joinAnd(f.clauses)
}

func (f *filter) nextArg() string {
	return "$" + itoa(len(f.args)+1)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func joinAnd(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += " AND "
		}
		out += p
	}
	return out
}

// timeRange adds the half-open [start, end) window conditions (contract
// Reader: zero start/end mean unbounded on that side).
func (f *filter) timeRange(col string, start, end time.Time) {
	if !start.IsZero() {
		f.add(col+" >= "+f.nextArg(), start)
	}
	if !end.IsZero() {
		f.add(col+" < "+f.nextArg(), end)
	}
}

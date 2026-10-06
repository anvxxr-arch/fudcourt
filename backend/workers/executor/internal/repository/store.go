// Package repository is the durable Postgres implementation of the executor
// worker's Store (objective §8.9): every execution, child order and audit
// event lives in the tracked executor.* schema
// (database/schema/executor-schema.sql), not in process memory.
//
// DURABILITY GUARANTEES
//
//   - Upserts are atomic statements keyed exactly like the in-test
//     worker.MemoryStore: SaveExecution upserts by id, SaveChildOrder upserts
//     by (execution_id, client_order_id). A replayed reconcile updates the one
//     row; it can never fork a second one. Rows are read back in the same
//     record shape the worker writes (the child row key is the deterministic
//     (execution, client order id) pair; the table's uuid primary key is an
//     internal surrogate).
//
//   - Events are append-only and immutable (PRD §63): this package contains no
//     UPDATE or DELETE of executor.execution_events and none may be added.
//     Every AppendEvent inserts exactly one new row; history is never
//     rewritten and an already-appended event can never be overwritten.
//
//   - Event ids are restart-safe. The id is
//
//     evt_<executionID>_<seq>
//
//     where <seq> is the executor.execution_events.id value (bigserial)
//     assigned by the database in the INSERT … RETURNING id that appends the
//     row. The sequence is allocated in the database — monotonic, never
//     reused, shared by every process — so ids are unique across process
//     restarts (the failure mode of a per-process counter) and the ids of one
//     execution strictly increase: they are a subsequence of a strictly
//     increasing sequence. No in-process counter exists anywhere in this
//     design, so a restart cannot "rewind" an id and silently swallow an
//     append. (The per-execution sequence is durable by construction: a row's
//     seq can be recovered from the row itself, so EventSeq reads it back.)
//
//   - A caller-supplied event id is ignored: the store owns id assignment and
//     returns the stored record. Immutability is structural — there is no
//     rewrite path — and unique-by-construction ids mean no two appends can
//     ever collide in the first place.
//
//   - There are no package-level clients or connection state: one *Store owns
//     one pgxpool.Pool and every method takes a context.Context, so callers
//     bound and cancel every database round trip (house convention:
//     internal/platform/lock.ExecutionLock).
//
// The domain carries money and quantities as decimal strings while the schema
// stores double precision (the schema's convention: wire values are numbers).
// Conversion happens at this boundary only, via strconv round-trip formatting;
// a decimal string that does not parse is refused with a clear error, never
// silently replaced by zero (house rule: no fabricated figures). Nullable
// decimals are honest *string nil, never empty-but-present.
package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/runtime/worker"
	"github.com/jackc/pgx/v5/pgxpool"
)

// EventObserver is notified after an event row is durably appended. It is
// called with the STORED record (id assigned), on the appending goroutine, so
// an implementation must return promptly — an outbound notification belongs on
// its own goroutine (see internal/notify.Observer).
//
// The observer is a courtesy, never a dependency: it cannot fail an append and
// is never consulted for the row's content. The durable write is the truth.
type EventObserver func(execution.ExecutionEventRecord)

// Store is a Postgres-backed worker.Store. One Store owns one connection
// pool; create one per worker process and Close it when the process exits.
type Store struct {
	pool *pgxpool.Pool

	// observerMu guards observer: SetEventObserver is documented as a
	// startup-time call, but the worker, the API surface and the health probe
	// share this Store, so the read is guarded rather than assumed race-free.
	observerMu sync.RWMutex
	observer   EventObserver
}

// SetEventObserver installs the append-event observer (nil clears it). Call it
// once during composition, before the worker loop and the HTTP surfaces start.
func (s *Store) SetEventObserver(fn EventObserver) {
	s.observerMu.Lock()
	s.observer = fn
	s.observerMu.Unlock()
}

// notifyEvent hands one stored event to the observer, if any. It is called
// after the INSERT has returned, so an observer panic would still lose nothing
// durable — but a panic would take the appending goroutine down with it, so the
// callback is invoked inline and is expected to be non-blocking.
func (s *Store) notifyEvent(ev execution.ExecutionEventRecord) {
	s.observerMu.RLock()
	fn := s.observer
	s.observerMu.RUnlock()
	if fn != nil {
		fn(ev)
	}
}

// The Store must satisfy the worker persistence contract at compile time.
var _ worker.Store = (*Store)(nil)

var (
	// ErrInvalidID marks a record whose id is not a uuid. The executor schema
	// keys executions by uuid (executor.executions.id); a non-uuid id is
	// refused with this named error instead of a driver parse error.
	ErrInvalidID = errors.New("repository: id is not a uuid")
	// ErrInvalidDecimal marks a money/quantity decimal string that does not
	// parse. It is refused outright: a fabricated 0 would be a silent lie
	// about someone's position.
	ErrInvalidDecimal = errors.New("repository: not a decimal string")
)

// Pool shape parity with the TypeScript runtime: store.ts pins
//
//	const PG_OPTS = { max: 8, idleTimeout: 30 };
//
// so the Go pool is capped at the same 8 connections and retires a connection
// after the same 30s idle. Matching this matters because the web tier and this
// process share one Postgres instance (DR-020): an uncapped pgxpool would let a
// slow venue pin arbitrarily many backends and starve the shared server.
const (
	// MaxConns is the connection cap (TS `max`).
	MaxConns = 8
	// MaxConnIdleTime is the idle retirement age (TS `idleTimeout`, seconds).
	MaxConnIdleTime = 30 * time.Second
)

// parsePoolConfig parses databaseURL and applies the TS-parity pool shape. It
// is separated from New so the pool settings are testable without opening a
// connection — the values, not the I/O, are the parity contract.
func parsePoolConfig(databaseURL string) (*pgxpool.Config, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("repository: parse database url: %w", err)
	}
	cfg.MaxConns = MaxConns
	cfg.MaxConnIdleTime = MaxConnIdleTime
	return cfg, nil
}

// New opens a connection pool to databaseURL (any pgxpool.ParseConfig URL),
// applies the TS-parity pool shape (MaxConns/MaxConnIdleTime, see above) and
// pings it once so a misconfigured store fails at construction, loudly,
// instead of on first write.
func New(ctx context.Context, databaseURL string) (*Store, error) {
	cfg, err := parsePoolConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("repository: open pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("repository: connect: %w", err)
	}
	return &Store{pool: pool}, nil
}

// Close releases the connection pool. Idempotent at the process level (the
// pool's own Close is safe to call once per Store).
func (s *Store) Close() { s.pool.Close() }

// Ping proves the durable store answers one trivial round trip. It is the
// dependency probe behind the executor's /readyz (objective §34: never report
// ready before the required dependencies are usable). The query is a constant,
// not a table read, so it works before the schema exists and cannot expose data.
func (s *Store) Ping(ctx context.Context) error {
	var one int
	return s.pool.QueryRow(ctx, "SELECT 1").Scan(&one)
}

// EventID formats one event id: evt_<executionID>_<seq>, where seq is the
// durable per-execution sequence value the store assigned (the
// executor.execution_events.id returned by INSERT … RETURNING id). The format
// matches the id the worker historically minted; only the sequence source
// moved — from a per-process counter to the database.
func EventID(executionID string, seq int64) string {
	return "evt_" + executionID + "_" + strconv.FormatInt(seq, 10)
}

// ParseEventSeq returns the durable sequence embedded in an event id minted by
// EventID (the digits after the last underscore). ok is false for an id this
// package could not have minted.
func ParseEventSeq(id string) (seq int64, ok bool) {
	i := strings.LastIndexByte(id, '_')
	if i < 0 || i == len(id)-1 {
		return 0, false
	}
	n, err := strconv.ParseInt(id[i+1:], 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

// EventSeq reads back the durable sequence of one appended event. The id IS
// the row: seq is stored in executor.execution_events.id, so a restarted
// process can always recover where the sequence stands from the data itself.
func (s *Store) EventSeq(ctx context.Context, eventID string) (int64, error) {
	seq, ok := ParseEventSeq(eventID)
	if !ok {
		return 0, fmt.Errorf("repository: event id %q: %w", eventID, ErrInvalidID)
	}
	var exists bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM executor.execution_events WHERE id = $1)`, seq,
	).Scan(&exists); err != nil {
		return 0, fmt.Errorf("repository: event seq: %w", err)
	}
	if !exists {
		return 0, fmt.Errorf("repository: event %q not found: %w", eventID, ErrInvalidID)
	}
	return seq, nil
}

// ---------------------------------------------------------------------------
// worker.Store
// ---------------------------------------------------------------------------

const execColumns = `id, user_id, account_id, exchange, symbol, market_type, side,
	intent, status, mode, sizing_mode, sizing_value, risk_budget, risk_basis,
	entry_definition, stop_definition, take_profit_definition, execution_strategy,
	execution_config, constraints, planned_quantity, planned_notional,
	actual_quantity, actual_notional, average_fill_price, estimated_fees,
	actual_fees, planned_risk, current_risk, strategy_state, created_at,
	started_at, completed_at, cancelled_at`

// SaveExecution implements worker.Store: one execution record upserted by id.
// risk_policy is intentionally NOT written — it is not part of
// execution.ExecutionRecord (it is written by its own lifecycle), so a save
// must never clobber it.
//
// Timestamps: the domain's zero means "not happened yet"; the schema's NULL
// means the same (started_at/completed_at/cancelled_at are nullable).
// created_at is NOT NULL and is stored as given.
func (s *Store) SaveExecution(ctx context.Context, rec execution.ExecutionRecord) error {
	args, err := execArgs(rec)
	if err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, saveExecutionSQL, args...); err != nil {
		return fmt.Errorf("repository: save execution %s: %w", rec.ID, err)
	}
	return nil
}

const saveExecutionSQL = `
INSERT INTO executor.executions (` + execColumns + `)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
	$17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31,
	$32, $33, $34)
ON CONFLICT (id) DO UPDATE SET
	user_id = EXCLUDED.user_id,
	account_id = EXCLUDED.account_id,
	exchange = EXCLUDED.exchange,
	symbol = EXCLUDED.symbol,
	market_type = EXCLUDED.market_type,
	side = EXCLUDED.side,
	intent = EXCLUDED.intent,
	status = EXCLUDED.status,
	mode = EXCLUDED.mode,
	sizing_mode = EXCLUDED.sizing_mode,
	sizing_value = EXCLUDED.sizing_value,
	risk_budget = EXCLUDED.risk_budget,
	risk_basis = EXCLUDED.risk_basis,
	entry_definition = EXCLUDED.entry_definition,
	stop_definition = EXCLUDED.stop_definition,
	take_profit_definition = EXCLUDED.take_profit_definition,
	execution_strategy = EXCLUDED.execution_strategy,
	execution_config = EXCLUDED.execution_config,
	constraints = EXCLUDED.constraints,
	planned_quantity = EXCLUDED.planned_quantity,
	planned_notional = EXCLUDED.planned_notional,
	actual_quantity = EXCLUDED.actual_quantity,
	actual_notional = EXCLUDED.actual_notional,
	average_fill_price = EXCLUDED.average_fill_price,
	estimated_fees = EXCLUDED.estimated_fees,
	actual_fees = EXCLUDED.actual_fees,
	planned_risk = EXCLUDED.planned_risk,
	current_risk = EXCLUDED.current_risk,
	strategy_state = EXCLUDED.strategy_state,
	created_at = EXCLUDED.created_at,
	started_at = EXCLUDED.started_at,
	completed_at = EXCLUDED.completed_at,
	cancelled_at = EXCLUDED.cancelled_at`

// LoadRecoverable implements worker.Store: every non-terminal execution past
// DRAFT. The status set is derived from the one lifecycle truth
// (execution.ExecutionTransitions), not duplicated in SQL.
func (s *Store) LoadRecoverable(ctx context.Context) ([]execution.ExecutionRecord, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+execColumns+`
		FROM executor.executions WHERE status = ANY($1) ORDER BY created_at, id`,
		recoverableStatuses())
	if err != nil {
		return nil, fmt.Errorf("repository: load recoverable: %w", err)
	}
	defer rows.Close()
	out := []execution.ExecutionRecord{}
	for rows.Next() {
		rec, err := scanExec(rows.Scan)
		if err != nil {
			return nil, fmt.Errorf("repository: load recoverable: %w", err)
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("repository: load recoverable: %w", err)
	}
	return out, nil
}

// recoverableStatuses lists exactly what worker.MemoryStore keeps: non-DRAFT,
// non-terminal statuses (a slice local to the call — no global state).
func recoverableStatuses() []string {
	out := []string{}
	for status, next := range execution.ExecutionTransitions {
		if len(next) == 0 || status == execution.StatusDraft {
			continue
		}
		out = append(out, string(status))
	}
	return out
}

const childColumns = `execution_id, exchange_order_id, client_order_id, symbol,
	side, type, price, quantity, filled_quantity, status, is_exit, submitted_at,
	updated_at, filled_at`

// SaveChildOrder implements worker.Store: one child row upserted by
// (execution_id, client_order_id) — the deterministic pair — so a replayed
// reconcile updates the row instead of forking one. The record's ID field is
// not the persistence key (the table's uuid PK is an internal surrogate); the
// logical row key is the pair, exactly as in worker.MemoryStore.
func (s *Store) SaveChildOrder(ctx context.Context, rec execution.ChildOrderRecord) error {
	if err := uuidErr("execution id", rec.ExecutionID); err != nil {
		return err
	}
	price, err := decPtr("price", rec.Price)
	if err != nil {
		return err
	}
	quantity, err := dec("quantity", rec.Quantity)
	if err != nil {
		return err
	}
	filled, err := dec("filled quantity", rec.FilledQuantity)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, saveChildSQL,
		rec.ExecutionID, rec.ExchangeOrderID, rec.ClientOrderID, rec.Symbol,
		string(rec.Side), rec.Type, price, quantity, filled, string(rec.Status),
		rec.IsExit, nullTime(rec.SubmittedAt), rec.UpdatedAt, nullTime(rec.FilledAt))
	if err != nil {
		return fmt.Errorf("repository: save child order %s/%s: %w", rec.ExecutionID, rec.ClientOrderID, err)
	}
	return nil
}

const saveChildSQL = `
INSERT INTO executor.child_orders (` + childColumns + `)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
ON CONFLICT (execution_id, client_order_id) DO UPDATE SET
	exchange_order_id = EXCLUDED.exchange_order_id,
	symbol = EXCLUDED.symbol,
	side = EXCLUDED.side,
	type = EXCLUDED.type,
	price = EXCLUDED.price,
	quantity = EXCLUDED.quantity,
	filled_quantity = EXCLUDED.filled_quantity,
	status = EXCLUDED.status,
	is_exit = EXCLUDED.is_exit,
	submitted_at = EXCLUDED.submitted_at,
	updated_at = EXCLUDED.updated_at,
	filled_at = EXCLUDED.filled_at`

// ListChildOrders implements worker.Store: the execution's child rows, keyed
// back by the deterministic pair (the same row key worker.MemoryStore uses).
func (s *Store) ListChildOrders(ctx context.Context, executionID string) ([]execution.ChildOrderRecord, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+childColumns+`
		FROM executor.child_orders WHERE execution_id = $1 ORDER BY client_order_id`, executionID)
	if err != nil {
		return nil, fmt.Errorf("repository: list child orders: %w", err)
	}
	defer rows.Close()
	out := []execution.ChildOrderRecord{}
	for rows.Next() {
		rec, err := scanChild(rows.Scan)
		if err != nil {
			return nil, fmt.Errorf("repository: list child orders: %w", err)
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("repository: list child orders: %w", err)
	}
	return out, nil
}

// AppendEvent implements worker.Store: one immutable event row, appended and
// never rewritten. The id is assigned here from the durable sequence the
// database itself hands out (INSERT … RETURNING id), formatted by EventID:
// evt_<executionID>_<seq>. Because that sequence lives in the database — not
// in this process — ids stay unique and per-execution monotonic across
// restarts. A caller-supplied ID is ignored: the store owns id assignment and
// returns the stored record.
func (s *Store) AppendEvent(ctx context.Context, ev execution.ExecutionEventRecord) (execution.ExecutionEventRecord, error) {
	return s.appendEvent(ctx, ev)
}

const appendEventSQL = `
INSERT INTO executor.execution_events (execution_id, name, payload, created_at)
VALUES ($1, $2, $3, $4)
RETURNING id`

// ---------------------------------------------------------------------------
// record <-> row conversion
// ---------------------------------------------------------------------------

// execArgs flattens one ExecutionRecord into the 34 column values of
// execColumns. It stops with a named error on any figure that does not parse
// — never a silent zero.
func execArgs(rec execution.ExecutionRecord) ([]any, error) {
	if err := uuidErr("execution id", rec.ID); err != nil {
		return nil, err
	}
	if err := uuidErr("account id", rec.AccountID); err != nil {
		return nil, err
	}
	entry, err := marshal("entry definition", rec.EntryDefinition)
	if err != nil {
		return nil, err
	}
	stop, err := marshalMaybe("stop definition", rec.StopDefinition != nil, rec.StopDefinition)
	if err != nil {
		return nil, err
	}
	tp := rec.TakeProfit
	if tp == nil {
		tp = []execution.TakeProfitLevel{} // NOT NULL DEFAULT '[]'
	}
	takeProfit, err := marshal("take profit definition", tp)
	if err != nil {
		return nil, err
	}
	config, err := marshal("execution config", rec.ExecutionConfig)
	if err != nil {
		return nil, err
	}
	constraints, err := marshal("constraints", rec.Constraints)
	if err != nil {
		return nil, err
	}
	var state []byte
	if rec.EngineState != nil {
		if state, err = marshal("strategy state", rec.EngineState); err != nil {
			return nil, err
		}
	}
	sizingValue, err := dec("sizing value", rec.SizingValue)
	if err != nil {
		return nil, err
	}
	riskBudget, err := decPtr("risk budget", rec.RiskBudget)
	if err != nil {
		return nil, err
	}
	plannedQty, err := dec("planned quantity", rec.PlannedQuantity)
	if err != nil {
		return nil, err
	}
	plannedNotional, err := dec("planned notional", rec.PlannedNotional)
	if err != nil {
		return nil, err
	}
	actualQty, err := dec("actual quantity", rec.ActualQuantity)
	if err != nil {
		return nil, err
	}
	actualNotional, err := dec("actual notional", rec.ActualNotional)
	if err != nil {
		return nil, err
	}
	avgFill, err := decPtr("average fill price", rec.AverageFillPrice)
	if err != nil {
		return nil, err
	}
	estFees, err := decPtr("estimated fees", rec.EstimatedFees)
	if err != nil {
		return nil, err
	}
	actualFees, err := dec("actual fees", rec.ActualFees)
	if err != nil {
		return nil, err
	}
	plannedRisk, err := decPtr("planned risk", rec.PlannedRisk)
	if err != nil {
		return nil, err
	}
	currentRisk, err := decPtr("current risk", rec.CurrentRisk)
	if err != nil {
		return nil, err
	}
	var riskBasis *string
	if rec.RiskBasis != nil {
		s := string(*rec.RiskBasis)
		riskBasis = &s
	}
	return []any{
		rec.ID, rec.UserID, rec.AccountID, string(rec.Exchange), rec.Symbol,
		string(rec.MarketType), string(rec.Side), string(rec.Intent),
		string(rec.Status), string(rec.Mode), string(rec.SizingMode),
		sizingValue, riskBudget, riskBasis, entry, stop, takeProfit,
		string(rec.ExecutionStrategy), config, constraints,
		plannedQty, plannedNotional, actualQty, actualNotional,
		avgFill, estFees, actualFees, plannedRisk, currentRisk, state,
		rec.CreatedAt, nullTime(rec.StartedAt), nullTime(rec.CompletedAt),
		nullTime(rec.CancelledAt),
	}, nil
}

// scanExec reads one execColumns row back into the domain record. JSON columns
// round-trip through encoding/json (the schema's jsonb is JSON); numeric
// figures come back as decimal strings via shortest round-trip formatting.
func scanExec(scan func(dest ...any) error) (execution.ExecutionRecord, error) {
	var (
		rec                                 execution.ExecutionRecord
		exchange, marketType, side, intent  string
		status, mode, sizingMode, strategy  string
		sizingValue, actualFees             float64
		plannedQty, plannedNotional         float64
		actualQty, actualNotional           float64
		riskBudget, avgFill, estFees        *float64
		plannedRisk, currentRisk            *float64
		riskBasis                           *string
		entry, config, constraints          []byte
		stop, takeProfit, state             []byte
		startedAt, completedAt, cancelledAt *int64
	)
	if err := scan(
		&rec.ID, &rec.UserID, &rec.AccountID, &exchange, &rec.Symbol,
		&marketType, &side, &intent, &status, &mode, &sizingMode,
		&sizingValue, &riskBudget, &riskBasis, &entry, &stop, &takeProfit,
		&strategy, &config, &constraints, &plannedQty, &plannedNotional,
		&actualQty, &actualNotional, &avgFill, &estFees, &actualFees,
		&plannedRisk, &currentRisk, &state, &rec.CreatedAt,
		&startedAt, &completedAt, &cancelledAt,
	); err != nil {
		return execution.ExecutionRecord{}, err
	}
	rec.Exchange = execution.ExchangeID(exchange)
	rec.MarketType = execution.MarketType(marketType)
	rec.Side = execution.Side(side)
	rec.Intent = execution.Intent(intent)
	rec.Status = execution.ExecutionStatus(status)
	rec.Mode = execution.ExecutionMode(mode)
	rec.SizingMode = execution.SizingMode(sizingMode)
	rec.ExecutionStrategy = execution.ExecutionStrategy(strategy)
	if err := json.Unmarshal(entry, &rec.EntryDefinition); err != nil {
		return execution.ExecutionRecord{}, fmt.Errorf("entry definition: %w", err)
	}
	if len(stop) > 0 {
		rec.StopDefinition = &execution.PriceDefinition{}
		if err := json.Unmarshal(stop, rec.StopDefinition); err != nil {
			return execution.ExecutionRecord{}, fmt.Errorf("stop definition: %w", err)
		}
	}
	if err := json.Unmarshal(takeProfit, &rec.TakeProfit); err != nil {
		return execution.ExecutionRecord{}, fmt.Errorf("take profit definition: %w", err)
	}
	if err := json.Unmarshal(config, &rec.ExecutionConfig); err != nil {
		return execution.ExecutionRecord{}, fmt.Errorf("execution config: %w", err)
	}
	if err := json.Unmarshal(constraints, &rec.Constraints); err != nil {
		return execution.ExecutionRecord{}, fmt.Errorf("constraints: %w", err)
	}
	if len(state) > 0 {
		if err := json.Unmarshal(state, &rec.EngineState); err != nil {
			return execution.ExecutionRecord{}, fmt.Errorf("strategy state: %w", err)
		}
	}
	if riskBasis != nil {
		b := execution.BalanceBasis(*riskBasis)
		rec.RiskBasis = &b
	}
	var err error
	if rec.SizingValue, err = outDec(sizingValue); err != nil {
		return execution.ExecutionRecord{}, err
	}
	if rec.RiskBudget, err = outDecPtr(riskBudget); err != nil {
		return execution.ExecutionRecord{}, err
	}
	if rec.PlannedQuantity, err = outDec(plannedQty); err != nil {
		return execution.ExecutionRecord{}, err
	}
	if rec.PlannedNotional, err = outDec(plannedNotional); err != nil {
		return execution.ExecutionRecord{}, err
	}
	if rec.ActualQuantity, err = outDec(actualQty); err != nil {
		return execution.ExecutionRecord{}, err
	}
	if rec.ActualNotional, err = outDec(actualNotional); err != nil {
		return execution.ExecutionRecord{}, err
	}
	if rec.AverageFillPrice, err = outDecPtr(avgFill); err != nil {
		return execution.ExecutionRecord{}, err
	}
	if rec.EstimatedFees, err = outDecPtr(estFees); err != nil {
		return execution.ExecutionRecord{}, err
	}
	if rec.ActualFees, err = outDec(actualFees); err != nil {
		return execution.ExecutionRecord{}, err
	}
	if rec.PlannedRisk, err = outDecPtr(plannedRisk); err != nil {
		return execution.ExecutionRecord{}, err
	}
	if rec.CurrentRisk, err = outDecPtr(currentRisk); err != nil {
		return execution.ExecutionRecord{}, err
	}
	rec.StartedAt = orZero(startedAt)
	rec.CompletedAt = orZero(completedAt)
	rec.CancelledAt = orZero(cancelledAt)
	return rec, nil
}

// scanChild reads one childColumns row back into the domain record. The row
// key is the deterministic pair, so ID is rebuilt as the same key
// worker.MemoryStore would hand out.
func scanChild(scan func(dest ...any) error) (execution.ChildOrderRecord, error) {
	var (
		rec                   execution.ChildOrderRecord
		side, status, typ     string
		price                 *float64
		quantity, filled      float64
		submittedAt, filledAt *int64
	)
	if err := scan(
		&rec.ExecutionID, &rec.ExchangeOrderID, &rec.ClientOrderID, &rec.Symbol,
		&side, &typ, &price, &quantity, &filled, &status, &rec.IsExit,
		&submittedAt, &rec.UpdatedAt, &filledAt,
	); err != nil {
		return execution.ChildOrderRecord{}, err
	}
	rec.ID = childRowKey(rec.ExecutionID, rec.ClientOrderID)
	rec.Side = execution.Side(side)
	rec.Type = typ
	rec.Status = execution.ChildOrderStatus(status)
	var err error
	if rec.Price, err = outDecPtr(price); err != nil {
		return execution.ChildOrderRecord{}, err
	}
	if rec.Quantity, err = outDec(quantity); err != nil {
		return execution.ChildOrderRecord{}, err
	}
	if rec.FilledQuantity, err = outDec(filled); err != nil {
		return execution.ChildOrderRecord{}, err
	}
	rec.SubmittedAt = orZero(submittedAt)
	rec.FilledAt = orZero(filledAt)
	return rec, nil
}

// childRowKey is the store row key for one child: the deterministic
// (execution, client order id) pair, in the same shape worker.childRowID uses.
func childRowKey(executionID, clientOrderID string) string {
	return executionID + ":" + clientOrderID
}

// ---------------------------------------------------------------------------
// boundary conversions
// ---------------------------------------------------------------------------

// dec parses one non-nullable decimal string into the schema's double.
func dec(field, s string) (float64, error) {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0, fmt.Errorf("repository: %s %q: %w", field, s, ErrInvalidDecimal)
	}
	return f, nil
}

// decPtr parses a nullable decimal: nil stays nil (honest absence), and an
// empty-but-present string is refused rather than read as a silent 0.
func decPtr(field string, s *string) (*float64, error) {
	if s == nil {
		return nil, nil
	}
	f, err := dec(field, *s)
	if err != nil {
		return nil, err
	}
	return &f, nil
}

// outDec renders a stored double back to the domain's decimal string with the
// shortest representation that round-trips exactly.
func outDec(f float64) (string, error) {
	return strconv.FormatFloat(f, 'f', -1, 64), nil
}

// outDecPtr renders a nullable double: NULL stays an honest nil pointer.
func outDecPtr(f *float64) (*string, error) {
	if f == nil {
		return nil, nil
	}
	s, err := outDec(*f)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// nullTime maps the domain's "0 = not happened yet" onto the schema's NULL.
func nullTime(ms int64) *int64 {
	if ms == 0 {
		return nil
	}
	return &ms
}

// orZero maps a NULL timestamp back onto the domain's zero.
func orZero(ms *int64) int64 {
	if ms == nil {
		return 0
	}
	return *ms
}

// marshal JSON-encodes one non-nullable jsonb value.
func marshal(field string, v any) ([]byte, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("repository: %s: %w", field, err)
	}
	return b, nil
}

// marshalMaybe JSON-encodes a nullable jsonb value given an explicit presence
// flag (a typed nil pointer inside any is NOT nil — presence must be checked at
// the call site, never by interface equality). present=false stays NULL.
func marshalMaybe(field string, present bool, v any) ([]byte, error) {
	if !present {
		return nil, nil
	}
	return marshal(field, v)
}

// uuidErr refuses a non-uuid key with a named error before the driver turns it
// into a parse failure deep in a statement.
func uuidErr(field, id string) error {
	if !isUUID(id) {
		return fmt.Errorf("repository: %s %q: %w", field, id, ErrInvalidID)
	}
	return nil
}

// isUUID reports the canonical 8-4-4-4-12 hex uuid shape the schema keys on.
func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !('0' <= c && c <= '9') && !('a' <= c && c <= 'f') && !('A' <= c && c <= 'F') {
				return false
			}
		}
	}
	return true
}

// appendEvent is the shared append used by both the worker.Store method and the
// executor API port; the id is assigned by the durable database sequence.
func (s *Store) appendEvent(ctx context.Context, ev execution.ExecutionEventRecord) (execution.ExecutionEventRecord, error) {
	if err := uuidErr("execution id", ev.ExecutionID); err != nil {
		return execution.ExecutionEventRecord{}, err
	}
	payload, err := json.Marshal(ev.Payload)
	if err != nil {
		return execution.ExecutionEventRecord{}, fmt.Errorf("repository: append event payload: %w", err)
	}
	if ev.Payload == nil {
		payload = []byte("{}") // the column is NOT NULL DEFAULT '{}' (PRD §63)
	}
	var seq int64
	if err := s.pool.QueryRow(ctx, appendEventSQL,
		ev.ExecutionID, string(ev.Name), payload, ev.CreatedAt).Scan(&seq); err != nil {
		return execution.ExecutionEventRecord{}, fmt.Errorf("repository: append event: %w", err)
	}
	ev.ID = EventID(ev.ExecutionID, seq)
	// The INSERT has returned, so the row is durable: only now is the observer
	// consulted. An observer therefore can never see an event that was not
	// stored, and its failure can never roll one back.
	s.notifyEvent(ev)
	return ev, nil
}

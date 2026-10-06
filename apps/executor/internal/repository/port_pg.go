package repository

// The Postgres implementation of the executor API's persistence port
// (port.go). Every statement mirrors the corresponding one in
// the retired TS executor store so the two writers agree on the
// `executor.*` schema (DR-020) while both exist. Ownership is enforced in SQL
// wherever it belongs (PRD §108): `user_id = $1 AND id = $2` for credential and
// execution reads, so a handler bug cannot cross users.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/core/execution"
	"github.com/jackc/pgx/v5"
)

// The Store must satisfy the executor API port at compile time.
var _ ExecutorStore = (*Store)(nil)

// --- credentials -----------------------------------------------------------

const accountColumns = `id::text, user_id, exchange, label, api_key_masked,
	permissions, health, created_at, updated_at, last_used_at, revoked_at`

// ListCredentials returns the user's accounts, newest first (SQL_STATEMENTS
// .listCredentials: ORDER BY created_at DESC, id).
func (s *Store) ListCredentials(ctx context.Context, userID string) ([]CredentialRecord, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+accountColumns+`
		FROM executor.exchange_accounts WHERE user_id = $1 ORDER BY created_at DESC, id`, userID)
	if err != nil {
		return nil, fmt.Errorf("repository: list credentials: %w", err)
	}
	defer rows.Close()
	out := []CredentialRecord{}
	for rows.Next() {
		rec, err := scanAccount(rows.Scan)
		if err != nil {
			return nil, fmt.Errorf("repository: list credentials: %w", err)
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("repository: list credentials: %w", err)
	}
	return out, nil
}

// GetCredential reads one account scoped by user id. A missing row is
// (nil, nil) — the caller answers 404, never a 403 that would leak existence.
func (s *Store) GetCredential(ctx context.Context, userID, id string) (*CredentialRecord, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+accountColumns+`
		FROM executor.exchange_accounts WHERE user_id = $1 AND id = $2`, userID, id)
	rec, err := scanAccount(row.Scan)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("repository: get credential %s: %w", id, err)
	}
	return &rec, nil
}

// CreateCredential inserts one sealed account row. The health starts ACTIVE
// (the caller has already probed the venue), last_used_at/revoked_at NULL — the
// exact literal the TS createCredential writes.
func (s *Store) CreateCredential(ctx context.Context, in CredentialInput) (CredentialRecord, error) {
	perms, err := json.Marshal(in.Permissions)
	if err != nil {
		return CredentialRecord{}, fmt.Errorf("repository: credential permissions: %w", err)
	}
	var passphrase any
	if len(in.Envelope.Passphrase) > 0 {
		passphrase = in.Envelope.Passphrase
	}
	row := s.pool.QueryRow(ctx, `
		INSERT INTO executor.exchange_accounts (user_id, exchange, label, api_key_masked,
			api_key_encrypted, api_secret_encrypted, passphrase_encrypted, iv, auth_tag,
			permissions, health, created_at, updated_at, last_used_at, revoked_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ACTIVE', $11, $11, NULL, NULL)
		RETURNING `+accountColumns,
		in.UserID, string(in.Exchange), in.Label, in.APIKeyMasked,
		in.Envelope.APIKey, in.Envelope.APISecret, passphrase, in.Envelope.IV, in.Envelope.AuthTag,
		perms, in.At)
	rec, err := scanAccount(row.Scan)
	if err != nil {
		return CredentialRecord{}, fmt.Errorf("repository: create credential: %w", err)
	}
	return rec, nil
}

// RevokeCredential marks the row revoked at `at` (health REVOKED) and returns
// the updated record. A missing/wrong-owner row is (nil, nil).
func (s *Store) RevokeCredential(ctx context.Context, userID, id string, at int64) (*CredentialRecord, error) {
	row := s.pool.QueryRow(ctx, `
		UPDATE executor.exchange_accounts
		   SET revoked_at = $3, updated_at = $3, health = 'REVOKED'
		 WHERE user_id = $1 AND id = $2
		RETURNING `+accountColumns, userID, id, at)
	rec, err := scanAccount(row.Scan)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("repository: revoke credential %s: %w", id, err)
	}
	return &rec, nil
}

// UpdateCredentialHealth sets the health verdict and bumps updated_at.
func (s *Store) UpdateCredentialHealth(ctx context.Context, userID, id string, health execution.CredentialHealth, at int64) error {
	if _, err := s.pool.Exec(ctx, `
		UPDATE executor.exchange_accounts SET health = $3, updated_at = $4
		 WHERE user_id = $1 AND id = $2`, userID, id, string(health), at); err != nil {
		return fmt.Errorf("repository: update credential health %s: %w", id, err)
	}
	return nil
}

// TouchCredential records last_used_at (and updated_at) without touching any
// sealed column — the TS touchCredential statement.
func (s *Store) TouchCredential(ctx context.Context, userID, id string, at int64) error {
	if _, err := s.pool.Exec(ctx, `
		UPDATE executor.exchange_accounts SET last_used_at = $3, updated_at = $3
		 WHERE user_id = $1 AND id = $2`, userID, id, at); err != nil {
		return fmt.Errorf("repository: touch credential %s: %w", id, err)
	}
	return nil
}

func scanAccount(scan func(dest ...any) error) (CredentialRecord, error) {
	var (
		rec                   CredentialRecord
		exchange, health      string
		perms                 []byte
		lastUsedAt, revokedAt *int64
	)
	if err := scan(&rec.ID, &rec.UserID, &exchange, &rec.Label, &rec.APIKeyMasked,
		&perms, &health, &rec.CreatedAt, &rec.UpdatedAt, &lastUsedAt, &revokedAt); err != nil {
		return CredentialRecord{}, err
	}
	rec.Exchange = execution.ExchangeID(exchange)
	rec.Health = execution.CredentialHealth(health)
	if len(perms) > 0 {
		if err := json.Unmarshal(perms, &rec.Permissions); err != nil {
			return CredentialRecord{}, fmt.Errorf("credential permissions: %w", err)
		}
	}
	rec.LastUsedAt = lastUsedAt
	rec.RevokedAt = revokedAt
	return rec, nil
}

// --- executions ------------------------------------------------------------

// GetExecution reads one execution scoped by user id (SQL_STATEMENTS
// .getExecution). Missing/wrong owner is (nil, nil).
func (s *Store) GetExecution(ctx context.Context, userID, id string) (*execution.ExecutionRecord, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+execColumns+`
		FROM executor.executions WHERE user_id = $1 AND id = $2`, userID, id)
	rec, err := scanExec(row.Scan)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("repository: get execution %s: %w", id, err)
	}
	return &rec, nil
}

// ListExecutions returns the user's execution history newest first, optionally
// filtered by status (SQL_STATEMENTS listExecutions / listExecutionsByStatus:
// ORDER BY created_at DESC, id DESC LIMIT n).
func (s *Store) ListExecutions(ctx context.Context, userID string, status *execution.ExecutionStatus, limit int) ([]execution.ExecutionRecord, error) {
	if limit < 1 {
		limit = 1
	}
	var (
		rows pgx.Rows
		err  error
	)
	if status == nil {
		rows, err = s.pool.Query(ctx, `SELECT `+execColumns+`
			FROM executor.executions WHERE user_id = $1
			ORDER BY created_at DESC, id DESC LIMIT $2`, userID, limit)
	} else {
		rows, err = s.pool.Query(ctx, `SELECT `+execColumns+`
			FROM executor.executions WHERE user_id = $1 AND status = $2
			ORDER BY created_at DESC, id DESC LIMIT $3`, userID, string(*status), limit)
	}
	if err != nil {
		return nil, fmt.Errorf("repository: list executions: %w", err)
	}
	defer rows.Close()
	out := []execution.ExecutionRecord{}
	for rows.Next() {
		rec, err := scanExec(rows.Scan)
		if err != nil {
			return nil, fmt.Errorf("repository: list executions: %w", err)
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("repository: list executions: %w", err)
	}
	return out, nil
}

// ListRunningExecutions scans every execution the emergency stop must consider
// (SQL_STATEMENTS.listRunningExecutions). Deliberately NOT user-scoped: the
// caller filters by owner (PRD §75), exactly as the TS emergencyStop does.
func (s *Store) ListRunningExecutions(ctx context.Context) ([]execution.ExecutionRecord, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+execColumns+`
		FROM executor.executions WHERE status IN ('RUNNING', 'PARTIALLY_FILLED', 'RECONCILING')
		ORDER BY created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("repository: list running executions: %w", err)
	}
	defer rows.Close()
	out := []execution.ExecutionRecord{}
	for rows.Next() {
		rec, err := scanExec(rows.Scan)
		if err != nil {
			return nil, fmt.Errorf("repository: list running executions: %w", err)
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("repository: list running executions: %w", err)
	}
	return out, nil
}

// CreateExecution inserts the execution row + its immutable plan snapshot in
// ONE transaction (PRD §56/§99/§63), exactly as store.ts createExecution does.
// created_at is stamped here; started/completed/cancelled are NULL.
func (s *Store) CreateExecution(ctx context.Context, rec execution.ExecutionRecord, plan json.RawMessage) (execution.ExecutionRecord, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return execution.ExecutionRecord{}, fmt.Errorf("repository: create execution: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	at := rec.CreatedAt
	if at == 0 {
		at = time.Now().UnixMilli()
	}
	args, err := createExecArgs(rec, at)
	if err != nil {
		return execution.ExecutionRecord{}, err
	}
	row := tx.QueryRow(ctx, `
		INSERT INTO executor.executions (user_id, account_id, exchange, symbol, market_type, side,
			intent, status, mode, sizing_mode, sizing_value, risk_budget, risk_basis,
			entry_definition, stop_definition, take_profit_definition, execution_strategy,
			execution_config, constraints, planned_quantity, planned_notional, actual_quantity,
			actual_notional, average_fill_price, estimated_fees, actual_fees, planned_risk,
			current_risk, risk_policy, strategy_state, created_at, started_at, completed_at, cancelled_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
			$19, $20, $21, $22, $23, $24, $25, $26, $27, $28, NULL, NULL, $29, NULL, NULL, NULL)
		RETURNING `+execColumns, args...)
	created, err := scanExec(row.Scan)
	if err != nil {
		return execution.ExecutionRecord{}, fmt.Errorf("repository: create execution: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO executor.execution_plans (execution_id, plan, created_at)
		VALUES ($1, $2, $3)`, created.ID, plan, at); err != nil {
		return execution.ExecutionRecord{}, fmt.Errorf("repository: create execution plan: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO executor.execution_events (execution_id, name, payload, created_at)
		VALUES ($1, 'EXECUTION_CREATED', '{}'::jsonb, $2), ($1, 'PLAN_CREATED', '{}'::jsonb, $2)`, created.ID, at); err != nil {
		return execution.ExecutionRecord{}, fmt.Errorf("repository: create execution events: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return execution.ExecutionRecord{}, fmt.Errorf("repository: create execution commit: %w", err)
	}
	return created, nil
}

// createExecArgs flattens the create-time columns (through current_risk) plus
// created_at. The create path does NOT carry strategy state (assigned after the
// id exists) or risk_policy (not a frozen contract field), so both are NULL.
// A figure that does not parse is a named refusal, never a silent NULL.
func createExecArgs(rec execution.ExecutionRecord, at int64) ([]any, error) {
	var riskBasis *string
	if rec.RiskBasis != nil {
		s := string(*rec.RiskBasis)
		riskBasis = &s
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
	entry, err := marshal("entry definition", rec.EntryDefinition)
	if err != nil {
		return nil, err
	}
	stop, err := marshalMaybe("stop definition", rec.StopDefinition != nil, rec.StopDefinition)
	if err != nil {
		return nil, err
	}
	takeProfit, err := marshal("take profit definition", takeProfitOrEmpty(rec.TakeProfit))
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
	return []any{
		rec.UserID, rec.AccountID, string(rec.Exchange), rec.Symbol,
		string(rec.MarketType), string(rec.Side), string(rec.Intent),
		string(rec.Status), string(rec.Mode), string(rec.SizingMode),
		sizingValue, riskBudget, riskBasis,
		entry, stop, takeProfit, string(rec.ExecutionStrategy),
		config, constraints,
		plannedQty, plannedNotional, actualQty, actualNotional,
		avgFill, estFees, actualFees, plannedRisk, currentRisk, at,
	}, nil
}

func takeProfitOrEmpty(tp []execution.TakeProfitLevel) []execution.TakeProfitLevel {
	if tp == nil {
		return []execution.TakeProfitLevel{}
	}
	return tp
}

// UpdateExecutionStatus moves the status and derives the lifecycle timestamps
// exactly as store.ts updateExecutionStatus does (started_at on RUNNING;
// completed_at on terminal; cancelled_at on CANCELLED). Columns outside the SET
// list are never wiped by a status change.
func (s *Store) UpdateExecutionStatus(ctx context.Context, id string, status execution.ExecutionStatus, at int64) error {
	if _, err := s.pool.Exec(ctx, `
		UPDATE executor.executions SET
			status = $2,
			started_at = COALESCE(started_at, CASE WHEN $2 = 'RUNNING' THEN $3 END),
			completed_at = CASE WHEN $2 IN ('FILLED','FAILED','CANCELLED','RISK_STOPPED','EXPIRED','STOPPED')
				THEN COALESCE(completed_at, $3) ELSE completed_at END,
			cancelled_at = CASE WHEN $2 = 'CANCELLED' THEN COALESCE(cancelled_at, $3) ELSE cancelled_at END
		 WHERE id = $1`, id, string(status), at); err != nil {
		return fmt.Errorf("repository: update execution status %s: %w", id, err)
	}
	return nil
}

// UpdateExecutionStrategyState writes the opaque engine state (review §130).
func (s *Store) UpdateExecutionStrategyState(ctx context.Context, id string, state any) error {
	var payload any
	if state != nil {
		b, err := json.Marshal(state)
		if err != nil {
			return fmt.Errorf("repository: strategy state %s: %w", id, err)
		}
		payload = b
	}
	if _, err := s.pool.Exec(ctx, `UPDATE executor.executions SET strategy_state = $2 WHERE id = $1`, id, payload); err != nil {
		return fmt.Errorf("repository: update strategy state %s: %w", id, err)
	}
	return nil
}

// GetExecutionPlan returns the immutable creation-time plan JSON, or
// (nil, false, nil) when no plan row exists — never a fabricated plan.
func (s *Store) GetExecutionPlan(ctx context.Context, executionID string) (json.RawMessage, bool, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT plan FROM executor.execution_plans WHERE execution_id = $1`, executionID).Scan(&raw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("repository: get execution plan %s: %w", executionID, err)
	}
	return json.RawMessage(raw), true, nil
}

// --- child orders, fills, events -------------------------------------------

// UpdateChildOrderStatus updates one child by the deterministic row key
// (execution_id, client_order_id) — the emergency-stop cancel path.
func (s *Store) UpdateChildOrderStatus(ctx context.Context, executionID, clientOrderID string, status execution.ChildOrderStatus, at int64) error {
	if _, err := s.pool.Exec(ctx, `
		UPDATE executor.child_orders SET status = $3, updated_at = $4
		 WHERE execution_id = $1 AND client_order_id = $2`, executionID, clientOrderID, string(status), at); err != nil {
		return fmt.Errorf("repository: update child %s/%s: %w", executionID, clientOrderID, err)
	}
	return nil
}

// ListFills returns the execution's deduped fills, oldest first
// (SQL_STATEMENTS.listFills: ORDER BY timestamp, id).
func (s *Store) ListFills(ctx context.Context, executionID string) ([]execution.FillRecord, error) {
	rows, err := s.pool.Query(ctx, `SELECT id::text, execution_id, child_order_id::text,
		exchange_trade_id, price, quantity, quote_quantity, fee, fee_asset, timestamp
		FROM executor.fills WHERE execution_id = $1 ORDER BY timestamp, id`, executionID)
	if err != nil {
		return nil, fmt.Errorf("repository: list fills: %w", err)
	}
	defer rows.Close()
	out := []execution.FillRecord{}
	for rows.Next() {
		rec, err := scanFill(rows.Scan)
		if err != nil {
			return nil, fmt.Errorf("repository: list fills: %w", err)
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("repository: list fills: %w", err)
	}
	return out, nil
}

func scanFill(scan func(dest ...any) error) (execution.FillRecord, error) {
	var (
		rec                    execution.FillRecord
		childOrderID           *string
		price, quantity, quote float64
		fee                    float64
	)
	if err := scan(&rec.ID, &rec.ExecutionID, &childOrderID, &rec.ExchangeTradeID,
		&price, &quantity, &quote, &fee, &rec.FeeAsset, &rec.Timestamp); err != nil {
		return execution.FillRecord{}, err
	}
	if childOrderID != nil {
		rec.ChildOrderID = *childOrderID
	}
	var err error
	if rec.Price, err = outDec(price); err != nil {
		return execution.FillRecord{}, err
	}
	if rec.Quantity, err = outDec(quantity); err != nil {
		return execution.FillRecord{}, err
	}
	if rec.QuoteQuantity, err = outDec(quote); err != nil {
		return execution.FillRecord{}, err
	}
	if rec.Fee, err = outDec(fee); err != nil {
		return execution.FillRecord{}, err
	}
	return rec, nil
}

// ListEvents returns the append-only event log, oldest first (ORDER BY id).
func (s *Store) ListEvents(ctx context.Context, executionID string) ([]execution.ExecutionEventRecord, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, execution_id, name, payload, created_at
		FROM executor.execution_events WHERE execution_id = $1 ORDER BY id`, executionID)
	if err != nil {
		return nil, fmt.Errorf("repository: list events: %w", err)
	}
	defer rows.Close()
	out := []execution.ExecutionEventRecord{}
	for rows.Next() {
		var (
			rec     execution.ExecutionEventRecord
			seq     int64
			name    string
			payload []byte
		)
		if err := rows.Scan(&seq, &rec.ExecutionID, &name, &payload, &rec.CreatedAt); err != nil {
			return nil, fmt.Errorf("repository: list events: %w", err)
		}
		rec.ID = EventID(rec.ExecutionID, seq)
		rec.Name = execution.ExecutionEventName(name)
		if len(payload) > 0 {
			if err := json.Unmarshal(payload, &rec.Payload); err != nil {
				return nil, fmt.Errorf("repository: list events payload: %w", err)
			}
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("repository: list events: %w", err)
	}
	return out, nil
}

// --- risk profile ----------------------------------------------------------

// GetRiskProfile reads the stored profile; a user with no row gets the zero
// value, and the API layer fills the defaults (DEFAULT_RISK_PROFILE) exactly as
// the TS getRiskProfile path does.
func (s *Store) GetRiskProfile(ctx context.Context, userID string) (execution.RiskProfile, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT profile FROM executor.risk_profiles WHERE user_id = $1`, userID).Scan(&raw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return execution.RiskProfile{}, nil
		}
		return execution.RiskProfile{}, fmt.Errorf("repository: get risk profile %s: %w", userID, err)
	}
	var profile execution.RiskProfile
	if err := json.Unmarshal(raw, &profile); err != nil {
		return execution.RiskProfile{}, fmt.Errorf("repository: risk profile payload %s: %w", userID, err)
	}
	return profile, nil
}

// PutRiskProfile upserts the profile and returns what was stored
// (SQL_STATEMENTS.putRiskProfile … RETURNING profile).
func (s *Store) PutRiskProfile(ctx context.Context, userID string, profile execution.RiskProfile, at int64) (execution.RiskProfile, error) {
	raw, err := json.Marshal(profile)
	if err != nil {
		return execution.RiskProfile{}, fmt.Errorf("repository: risk profile marshal: %w", err)
	}
	var stored []byte
	if err := s.pool.QueryRow(ctx, `
		INSERT INTO executor.risk_profiles (user_id, profile, updated_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id) DO UPDATE SET profile = EXCLUDED.profile, updated_at = EXCLUDED.updated_at
		RETURNING profile`, userID, raw, at).Scan(&stored); err != nil {
		return execution.RiskProfile{}, fmt.Errorf("repository: put risk profile %s: %w", userID, err)
	}
	var out execution.RiskProfile
	if err := json.Unmarshal(stored, &out); err != nil {
		return execution.RiskProfile{}, fmt.Errorf("repository: risk profile payload %s: %w", userID, err)
	}
	return out, nil
}

// --- audit -----------------------------------------------------------------

// Audit appends one audit_logs row (PRD §87). Payload defaults to '{}'.
func (s *Store) Audit(ctx context.Context, entry AuditEntry) error {
	payload, err := json.Marshal(entry.Payload)
	if err != nil {
		return fmt.Errorf("repository: audit payload: %w", err)
	}
	if entry.Payload == nil {
		payload = []byte("{}")
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO executor.audit_logs (user_id, action, target, payload, created_at)
		VALUES ($1, $2, $3, $4, $5)`, entry.UserID, entry.Action, entry.Target, payload, entry.At); err != nil {
		return fmt.Errorf("repository: audit %s: %w", entry.Action, err)
	}
	return nil
}

// --- portfolio rollup ------------------------------------------------------

// summarizePortfolioRiskSQL is the TS SQL_STATEMENTS.summarizePortfolioRisk
// statement: ONE round trip returns the open-risk sum and the day's realized
// P&L, so the two gates read one consistent snapshot instead of two queries
// that could straddle a concurrent fill.
const summarizePortfolioRiskSQL = `
SELECT
  COALESCE((SELECT SUM(COALESCE(e.current_risk, e.planned_risk))
    FROM executor.executions e
    WHERE e.user_id = $1 AND e.status IN ('READY', 'RUNNING', 'PARTIALLY_FILLED', 'PAUSED', 'RECONCILING')), 0) AS open_risk,
  COALESCE((SELECT SUM(g.exit_value - g.exit_qty * e3.average_fill_price - g.fees)
    FROM executor.executions e3
    JOIN (
      SELECT c.execution_id,
        SUM(CASE WHEN c.is_exit THEN f.quantity ELSE 0 END) AS exit_qty,
        SUM(CASE WHEN c.is_exit THEN f.price * f.quantity ELSE 0 END) AS exit_value,
        SUM(f.fee) AS fees
      FROM executor.fills f
      JOIN executor.child_orders c ON c.id = f.child_order_id
      GROUP BY c.execution_id
    ) g ON g.execution_id = e3.id
    WHERE e3.user_id = $1 AND e3.completed_at IS NOT NULL AND e3.completed_at >= $2
      AND e3.average_fill_price IS NOT NULL), 0) AS realized_pnl`

// SummarizePortfolioRisk implements the port. Both figures come back as double
// precision (the schema's money type) and are rendered as decimal strings.
func (s *Store) SummarizePortfolioRisk(ctx context.Context, userID string, sinceMs int64) (string, string, error) {
	var openRisk, realized float64
	if err := s.pool.QueryRow(ctx, summarizePortfolioRiskSQL, userID, sinceMs).Scan(&openRisk, &realized); err != nil {
		return "", "", fmt.Errorf("repository: summarize portfolio risk %s: %w", userID, err)
	}
	open, err := outDec(openRisk)
	if err != nil {
		return "", "", err
	}
	realizedStr, err := outDec(realized)
	if err != nil {
		return "", "", err
	}
	return open, realizedStr, nil
}

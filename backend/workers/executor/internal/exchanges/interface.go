// Package exchanges is the venue boundary (objective §8.16): core executor code
// uses these canonical interfaces and the venue differences — symbols,
// precision, statuses, order types, API errors — are absorbed by the adapters
// (binance/, bybit/, mexc/, paper/) and never leak into strategy or risk logic.
//
// No `if exchange == "binance"` outside this package (objective §8.16).
package exchanges

import (
	"context"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
)

// Exchange is the canonical venue interface (objective §8.16). Implementations:
// paper (deterministic simulation for tests), binance, bybit, mexc.
type Exchange interface {
	// GetAccount returns the venue account metadata + credential health.
	GetAccount(ctx context.Context) (execution.AccountMetadata, error)
	// GetBalance returns the account equity snapshot (honest nulls per basis).
	GetBalance(ctx context.Context) (execution.AccountEquity, error)
	// GetPosition returns the position on symbol (empty Position + no error when
	// flat is NOT used: flat returns ErrNoPosition so callers cannot mistake a
	// failed fetch for flat — adapters normalize that contract).
	GetPosition(ctx context.Context, symbol string) (execution.Position, error)
	// GetTicker returns the current ticker (bid/ask may be null — honest).
	GetTicker(ctx context.Context, symbol string) (execution.Ticker, error)
	// CreateOrder places one order idempotently by ClientOrderID: resubmitting
	// the same id MUST NOT create a second venue order (objective §23).
	CreateOrder(ctx context.Context, req execution.OrderRequest) (execution.NormalizedOrder, error)
	// CancelOrder cancels by venue order id.
	CancelOrder(ctx context.Context, symbol, exchangeOrderID string) (execution.NormalizedOrder, error)
	// GetOrder fetches one order by venue order id.
	GetOrder(ctx context.Context, symbol, exchangeOrderID string) (execution.NormalizedOrder, error)
	// GetOpenOrders lists the account's open orders on symbol.
	GetOpenOrders(ctx context.Context, symbol string) ([]execution.NormalizedOrder, error)
	// GetFills lists recent fills on symbol (adapters dedup nothing; the fill
	// store dedups by (account, exchangeTradeId)).
	GetFills(ctx context.Context, symbol string) ([]execution.Fill, error)
}

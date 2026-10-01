// Package exchange is the venue boundary (objective §8.16): core executor code
// uses these canonical interfaces and the venue differences — symbols,
// precision, statuses, order types, API errors — are absorbed by the adapters
// (binance/, bybit/, mexc/, paper/) and never leak into strategy or risk logic.
//
// No `if exchange == "binance"` outside this package (objective §8.16).
package exchange

import (
	"context"

	"github.com/anvxxr-arch/fudcourt/services/executor/internal/executor"
)

// Exchange is the canonical venue interface (objective §8.16). Implementations:
// paper (deterministic simulation for tests), binance, bybit, mexc.
type Exchange interface {
	// GetAccount returns the venue account metadata + credential health.
	GetAccount(ctx context.Context) (executor.AccountMetadata, error)
	// GetBalance returns the account equity snapshot (honest nulls per basis).
	GetBalance(ctx context.Context) (executor.AccountEquity, error)
	// GetPosition returns the position on symbol (empty Position + no error when
	// flat is NOT used: flat returns ErrNoPosition so callers cannot mistake a
	// failed fetch for flat — adapters normalize that contract).
	GetPosition(ctx context.Context, symbol string) (executor.Position, error)
	// GetTicker returns the current ticker (bid/ask may be null — honest).
	GetTicker(ctx context.Context, symbol string) (executor.Ticker, error)
	// CreateOrder places one order idempotently by ClientOrderID: resubmitting
	// the same id MUST NOT create a second venue order (objective §23).
	CreateOrder(ctx context.Context, req executor.OrderRequest) (executor.NormalizedOrder, error)
	// CancelOrder cancels by venue order id.
	CancelOrder(ctx context.Context, symbol, exchangeOrderID string) (executor.NormalizedOrder, error)
	// GetOrder fetches one order by venue order id.
	GetOrder(ctx context.Context, symbol, exchangeOrderID string) (executor.NormalizedOrder, error)
	// GetOpenOrders lists the account's open orders on symbol.
	GetOpenOrders(ctx context.Context, symbol string) ([]executor.NormalizedOrder, error)
	// GetFills lists recent fills on symbol (adapters dedup nothing; the fill
	// store dedups by (account, exchangeTradeId)).
	GetFills(ctx context.Context, symbol string) ([]executor.Fill, error)
}

// Registry maps venue ids to configured adapters (objective §8.16). A missing
// venue is an error at resolution time, never a silent no-op.
type Registry struct {
	adapters map[executor.ExchangeID]Exchange
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{adapters: map[executor.ExchangeID]Exchange{}}
}

// Register adds or replaces the adapter for a venue id.
func (r *Registry) Register(id executor.ExchangeID, ex Exchange) {
	r.adapters[id] = ex
}

// Resolve returns the adapter for id. Unknown venue ids are refused.
func (r *Registry) Resolve(id executor.ExchangeID) (Exchange, bool) {
	ex, ok := r.adapters[id]
	return ex, ok
}

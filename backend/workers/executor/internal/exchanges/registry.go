package exchanges

import (
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
)

// Registry maps venue ids to configured adapters (objective §8.16). A missing
// venue is an error at resolution time, never a silent no-op.
type Registry struct {
	adapters map[execution.ExchangeID]Exchange
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{adapters: map[execution.ExchangeID]Exchange{}}
}

// Register adds or replaces the adapter for a venue id.
func (r *Registry) Register(id execution.ExchangeID, ex Exchange) {
	r.adapters[id] = ex
}

// Resolve returns the adapter for id. Unknown venue ids are refused.
func (r *Registry) Resolve(id execution.ExchangeID) (Exchange, bool) {
	ex, ok := r.adapters[id]
	return ex, ok
}

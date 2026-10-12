package evmrpc

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "evmrpc"

// blockSchedule is how often one chain's tip is polled. A chain's own block
// time ranges from 2 s (Base) to 12 s (Ethereum) and a free public endpoint is
// rate-limited, so a 1-minute heartbeat is deliberately slower than the tip:
// this dataset answers "is the chain moving and at what height", and the
// plan's sub-second freshness targets apply to quotes, not to a block header.
// An operator can tighten it per chain by editing the job's schedule_seconds;
// EnsureJobs preserves runtime state and only owns schedule on seed.
const blockSchedule = time.Minute

// fetcher is one dataset's Fetcher implementation.
type fetcher struct {
	dataset string
	client  *client
}

// Fetch runs ONE synchronous attempt (the engine owns retries and the breaker).
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	switch f.dataset {
	case "block":
		written, rejected, next, err := f.client.block(ctx, w, job)
		if err != nil {
			return ingest.FetchResult{}, err
		}
		return ingest.FetchResult{
			RowsIn:       written + rejected,
			RowsWritten:  written,
			RowsRejected: rejected,
			Next:         next,
		}, nil
	default:
		return ingest.FetchResult{}, &HardError{Kind: "shape", Detail: "unknown dataset " + f.dataset}
	}
}

// Module is the evmrpc adapter's registration.
type Module struct {
	client *client
}

// NewModule builds the evmrpc module. Endpoints are read from the environment
// per call rather than captured here, so an operator can rotate an RPC endpoint
// without a restart; a nil Doer gets the shared tuned transport.
func NewModule(d canon.Doer) *Module {
	return &Module{client: newClient(d, 0)}
}

// Provider is the data.job provider column value.
func (m *Module) Provider() string { return providerName }

// HasCredentials reports whether ANY chain has an endpoint configured. The
// engine only uses it for a module-wide signal; per-chain enablement is decided
// in Jobs, because a partially configured deployment (Ethereum set, Base not)
// must not disable the chains that do work.
func (m *Module) HasCredentials() bool {
	for _, c := range chains {
		if endpoint(c) != "" {
			return true
		}
	}
	return false
}

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"block": &fetcher{dataset: "block", client: m.client},
	}
}

// Jobs seeds one block job per chain, keyed by the chain name as Subject. A
// chain with no endpoint seeds DISABLED rather than being omitted: the identity
// tuple (provider, dataset, subject, mode) then exists, so an operator can see
// which chains are unconfigured and enabling one is an UPDATE, not an insert
// (plan §23 - an adapter must exist before its credentials do).
func (m *Module) Jobs() []ingest.JobSpec {
	specs := make([]ingest.JobSpec, 0, len(chains))
	for _, c := range chains {
		specs = append(specs, ingest.JobSpec{
			Provider: providerName,
			Dataset:  "block",
			Subject:  c.Name,
			Mode:     "poll",
			Schedule: blockSchedule,
			Priority: 4,
			Enabled:  endpoint(c) != "",
		})
	}
	return specs
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)

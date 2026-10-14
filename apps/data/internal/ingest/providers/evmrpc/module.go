// module.go — the evmrpc adapter: raw EVM log ingestion (plan §16, tier S0).

// This is the S0 GROUND-TRUTH path: it reads `eth_getLogs` directly from a node
// and decodes the swap/mint/burn/sync events of the canonical AMM families into
// canonical rows, so every higher tier (indexers, aggregators) has a direct
// chain reference to reconcile against.
//
// It is deliberately split in two layers:
//
//	transport (client.go)  eth_getLogs -> []rawLog         (no ABI knowledge)
//	parsers   (events.go)  rawLog -> canonical events      (no RPC knowledge)
//
// so a malformed topic or a re-org is a parser/engine concern, not a transport
// one, and the parsers are unit-testable without a node.
//
// The AMM families recognised are the ones plan §20 names: the Uniswap V2 pair
// event signature set (Swap/Mint/Burn/Sync) and the Uniswap V3 pool event set
// (Swap/Mint/Burn), selected by the topic0 hash.
package evmrpc

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "evmrpc"

// RPCEndpointEnv is the node URL read once at construction. It may embed a
// provider API key, so it is treated as a secret: it never reaches a stored
// error, a log line, or a test failure message.
const RPCEndpointEnv = "EVM_RPC_URL"

// FallbackRPCEndpointEnv lets an operator point a non-default chain at its own
// node; the primary env wins when both are set.
const FallbackRPCEndpointEnv = "FUDCOURT_EVM_RPC_URL"

// sourceType is the plan §3 class for the raw-node adapter; it is registered in
// canon.ClassifyProvider so the write side and the read-side projection cannot
// disagree. TestWriterClassAgreesWithClassify pins it.
const sourceType = "rpc"

// seedPool is the seeded subject: the canonical Uniswap v3 WETH/USDT 0.05% pool.
const seedPool = "ethereum:0x11b815efb8f581194ae79006d24e0d814b7697f6"

// fetcher is one dataset's Fetcher. dw is the DEX writer the canonical events
// need (Fetch can only reach canon.Writer, which cannot write data.dex_*).
type fetcher struct {
	dataset string
	client  *client
	dw      dexstore.Writer
}

func (f *fetcher) Dataset() string { return f.dataset }

// Fetch runs ONE synchronous attempt (the engine owns retries).
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	if f.dw == nil {
		return ingest.FetchResult{}, &HardError{Kind: "shape", Detail: "no dex writer wired"}
	}
	var written, rejected int
	var next ingest.Cursor
	var err error
	switch f.dataset {
	case "pool-logs":
		written, rejected, next, err = f.client.poolLogs(ctx, w, f.dw, job)
	default:
		return ingest.FetchResult{}, &HardError{Kind: "shape", Detail: "unknown dataset " + f.dataset}
	}
	if err != nil {
		return ingest.FetchResult{}, err
	}
	if next == nil {
		next = ingest.Cursor{}
	}
	return ingest.FetchResult{
		RowsIn:       written + rejected,
		RowsWritten:  written,
		RowsRejected: rejected,
		Next:         next,
	}, nil
}

// Module is the evmrpc adapter's registration.
type Module struct {
	client *client
	dw     dexstore.Writer
}

// NewModule builds the evmrpc module. The node URL is read from the environment
// once, here; with no URL every fetch fails with a no-credentials HardError
// BEFORE any request and Jobs seeds the jobs disabled — a paid archive node must
// never fail the build or hammer a missing endpoint.
func NewModule(d canon.Doer, dw dexstore.Writer) *Module {
	return &Module{client: newClient(d, 0), dw: dw}
}

// HasCredentials reports whether an RPC endpoint is configured.
func (m *Module) HasCredentials() bool { return m.client.endpoint != "" }
func (m *Module) Provider() string     { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"pool-logs": &fetcher{dataset: "pool-logs", client: m.client, dw: m.dw},
	}
}

// Jobs seeds one block-cursor log backfill. It enables only with a configured
// endpoint AND a DEX writer, so a missing node is a disabled seed rather than a
// failing tick.
func (m *Module) Jobs() []ingest.JobSpec {
	enabled := m.HasCredentials() && m.dw != nil
	return []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "pool-logs", Subject: seedPool,
			Mode: "backfill", Schedule: 30 * time.Second, Priority: 3, Enabled: enabled,
		},
	}
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)

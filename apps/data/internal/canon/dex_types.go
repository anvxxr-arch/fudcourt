package canon

import (
	"math/big"
	"time"
)

// This file is the DEX Data Platform's canonical entity set (plan §4), living
// in package canon so it shares the ONE id space (ids.go) with every other
// canonical entity. A DEX USDC and a market USDC therefore join by token_id
// instead of being two islands.
//
// Layer discipline (plan §39): these structs import nothing but stdlib and
// their own package. No provider, no database, no HTTP. An adapter maps a
// provider payload INTO one of these; storage maps one of these INTO a row.
//
// Numeric discipline (plan §54, §65): token amounts are TokenAmount (exact
// integers), money/price/ratio are Dec (exact decimals). No float64 appears in
// any type in this file. That is deliberate and enforced by
// dex_types_test.go's TestDexTypesCarryNoFloats.

// DexDeployment is one protocol's contract set on one chain: the addresses the
// router/factory/position-manager live at. A protocol deployed on several
// chains gets one deployment per chain, so a Uniswap v3 pool on Ethereum and a
// Uniswap v3 pool on Base are unambiguously different venues.
type DexDeployment struct {
	DeploymentID string `json:"deployment_id"`
	// NaturalKey is the DeploymentKey spelling the id was minted from.
	NaturalKey string `json:"natural_key"`
	ProtocolID string `json:"protocol_id"`
	ChainID    string `json:"chain_id"`
	// Factory is the pool-factory / registry contract address, verbatim.
	Factory string `json:"factory,omitempty"`
	// Router is the swap-router contract address, verbatim.
	Router string `json:"router,omitempty"`
	// OtherContracts maps a role ("position_manager", "quoter", ...) to an
	// address. Roles are provider-neutral names the adapter chooses.
	OtherContracts map[string]string `json:"other_contracts,omitempty"`
	// AddressKind is the chain's address family ("evm", "solana", ...): the
	// same discriminated union data.token.address_kind carries.
	AddressKind string     `json:"address_kind,omitempty"`
	Provenance  Provenance `json:"provenance"`
}

// PoolToken is one side of a pool's composition (plan §4 "Pool composition").
// A V2 pool has exactly two; a concentrated-liquidity or stable pool can have
// more, so pool composition is a list, never a base/quote pair.
type PoolToken struct {
	PoolID  string `json:"pool_id"`
	TokenID string `json:"token_id"`
	// Index is the token's position in the pool's own ordering (0 = base for
	// a two-token AMM). Deterministic, so a re-read cannot reshuffle sides.
	Index int `json:"index"`
	// Reserve is the pool's current reserve of this token, exact.
	Reserve *TokenAmount `json:"reserve,omitempty"`
	// Weight is the token's pool weight as an exact fraction when the pool is
	// weighted (Balancer); nil for an unweighted AMM.
	Weight *Dec `json:"weight,omitempty"`
	// IsBase marks the side the pool prices against, when the protocol names
	// one. nil = the protocol does not designate a base side.
	IsBase *bool `json:"is_base,omitempty"`
}

// ProviderObservation is one stored RAW upstream payload (plan §6, §13). It is
// the coldest tier: retained briefly (the retention table windows it), never
// used as a canonical value, and never the thing a reader serves. It exists so
// a disputed number can be walked back to the exact bytes the provider sent.
type ProviderObservation struct {
	ObservationID string `json:"observation_id"`
	// NaturalKey is the ProviderObservationKey spelling the id was minted from.
	NaturalKey string `json:"natural_key"`
	// Provider is the data.job provider value.
	Provider string `json:"provider"`
	// Dataset is the provider dataset the payload belongs to.
	Dataset string `json:"dataset"`
	// RecordID is the provider's own id for the record, when it has one.
	RecordID string `json:"record_id"`
	// Endpoint is the exact URL or RPC method.
	Endpoint string `json:"endpoint,omitempty"`
	// Payload is the raw body, verbatim. Deliberately an opaque byte slice:
	// nothing in the canonical layer parses it.
	Payload []byte `json:"payload,omitempty"`
	// PayloadBytes is len(Payload), carried so a reader need not materialize
	// the body to report its size.
	PayloadBytes int       `json:"payload_bytes"`
	ObservedAt   time.Time `json:"observed_at"`
	StoredAt     time.Time `json:"stored_at"`
	// ExpiresAt is the retention deadline the sweeper enforces.
	ExpiresAt time.Time `json:"expires_at"`
}

// IngestionCheckpoint is the plan §14 resumable-ingestion state for one
// (provider, dataset, chain) stream. It mirrors data.job's runtime columns in a
// typed shape so a worker and the API agree on what "where the previous run
// stopped" means, instead of every fetcher inventing its own cursor keys.
type IngestionCheckpoint struct {
	Provider string `json:"provider"`
	Dataset  string `json:"dataset"`
	ChainID  string `json:"chain_id,omitempty"`
	// Cursor is the opaque provider-defined position (round-trips as jsonb).
	Cursor map[string]any `json:"cursor,omitempty"`
	// LastBlock / LastTimestamp are the structured halves of the cursor when
	// the stream is block- or time-ordered; nil when the stream is page- or
	// provider-cursor ordered instead.
	LastBlock     *int64     `json:"last_block,omitempty"`
	LastTimestamp *time.Time `json:"last_timestamp,omitempty"`
	LastSuccess   *time.Time `json:"last_success,omitempty"`
	// ErrorCount is the consecutive-failure count that drives backoff.
	ErrorCount int `json:"error_count"`
}

// PoolRef names a pool by its canonical identity, for a struct that references
// a pool without embedding the whole Pool row.
type PoolRef struct {
	PoolID  string `json:"pool_id"`
	ChainID string `json:"chain_id"`
}

// TokenRef names a token by its canonical identity plus the decimals needed to
// scale a raw amount. Decimals travels WITH the reference because a raw amount
// is meaningless without it (plan §54's triple).
type TokenRef struct {
	TokenID  string `json:"token_id"`
	ChainID  string `json:"chain_id"`
	Decimals int    `json:"decimals"`
}

// Scale builds the exact TokenAmount for a raw integer under this reference.
func (r TokenRef) Scale(raw *big.Int) (TokenAmount, error) {
	return NewTokenAmount(raw, r.Decimals)
}

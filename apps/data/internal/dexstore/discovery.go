package dexstore

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// This file is the plan §27/§49 pool-discovery pipeline: turn a CANDIDATE (a
// pool one source claims exists) into canonical rows, in the documented order
//
//	discover -> verify -> resolve tokens -> resolve protocol -> classify pool
//	         -> store -> schedule ingestion
//
// It is deliberately a pure-ish function over an injected writer: no network, no
// clock, so the whole pipeline is testable offline and a source's discovery
// adapter (a DEX factory event stream, an aggregator's new-pool feed) only has
// to produce Candidates. A candidate that fails verification is REJECTED with a
// reason, never stored — the audit's "orphan rows" hazard is exactly what this
// stage exists to prevent.

// DiscoverySource names where a candidate came from, so the stored row's
// provenance answers "which discovery path found this pool" (plan §6). The
// vocabulary mirrors canon.SourceTier: a factory event is protocol truth (S1),
// an aggregator listing is discovery (S3), a native API is protocol truth too.
type DiscoverySource string

const (
	// DiscoveryFactory is a DEX factory's PoolCreated event (S1, protocol truth).
	DiscoveryFactory DiscoverySource = "factory"
	// DiscoveryNative is a DEX-native API listing (S1).
	DiscoveryNative DiscoverySource = "native"
	// DiscoveryAggregator is an aggregator's new/trending feed (S3).
	DiscoveryAggregator DiscoverySource = "aggregator"
)

// tier maps a discovery source to its plan §3 tier, so the minted provenance
// carries the right confidence class rather than a made-up one.
func (s DiscoverySource) tier() (canon.SourceTier, bool) {
	switch s {
	case DiscoveryFactory, DiscoveryNative:
		return canon.TierDexNative, true
	case DiscoveryAggregator:
		return canon.TierAggregator, true
	default:
		return "", false
	}
}

// Candidate is one pool a source claims exists, before verification. Every field
// is what the SOURCE said, verbatim — this struct is not canonical and never
// stored; StoreConfirmed turns it into canonical rows or rejects it.
type Candidate struct {
	Source DiscoverySource
	// Provider is the data.job provider value that produced the candidate.
	Provider string
	// Confirmation names HOW the candidate was verified as a real pool: a
	// second source that agrees, or the mechanism that observed it (a decoded
	// factory event). Plan §27's pipeline is discover -> VERIFY -> store, and
	// this stage refuses to store a claim nobody confirmed. An empty
	// Confirmation is rejected, never treated as "assume verified".
	Confirmation string
	// ObservedAt is when the confirmation observed the pool (the block time of
	// the factory event, or the instant the second source listed it). Required:
	// a canonical pool row carries an observation time, and inventing one from a
	// clock here would fabricate the very timestamp the row exists to record.
	ObservedAt time.Time
	// ChainName is the source's chain slug ("ethereum", "solana").
	ChainName string
	// DEXSlug is the source's DEX id ("uniswap_v3", "raydium").
	DEXSlug string
	// PoolAddress is the pool/market account address.
	PoolAddress string
	// Factory / Router are the protocol contracts, when the source reports them.
	Factory string
	Router  string
	// Tokens are the pool's member tokens as the source reported them.
	Tokens []CandidateToken
	// BaseTokenIndex is the INDEX into Tokens of the side the protocol
	// designates as base, when it designates one. nil = no designation, and the
	// stored PoolToken.IsBase stays nil rather than asserting a base side the
	// source never claimed.
	BaseTokenIndex *int
	// ConfirmedBlock is the block the candidate's creation/report was observed
	// at, when the source reports one (a factory event always does).
	ConfirmedBlock *int64
}

// CandidateToken is one pool side as the source reported it. Address is the
// only thing required to mint a canonical token id.
type CandidateToken struct {
	Address  string
	Symbol   string
	Decimals int
	// HasDecimals distinguishes "the source said 0 decimals" from "the source
	// did not say": a real 0-decimal token is preserved, an unreported one is
	// left nil on the stored row rather than fabricated as 0.
	HasDecimals bool
}

// DiscoveryResult reports what the pipeline did with one candidate, so a caller
// (and the coverage dashboard) can tell discovered from stored from rejected and
// why.
type DiscoveryResult struct {
	PoolID     string
	Stored     bool
	Reason     string // why it was rejected, when Stored is false
	TokensKept int    // pool member tokens that resolved to a canonical token id
}

// StoreConfirmed writes the canonical rows for a VERIFIED candidate, in
// dependency order: chains -> venues -> deployment -> pool -> tokens.
//
// Confirmation is enforced, not assumed: a candidate that names no Confirmation
// or carries no ObservedAt is rejected, because plan §27's pipeline is
// discover -> verify -> store and this stage is where the verify is required.
// Validation is the separate, cheaper gate (non-empty chain/address/dex and at
// least one resolvable token).
func StoreConfirmed(ctx context.Context, w Writer, wc canon.Writer, c Candidate) (DiscoveryResult, error) {
	if wc == nil || w == nil {
		return DiscoveryResult{}, fmt.Errorf("dexstore: discovery needs both a canon writer and a dex writer")
	}
	tier, ok := c.Source.tier()
	if !ok {
		return DiscoveryResult{Reason: "unknown discovery source " + string(c.Source)}, nil
	}
	chain := strings.ToLower(strings.TrimSpace(c.ChainName))
	addr := strings.TrimSpace(c.PoolAddress)
	dex := strings.ToLower(strings.TrimSpace(c.DEXSlug))
	if chain == "" {
		return DiscoveryResult{Reason: "candidate has no chain"}, nil
	}
	if addr == "" {
		return DiscoveryResult{Reason: "candidate has no pool address (symbols are never ids)"}, nil
	}
	if dex == "" {
		return DiscoveryResult{Reason: "candidate has no dex slug"}, nil
	}
	// The verify gate: a claim nobody confirmed is not a pool.
	if strings.TrimSpace(c.Confirmation) == "" {
		return DiscoveryResult{Reason: "candidate carries no confirmation (discover -> verify -> store)"}, nil
	}
	if c.ObservedAt.IsZero() {
		return DiscoveryResult{Reason: "candidate carries no observed_at"}, nil
	}
	members := resolveTokens(c.Tokens)
	if len(members) == 0 {
		return DiscoveryResult{Reason: "candidate has no resolvable member token"}, nil
	}

	chainID := canon.MintID(canon.KindChain, canon.ChainKey(chain))
	venueID := canon.MintID(canon.KindVenue, canon.VenueKey(dex))
	poolID := canon.MintID(canon.KindPool, canon.PoolKey(chain, addr))
	protocolID := canon.MintID(canon.KindProtocol, canon.ProtocolKey(dex))
	prov := canon.ProvenanceForProvider(c.Provider)
	// The discovery PATH also implies a tier (a factory event is protocol truth,
	// an aggregator listing is discovery). When the provider is unclassified the
	// path supplies it; when both know, they must AGREE — a factory event
	// attributed to an aggregator is a wiring bug, not a fact to average.
	if prov.Tier == "" {
		prov.Tier = tier
		prov.SourceType = sourceTypeFor(c.Source)
	} else if !tierAgrees(prov.Tier, tier) {
		return DiscoveryResult{Reason: fmt.Sprintf("provider %q is tier %s but discovery source %q is tier %s",
			c.Provider, prov.Tier, c.Source, tier)}, nil
	}
	prov.ChainID = chainID
	prov.ObservedAt = c.ObservedAt
	if c.ConfirmedBlock != nil {
		prov.BlockNumber = c.ConfirmedBlock
	}

	dexName := dex
	if _, err := wc.UpsertChains(ctx, []canon.Chain{{ChainID: chainID, Name: chain, Kind: chainKind(chain)}}); err != nil {
		return DiscoveryResult{}, err
	}
	if _, err := wc.UpsertVenues(ctx, []canon.Venue{{
		VenueID: venueID, Name: &dexName, Kind: "dex", MarketTypes: []string{"swap"},
	}}); err != nil {
		return DiscoveryResult{}, err
	}
	// The deployment names the (chain, protocol) pair, so a discovered pool
	// joins a known protocol deployment instead of floating unowned.
	if _, err := w.UpsertDexDeployments(ctx, []canon.DexDeployment{{
		DeploymentID: canon.MintID(canon.KindDeployment, canon.DeploymentKey(chain, dex)),
		NaturalKey:   canon.DeploymentKey(chain, dex),
		ProtocolID:   protocolID,
		ChainID:      chainID,
		Factory:      strings.TrimSpace(c.Factory),
		Router:       strings.TrimSpace(c.Router),
		AddressKind:  addressKind(chain),
		Provenance:   prov,
	}}); err != nil {
		return DiscoveryResult{}, err
	}
	// The POOL itself must be written before its pool_token rows, or every
	// discovered pool leaves orphan composition rows pointing at a pool id that
	// does not exist. It is minted from the same PoolKey every other dataset
	// uses, so discovery and market data meet on one identity. No price or
	// liquidity is invented here (discovery knows the pool EXISTS, not its
	// market state) — those columns stay at their absent values.
	if _, _, err := wc.WritePools(ctx, []canon.Pool{{
		PoolID:      poolID,
		ChainID:     chainID,
		DEXVenueID:  venueID,
		Address:     addr,
		At:          c.ObservedAt,
		Source:      c.Provider,
		RetrievedAt: c.ObservedAt,
	}}); err != nil {
		return DiscoveryResult{}, err
	}
	rows := make([]canon.PoolToken, 0, len(members))
	for _, m := range members {
		pt := canon.PoolToken{PoolID: poolID, TokenID: m.TokenID, Index: m.Index}
		// IsBase is set ONLY when the candidate actually designates a base side
		// (an explicit BaseTokenIndex). Absent stays nil: asserting a base side
		// the source never claimed is the same fabrication as a defaulted
		// liquidity or decimals.
		if c.BaseTokenIndex != nil && m.Index == *c.BaseTokenIndex {
			base := true
			pt.IsBase = &base
		}
		rows = append(rows, pt)
	}
	if _, err := w.UpsertPoolTokens(ctx, rows); err != nil {
		return DiscoveryResult{}, err
	}
	return DiscoveryResult{PoolID: poolID, Stored: true, TokensKept: len(members)}, nil
}

// sourceTypeFor maps a discovery path to the canon.SourceType label.
func sourceTypeFor(s DiscoverySource) string {
	switch s {
	case DiscoveryFactory, DiscoveryNative:
		return "dex_native"
	default:
		return "aggregator"
	}
}

// tierAgrees reports whether a classified provider's tier is compatible with the
// discovery path's tier. A source at or above the path is fine (a native API
// found by an aggregator's listing is still native); a source BELOW the path is
// a contradiction (an aggregator cannot emit a factory event).
func tierAgrees(providerTier, pathTier canon.SourceTier) bool {
	rank := func(t canon.SourceTier) int {
		switch t {
		case canon.TierBlockchain:
			return 0
		case canon.TierDexNative:
			return 1
		case canon.TierIndexer:
			return 2
		case canon.TierAggregator:
			return 3
		case canon.TierAnalytics:
			return 4
		case canon.TierDerived:
			return 5
		}
		return 6
	}
	return rank(providerTier) <= rank(pathTier)
}

// member is one resolved pool side.
type member struct {
	TokenID string
	Index   int
}

// resolveTokens keeps only the candidate tokens that carry an address (an
// addressless side cannot mint a canonical id) and preserves their ORDER as the
// pool's own index. Duplicate addresses within one pool collapse to the first
// position, so a malformed source cannot store the same side twice.
func resolveTokens(ts []CandidateToken) []member {
	seen := map[string]bool{}
	out := make([]member, 0, len(ts))
	for _, t := range ts {
		a := strings.TrimSpace(t.Address)
		if a == "" || seen[a] {
			continue
		}
		seen[a] = true
		out = append(out, member{
			TokenID: canon.MintID(canon.KindToken, canon.TokenKey("", a)),
			Index:   len(out),
		})
	}
	return out
}

// chainKind is the address family for a chain slug, matching the pool adapters'
// existing mapping so discovery and market rows agree on one label.
func chainKind(chain string) string {
	switch chain {
	case "solana":
		return "solana"
	case "sui":
		return "sui"
	case "ton":
		return "ton"
	case "aptos":
		return "aptos"
	case "near":
		return "near"
	case "cosmos":
		return "cosmos"
	case "tron":
		return "tron"
	default:
		return "evm"
	}
}

// addressKind is the chain's address family for the deployment row.
func addressKind(chain string) string { return chainKind(chain) }

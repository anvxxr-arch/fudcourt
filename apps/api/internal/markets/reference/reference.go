// Package reference is the canonical reference registry for the entities that
// had no id space anywhere in the repo: Asset, Token, Chain and Venue. It mints
// stable ids, resolves provider identifiers to them, and is the single owner of
// that mapping.
//
// # Ownership (decided, not inferred)
//
// backend/api owns canonical reference data. The restructure's own assignment
// puts markets/venues/assets in backend/api (docs/architecture/domain-map.md
// section 1; docs/architecture/target.md sections 2 and 5), backend/data is
// deliberately stateless passthrough (backend/data/platform/cache/cache.go:
// "a cache is an optimisation; it must never become a dependency"), apps/reconciler
// owns only the `assets` snapshot (apps/reconciler/src/persistence/db.rs), and the
// executor owns only the executor.* schema. Nothing else can host it.
//
// # id rule (deterministic, documented, no randomness)
//
//	id = kind ":" hex(sha256(salt 0x00 kind 0x00 naturalKey)[0:10])
//
// with salt = "fudcourt/canonical-reference/v1" and naturalKey a stable string
// per kind:
//
//	chain   "chain/<name>"                      name = the lowercase label wallets.go canonicalizes on
//	asset   "asset/<kind>/<SYMBOL>"             native/fiat/stablecoin: see the note below
//	token   "token/<chain-name>/<address>"      the FULL address, verbatim casing - never a label
//	venue   "venue/<venue-id>"                  the id the tree already uses for the venue
//
// Properties this buys, and why each matters:
//
//   - Deterministic and process-independent: sha256 has no clock, no
//     randomness and no state, so two processes mint the same id for the same
//     entity. Map iteration order is irrelevant because Build sorts its output.
//   - Opaque-looking: a consumer cannot read a symbol out of an id, so no code
//     can be tempted to parse one.
//   - Non-symbol-derived where the entity is not the symbol: a chain is keyed
//     by its canonical name, a token by (chain, FULL contract address), a venue
//     by its id. Only an ASSET is keyed by its symbol, because for a native
//     coin or a fiat unit the symbol IS the conventional identity and the tree
//     provides no issuer or scheme identifier. That is a recorded cost, not an
//     oversight: if a real issuer identity ever appears, the asset natural key
//     must change and every asset id changes with it. TestBuildIsPinnedToKnownIDs
//     pins today's ids so that change cannot happen silently.
//   - Collision-safe rather than collision-blind: Build refuses two entities
//     with the same id (ErrDuplicateID) instead of silently merging them.
//
// Symbol-derived asset keys are also why the two data leaks the audit found are
// handled here explicitly rather than papered over: see the MATIC/POL note in
// seed.go and the full-address rule for tokens (a truncated `SPL:<mint6>` label
// can never become a token id, and TokenByAddress would not find it).
//
// # Cross-service sharing (no cross-module imports)
//
// The repo's rule is that services MUST NOT import each other's implementation,
// contracts only (docs/architecture/target.md section 3.2, docs/architecture/
// migration-plan.md; docs/architecture/final-review.md section 5 verifies each
// Go module imports only its own path). backend/data, apps/reconciler and
// backend/workers/executor therefore can NEVER import this package. The sharing
// path is contract-first instead:
//
//  1. a DATA artifact - shared/contracts/data/reference.json, the whole
//     reference set plus the whole (provider, provider_id) -> canonical_id
//     table, emitted deterministically by this package (`go run
//     ./backend/api/internal/markets/reference/cmd/emit`) and pinned by a test
//     that fails when the checked-in file is stale. A consumer in any language
//     reads that file; nobody imports Go to get an id.
//  2. the JSON SCHEMAS - shared/contracts/schemas/{assets/asset.json,
//     assets/token.json, assets/chain.json, markets/venue.json} define the
//     shape. This package's structs are held to them field for field by
//     TestContractParity, which fails naming the offending field.
//  3. per-service structs stay private: each service keeps its own type and
//     reads the artifact. No service hands another its struct.
//
// The rejected alternative is an HTTP endpoint served by backend/api. It is
// rejected because backend/api serves no domain routes today (cmd/api/main.go
// registers only /healthz, /readyz, /api/auth/{login,callback,logout} and
// /api/admin/members), and because an id space is a static fact: making it a
// runtime hop would turn "what is asset X called" into a network dependency
// that can be down, slow, or partially deployed, when it can just be a file.
//
// # Seed provenance
//
// Every seeded row is transcribed from a registry that already exists in the
// tree; each seed carries its citation. Where the tree does not assert a
// mapping it is omitted and listed in the UNMAPPED block in seed.go - nothing
// here is invented.
package reference

import "errors"

// EntityKind is the id NAMESPACE an entity id belongs to. It is the prefix of
// every minted id, so a consumer can tell what an id refers to without a lookup
// while still treating the rest of the id as opaque.
type EntityKind string

const (
	// KindAsset names the asset namespace.
	KindAsset EntityKind = "asset"
	// KindToken names the token namespace.
	KindToken EntityKind = "token"
	// KindChain names the chain namespace.
	KindChain EntityKind = "chain"
	// KindVenue names the venue namespace.
	KindVenue EntityKind = "venue"
)

// EntityKinds lists every namespace, in a fixed order (used by validation and
// by the tests that walk the whole document).
var EntityKinds = []EntityKind{KindAsset, KindToken, KindChain, KindVenue}

// Valid reports whether k names a namespace this package mints into.
func (k EntityKind) Valid() bool {
	for _, v := range EntityKinds {
		if k == v {
			return true
		}
	}
	return false
}

// Provider names an upstream (or repo-internal) identifier space. The first
// seven values are EXACTLY the enum in
// shared/contracts/schemas/assets/asset.json (asset.provider_ids[].provider),
// and Asset.ProviderIDs / Chain.ProviderIDs may only use those - the contract
// parity test enforces it. The last two are outside that schema on purpose and
// may therefore only appear in the top-level resolution table, never inside an
// entity that the schema describes:
//
//   - ProviderCCXT: the venue ids ccxt uses, which frontend/web/src/features/
//     ticker/client.ts ships verbatim as TICKER_EXCHANGES. The schema has no
//     venue provider_ids property at all, so these live in the mapping table.
//   - ProviderInternal: identifiers this repo itself produces rather than
//     receives. Today exactly one is registered: the `MATIC` label apps/reconciler
//     writes into `assets` rows (see the MATIC/POL note in seed.go).
type Provider string

const (
	// ProviderCoinGecko is the CoinGecko identifier space.
	ProviderCoinGecko Provider = "coingecko"
	// ProviderCryptoRank is the CryptoRank identifier space (coin keys and chain slugs).
	ProviderCryptoRank Provider = "cryptorank"
	// ProviderDexScreener is the DexScreener identifier space.
	ProviderDexScreener Provider = "dexscreener"
	// ProviderDefiLlama is the DefiLlama identifier space (its values are `coingecko:<slug>`).
	ProviderDefiLlama Provider = "defillama"
	// ProviderChainRank is the ChainRank identifier space.
	ProviderChainRank Provider = "chainrank"
	// ProviderCoinMarketCap is the CoinMarketCap identifier space.
	ProviderCoinMarketCap Provider = "coinmarketcap"
	// ProviderOnchain is the identifier space of a chain's own registry (a contract address, a chain name).
	ProviderOnchain Provider = "onchain"
	// ProviderCryptoRankChain is the CryptoRank CHAIN surface. It exists because
	// CryptoRank spells a chain and its native coin the same way (`bnb` is both),
	// and a bare provider id must denote exactly one entity. `cryptorank` stays
	// the coin/asset surface; this is the chain surface.
	ProviderCryptoRankChain Provider = "cryptorank-chain"
	// ProviderCCXT is the ccxt venue identifier space (see the type doc).
	ProviderCCXT Provider = "ccxt"
	// ProviderInternal is the reserved namespace for identifiers this repo mints itself (see the type doc).
	ProviderInternal Provider = "internal"
)

// SchemaProviders returns the seven values the asset/chain contract allows
// inside an embedded provider_ids list. The contract parity test compares this
// against the schema enum, so adding a value here without a schema change (or
// the reverse) fails loudly.
func SchemaProviders() []Provider {
	return []Provider{
		ProviderCoinGecko,
		ProviderCryptoRank,
		ProviderDexScreener,
		ProviderDefiLlama,
		ProviderChainRank,
		ProviderCoinMarketCap,
		ProviderOnchain,
	}
}

// Refusals. Every one is a refusal, never a guess: this package never fuzzy
// matches, never falls back to a symbol, and never returns an empty id that a
// caller could mistake for success.
var (
	// ErrUnknownProvider marks an identifier whose provider this build does not know.
	ErrUnknownProvider = errors.New("reference: unknown provider")
	// ErrUnknownIdentifier marks a known provider with no registered identifier.
	ErrUnknownIdentifier = errors.New("reference: unknown provider identifier")
	// ErrUnknownEntity marks an id that no entity in this registry carries.
	ErrUnknownEntity = errors.New("reference: unknown canonical id")
	// ErrDuplicateID marks two entities minting the same id, or two mapping rows for one identifier.
	ErrDuplicateID = errors.New("reference: duplicate id")
	// ErrInvalidSeed marks a seed that cannot be built (missing reference, bad address, unknown enum).
	ErrInvalidSeed = errors.New("reference: invalid seed")
	// ErrInvalidDocument marks a document that cannot be loaded (bad id, dangling reference, wrong namespace).
	ErrInvalidDocument = errors.New("reference: invalid document")
)

package reference

import "regexp"

// The address families, transcribed from frontend/web/src/features/dex/client.ts
// (MINT_RE / HEX_RE / NAME_RE). They are duplicated here rather than imported
// because backend/api must not depend on frontend/web source, and because the
// contract's address_kind enum is what both sides are pinned to.
var (
	// EVMAddressShape matches a 0x-prefixed 20-byte hex address ("hex").
	EVMAddressShape = regexp.MustCompile(`^0[xX][0-9a-fA-F]{40}$`)
	// SolAddressShape matches a base58 mint ("base58"), 32-44 characters.
	SolAddressShape = regexp.MustCompile(`^[1-9A-HJ-NP-Za-km-z]{32,44}$`)
	// NameAddressShape matches a NEAR-style dotted name ("name").
	NameAddressShape = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*\.[a-z0-9][a-z0-9._-]*$`)
)

// AssetKind is the closed vocabulary of shared/contracts/schemas/assets/asset.json
// (the `kind` enum). native = a chain's own coin; fiat = an off-chain currency
// (USD is the unit of every *_usd figure in the repo); stablecoin is the
// classification the provider data already carries.
type AssetKind string

const (
	// AssetNative is a chain's own coin (ETH, BNB, POL, SOL).
	AssetNative AssetKind = "native"
	// AssetToken is an asset that exists only as a contract deployment (USDT, USDC).
	AssetToken AssetKind = "token"
	// AssetFiat is an off-chain currency unit (USD).
	AssetFiat AssetKind = "fiat"
	// AssetStablecoin is a value-pegged asset; the provider data marks these.
	AssetStablecoin AssetKind = "stablecoin"
	// AssetOther is the honest catch-all for a provider row that fits none of the above.
	AssetOther AssetKind = "other"
)

// AssetKinds lists the asset kinds in contract order.
var AssetKinds = []AssetKind{AssetNative, AssetToken, AssetFiat, AssetStablecoin, AssetOther}

// Valid reports whether k is one of the contract's asset kinds.
func (k AssetKind) Valid() bool {
	for _, v := range AssetKinds {
		if k == v {
			return true
		}
	}
	return false
}

// ChainKind is the closed vocabulary of shared/contracts/schemas/assets/chain.json
// (the `kind` enum).
type ChainKind string

const (
	// ChainEVM is an EVM-family chain.
	ChainEVM ChainKind = "evm"
	// ChainSolana is the Solana family.
	ChainSolana ChainKind = "solana"
	// ChainHyperliquid is Hyperliquid, whose balances the sync reads directly rather than over RPC.
	ChainHyperliquid ChainKind = "hyperliquid"
	// ChainOffchain is not a chain at all: it is the label the transactions table defaults to for a movement with no chain, and it is modelled so a consumer can resolve it honestly instead of inventing something.
	ChainOffchain ChainKind = "offchain"
	// ChainOther is the honest catch-all.
	ChainOther ChainKind = "other"
)

// ChainKinds lists the chain kinds in contract order.
var ChainKinds = []ChainKind{ChainEVM, ChainSolana, ChainHyperliquid, ChainOffchain, ChainOther}

// Valid reports whether k is one of the contract's chain kinds.
func (k ChainKind) Valid() bool {
	for _, v := range ChainKinds {
		if k == v {
			return true
		}
	}
	return false
}

// VenueKind is the closed vocabulary of shared/contracts/schemas/markets/venue.json
// (the `kind` enum). A DEX is not a trading venue in this build: the executor's
// adapters are binance/bybit/mexc only, so a dex-kind venue is data-only.
type VenueKind string

const (
	// VenueCEX is a venue with an order API.
	VenueCEX VenueKind = "cex"
	// VenueDEX is an on-chain venue (pool data only today).
	VenueDEX VenueKind = "dex"
)

// VenueKinds lists the venue kinds in contract order.
var VenueKinds = []VenueKind{VenueCEX, VenueDEX}

// Valid reports whether k is one of the contract's venue kinds.
func (k VenueKind) Valid() bool {
	for _, v := range VenueKinds {
		if k == v {
			return true
		}
	}
	return false
}

// MarketType is the instrument market family a venue is modelled for. The two
// values are the frozen pair of shared/contracts/schemas/markets/instrument.json
// ($defs.market_type), declared identically in
// backend/api/internal/markets/instruments/instrument.go and
// backend/api/internal/accounts/exchange/account.go.
type MarketType string

const (
	// MarketTypeSpot is the spot market family.
	MarketTypeSpot MarketType = "spot"
	// MarketTypeLinearPerp is USDT-linear perpetual futures.
	MarketTypeLinearPerp MarketType = "linear_perp"
)

// MarketTypes lists the market families in contract order.
var MarketTypes = []MarketType{MarketTypeSpot, MarketTypeLinearPerp}

// Valid reports whether m is one of the two frozen market families.
func (m MarketType) Valid() bool {
	return m == MarketTypeSpot || m == MarketTypeLinearPerp
}

// ProviderID is one provider's identifier for one canonical entity. It is the
// contract's asset.provider_ids[] item, and the same shape is reused on Chain.
//
// `provider` is deliberately typed as Provider even though the schema enum is a
// subset of the constants: Asset and Chain may only carry SchemaProviders(),
// while the top-level resolution table may additionally use ccxt and internal.
// The parity test enforces which is which.
type ProviderID struct {
	Provider   Provider `json:"provider"`
	ProviderID string   `json:"provider_id"`
}

// Asset is the contract of shared/contracts/schemas/assets/asset.json, field for
// field. Every json tag here is the schema property name; the parity test reads
// the schema and fails naming any field that drifts.
//
// Nullability follows the schema: `name`, `chain_id`, `decimals` are nullable
// (Go pointer / empty-string convention is chosen per field below and asserted
// by the parity test's required-set check), while `asset_id`, `symbol` and
// `kind` are required.
type Asset struct {
	AssetID     string       `json:"asset_id"`
	Symbol      string       `json:"symbol"`
	Name        *string      `json:"name,omitempty"`
	Kind        AssetKind    `json:"kind"`
	ChainID     *string      `json:"chain_id,omitempty"`
	Decimals    *int         `json:"decimals,omitempty"`
	ProviderIDs []ProviderID `json:"provider_ids,omitempty"`
}

// Token is the contract of shared/contracts/schemas/assets/token.json, field for
// field. TokenID is keyed by (chain, FULL address): the truncated `SPL:<mint6>`
// label the Rust sync prints is a DISPLAY concern and must never be passed here.
type Token struct {
	TokenID     string  `json:"token_id"`
	ChainID     string  `json:"chain_id"`
	Address     string  `json:"address"`
	AddressKind string  `json:"address_kind,omitempty"`
	AssetID     *string `json:"asset_id,omitempty"`
	Symbol      string  `json:"symbol"`
	Name        *string `json:"name,omitempty"`
	Decimals    *int    `json:"decimals,omitempty"`
}

// Chain is the contract of shared/contracts/schemas/assets/chain.json, field for
// field. `name` is the lowercase canonical label
// the retired accounts/wallets package keys its address rules on.
type Chain struct {
	ChainID        string       `json:"chain_id"`
	Name           string       `json:"name"`
	DisplayName    *string      `json:"display_name,omitempty"`
	Kind           ChainKind    `json:"kind"`
	NativeAssetID  *string      `json:"native_asset_id,omitempty"`
	ChainNumericID *int         `json:"chain_numeric_id,omitempty"`
	ProviderIDs    []ProviderID `json:"provider_ids,omitempty"`
}

// Venue is the contract of shared/contracts/schemas/markets/venue.json, field for
// field. `known` is the load-bearing field: it says whether THIS build can place
// an order there, which is a different question from whether the venue appears
// in the data.
type Venue struct {
	VenueID     string       `json:"venue_id"`
	Name        *string      `json:"name,omitempty"`
	Kind        VenueKind    `json:"kind"`
	Known       bool         `json:"known"`
	MarketTypes []MarketType `json:"market_types,omitempty"`
	URL         *string      `json:"url,omitempty"`
}

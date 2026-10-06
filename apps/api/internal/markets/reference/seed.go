package reference

import (
	"fmt"
	"strings"
)

// This file is the seed data: every row is transcribed from a registry that
// already exists in the tree, and each carries its citation. NOTHING here is
// invented; see the UNMAPPED block at the bottom for everything the tree does
// not assert.

// seedAsset is one seeded asset. ChainName empty means the asset has no home
// chain (a fiat unit).
type seedAsset struct {
	kind      AssetKind
	symbol    string
	name      string
	chainName string // "" = no home chain
	// providers are the SCHEMA-LEGAL pairs (the provider enum of
	// contracts/schemas/assets/asset.json). They become the entity's
	// provider_ids list AND mapping rows.
	providers []string
	// mappings are pairs that may ONLY live in the top-level resolution table,
	// because their provider is outside the schema enum (ccxt, internal). The
	// `internal=MATIC` spelling of the Polygon native asset is the one in use.
	mappings []string
}

// seedToken is one seeded contract deployment.
type seedToken struct {
	chainName string
	symbol    string
	assetSym  string // the asset this token is an instance of
	address   string // the FULL address, verbatim casing
	decimals  int
}

// seedChain is one seeded chain.
type seedChain struct {
	name        string // lowercase canonical label wallets.go keys on
	displayName string
	kind        ChainKind
	nativeSym   string // "" = no native asset
	providers   []string
	mappings    []string
}

// seedVenue is one seeded venue.
type seedVenue struct {
	id          string // the id the tree already uses
	name        string
	kind        VenueKind
	known       bool
	marketTypes []MarketType
	ccxtID      string // "" = ccxt has no such venue
}

// Chained chains: the seven chain names that appear in the tree.
//
// Provenance:
//
//   - name/kind: the retired accounts/wallets package chainRules
//     (ethereum, bsc, polygon, arbitrum, optimism, base, solana) plus the sync's
//     own labels for the two that wallets.go does not model
//     (apps/reconciler/src/streams/sync.rs: "Hyperliquid (spot)" / "Hyperliquid
//     (perp)" rows, and apps/reconciler/src/chains.rs HYPERLIQUID_INFO).
//
//   - native symbols: apps/reconciler/src/chains.rs EVM[].native ("ETH", "BNB",
//     "POL" for Polygon, "ETH" on Arbitrum/Optimism/Base), "SOL" from
//     apps/reconciler/src/streams/sync.rs native-SOL row.
//
//   - offchain: "is not a chain" in the strict sense, but
//     the retired finance/transactions package defaults
//     Transaction.Chain to "Offchain", so it is modelled rather than dropped -
//     a consumer must be able to resolve the label the writer actually writes.
//
//   - provider ids: ONLY the CryptoRank chain slug, under the surface-qualified
//     provider `cryptorank-chain`, taken from the recorded chain fixture
//     tests/fixtures/blockchains.json.gz (moved from
//     apps/web/scripts/fixtures/ by fd17dc6)
//     pageProps.blockchains[] (Ethereum=ethereum, BNB=bnb,
//     Polygon=matic-network, Solana=solana, Arbitrum=arbitrum, Base=base,
//     Optimism=optimism).
//
//     The surface qualifier is not decoration: CryptoRank spells its BNB CHAIN
//     row `bnb` and its BNB COIN row `bnb`, and CoinGecko/DefiLlama spell the
//     price id for the BNB COIN the same way. A bare provider id must denote
//     exactly one entity (Build refuses anything else), so the COLLIDING surface
//     is qualified rather than merged: `cryptorank` stays the coin/asset surface
//     (the one research/coin.json and the coins fixture speak) and the chain
//     surface is `cryptorank-chain`. Two spellings, two entities, both real.
//
//     For the same reason NO chain carries a coingecko or defillama id:
//     apps/reconciler/src/chains.rs LLAMA_IDS is a SYMBOL -> price-id map ("ETH" ->
//     "coingecko:ethereum"), so those ids denote the ASSET, and asserting them
//     on a chain would create exactly the collision above. Chains therefore
//     carry no embedded provider_ids at all - the contract's enum has no
//     chain-surface value, so the chain ids live in the mapping table only.
//
//   - chain_numeric_id is deliberately ABSENT for every chain: no EVM chain id
//     appears anywhere in the tree (checked: apps/,
//     apps/web/scripts, database). The contract allows null and the schema
//     description wants a value we do not have, so it stays nil rather than
//     being guessed.
func seedChains() []seedChain {
	return []seedChain{
		{name: "ethereum", displayName: "Ethereum", kind: ChainEVM, nativeSym: "ETH",
			mappings: []string{"cryptorank-chain=ethereum"}},
		{name: "bsc", displayName: "BNB", kind: ChainEVM, nativeSym: "BNB",
			mappings: []string{"cryptorank-chain=bnb"}},
		{name: "polygon", displayName: "Polygon", kind: ChainEVM, nativeSym: "POL",
			mappings: []string{"cryptorank-chain=matic-network"}},
		{name: "arbitrum", displayName: "Arbitrum", kind: ChainEVM, nativeSym: "ETH",
			mappings: []string{"cryptorank-chain=arbitrum"}},
		{name: "optimism", displayName: "Optimism", kind: ChainEVM, nativeSym: "ETH",
			mappings: []string{"cryptorank-chain=optimism"}},
		{name: "base", displayName: "Base", kind: ChainEVM, nativeSym: "ETH",
			mappings: []string{"cryptorank-chain=base"}},
		{name: "solana", displayName: "Solana", kind: ChainSolana, nativeSym: "SOL",
			mappings: []string{"cryptorank-chain=solana"}},
		{name: "hyperliquid", displayName: "Hyperliquid", kind: ChainHyperliquid, nativeSym: "HYPE"},
		{name: "offchain", displayName: "Offchain", kind: ChainOffchain},
	}
}

// seedAssets: the eight assets the tree names.
//
// Provenance: apps/reconciler/src/chains.rs LLAMA_IDS - a SYMBOL -> price-id map,
// so its values denote the ASSET, not the chain - keys (ETH, BNB, POL, SOL,
// USDT, USDC), plus USD, which is the unit of every *_usd figure in the
// db/schema files and of common/money.json. Those six `coingecko:` ids are
// therefore registered here, under both `defillama` (verbatim) and `coingecko`
// (the same slug the id is built from). Names and provider ids come
// from the same places as the chains above; the CryptoRank values are the
// recorded fixture's coin keys
// (tests/fixtures/coins.json.gz, moved from apps/web/scripts/fixtures/ by
// fd17dc6; pageProps.coins[]:
// bitcoin, ethereum, tether, bnb, usdcoin, solana, polygon-ecosystem-token,
// hyperliquid).
//
// MATIC vs POL - the leak the audit found, handled here rather than papered
// over. apps/reconciler/src/chains.rs:118-120 states it outright: "Polygon's native
// balance is valued at the POL (polygon-ecosystem-token) price and the `assets`
// row is labelled `MATIC`" - the label the Python oracle and the historical
// table already used, carried by apps/reconciler/src/streams/sync.rs:106-109 which
// pushes the literal ("MATIC", pol_price). The registry therefore holds ONE
// canonical asset (kind=native, symbol=POL, chain=polygon) and records `MATIC`
// as an internal provider SPELLING of it, so a caller holding the sync's MATIC
// label resolves to the same asset instead of minting a second one. Two assets
// named MATIC and POL would be the invention; one asset with two spellings is
// what the tree says.
//
// USDT/USDC are seeded as kind=stablecoin rather than kind=token: the fixture
// row for tether carries type=token with category=stablecoin, and the single
// contract `kind` field has to pick one. stablecoin is the more specific and the
// more useful of the two, and the token-ness is carried by their Token rows.
func seedAssets() []seedAsset {
	return []seedAsset{
		// ETH is native on FOUR chains (ethereum, arbitrum, optimism, base) and
		// therefore spans chains: per the asset schema's own rule the home chain
		// is null and the Tokens carry the chain. Seeding it on "ethereum" would
		// be a claim the seed cannot keep.
		{kind: AssetNative, symbol: "ETH", name: "Ethereum",
			providers: []string{"coingecko=ethereum", "defillama=coingecko:ethereum", "cryptorank=ethereum"}},
		{kind: AssetNative, symbol: "BNB", name: "BNB", chainName: "bsc",
			providers: []string{"coingecko=binancecoin", "defillama=coingecko:binancecoin", "cryptorank=bnb"}},
		{kind: AssetNative, symbol: "POL", name: "Polygon Ecosystem Token", chainName: "polygon",
			providers: []string{"coingecko=polygon-ecosystem-token", "defillama=coingecko:polygon-ecosystem-token", "cryptorank=polygon-ecosystem-token"},
			mappings:  []string{"internal=MATIC"}},
		{kind: AssetNative, symbol: "SOL", name: "Solana", chainName: "solana",
			providers: []string{"coingecko=solana", "defillama=coingecko:solana", "cryptorank=solana"}},
		// HYPE has no provider id in the tree: the sync reads Hyperliquid
		// balances without pricing them (apps/reconciler/src/streams/sync.rs leaves
		// the SPL/Hyperliquid usd at 0.0 and never calls the price oracle for
		// HYPE). Recorded as an omission in the UNMAPPED block, not guessed.
		{kind: AssetNative, symbol: "HYPE", name: "Hyperliquid", chainName: "hyperliquid"},
		{kind: AssetStablecoin, symbol: "USDT", name: "Tether", chainName: "ethereum",
			providers: []string{"coingecko=tether", "defillama=coingecko:tether", "cryptorank=tether"}},
		{kind: AssetStablecoin, symbol: "USDC", name: "USD Coin", chainName: "ethereum",
			providers: []string{"coingecko=usd-coin", "defillama=coingecko:usd-coin", "cryptorank=usdcoin"}},
		// The unit of account, and the only seeded asset with no home chain.
		{kind: AssetFiat, symbol: "USD", name: "United States Dollar"},
	}
}

// seedTokens: the eleven ERC-20 deployments apps/reconciler's EVM table already
// carries, with decimals and verbatim address casing.
//
// Provenance: apps/reconciler/src/chains.rs EVM[].tokens = (symbol, contract,
// decimals) for Ethereum, BSC, Polygon, Arbitrum, Optimism and Base. These are
// the only full contract addresses anywhere in the tree, which is why the token
// set is exactly this and nothing more: a Solana SPL token could NOT be seeded
// because the sync truncates the mint to its first six characters
// (apps/reconciler/src/streams/sync.rs:193 `let short: String =
// mint.chars().take(6).collect()`), discarding the identity it would need. See
// the UNMAPPED block.
func seedTokens() []seedToken {
	return []seedToken{
		{chainName: "ethereum", symbol: "USDT", assetSym: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6},
		{chainName: "ethereum", symbol: "USDC", assetSym: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6},
		{chainName: "bsc", symbol: "USDT", assetSym: "USDT", address: "0x55d398326f99059ff775485246999027b3197955", decimals: 18},
		{chainName: "bsc", symbol: "USDC", assetSym: "USDC", address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18},
		{chainName: "polygon", symbol: "USDT", assetSym: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6},
		{chainName: "polygon", symbol: "USDC", assetSym: "USDC", address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6},
		{chainName: "arbitrum", symbol: "USDT", assetSym: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6},
		{chainName: "arbitrum", symbol: "USDC", assetSym: "USDC", address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", decimals: 6},
		{chainName: "optimism", symbol: "USDT", assetSym: "USDT", address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6},
		{chainName: "optimism", symbol: "USDC", assetSym: "USDC", address: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607", decimals: 6},
		{chainName: "base", symbol: "USDC", assetSym: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6},
	}
}

// seedVenues: the twelve venue ids the tree uses.
//
// Provenance:
//   - known=true (binance, bybit, mexc): apps/api/internal/accounts/exchange/
//     account.go KnownExchange, mirrored by market_types spot+linear_perp which
//     is the frozen pair this build trades (docs/architecture/current.md).
//   - binance additionally: apps/executor/internal/execution/
//     types.go ExchangeBinance/Bybit/MEXC and the three adapters under
//     apps/executor/internal/exchanges/{binance,bybit,mexc}.
//   - the other eight: apps/web/src/features/ticker/client.ts TICKER_EXCHANGES
//     = ['okx','bybit','bitget','mexc','phemex','bingx','bitfinex','htx',
//     'coinbase','kraken'] - the ccxt venue vocabulary the ticker actually
//     queries. none of them is in KnownExchange, so known=false: the data
//     exists but THIS build may not place an order there. binance is NOT in
//     that list even though the executor trades it, which is exactly the kind of
//     divergence the agreement test in venues_test.go exists to catch.
//   - paper: apps/executor/internal/exchanges/paper/paper.go
//     `const venuePaper execution.ExchangeID = "paper"` - a simulated adapter,
//     not a real venue, so known=false and the name says so.
//   - market_types is set ONLY where the tree asserts it (the three
//     known=true venues); the eight data-only venues get none rather than a
//     guess.
func seedVenues() []seedVenue {
	perps := []MarketType{MarketTypeSpot, MarketTypeLinearPerp}
	return []seedVenue{
		{id: "binance", name: "Binance", kind: VenueCEX, known: true, marketTypes: perps, ccxtID: "binance"},
		{id: "bybit", name: "Bybit", kind: VenueCEX, known: true, marketTypes: perps, ccxtID: "bybit"},
		{id: "mexc", name: "MEXC", kind: VenueCEX, known: true, marketTypes: perps, ccxtID: "mexc"},
		{id: "okx", name: "OKX", kind: VenueCEX, ccxtID: "okx"},
		{id: "bitget", name: "Bitget", kind: VenueCEX, ccxtID: "bitget"},
		{id: "phemex", name: "Phemex", kind: VenueCEX, ccxtID: "phemex"},
		{id: "bingx", name: "BingX", kind: VenueCEX, ccxtID: "bingx"},
		{id: "bitfinex", name: "Bitfinex", kind: VenueCEX, ccxtID: "bitfinex"},
		{id: "htx", name: "HTX", kind: VenueCEX, ccxtID: "htx"},
		{id: "coinbase", name: "Coinbase", kind: VenueCEX, ccxtID: "coinbase"},
		{id: "kraken", name: "Kraken", kind: VenueCEX, ccxtID: "kraken"},
		// Paper has no ccxt id: it is this repo's own simulated adapter.
		{id: "paper", name: "Paper (simulated venue)", kind: VenueCEX, known: false},
	}
}

// VenueIDInvariant is one statement a part of the tree makes about venue ids,
// recorded here so a TEST can prove the registry agrees with it rather than
// relying on a copy-pasted list. Each invariant names where it comes from; if
// that code starts using a venue id this registry does not know, the test fails.
type VenueIDInvariant struct {
	Name     string
	Provider Provider
	VenueIDs []string
	Source   string
}

// VenueIDInvariants are the venue-id vocabularies that exist in the tree today.
// They are deliberately NOT deduplicated into one list: the whole point is that
// several parts of the tree each state their own set, and the registry must
// cover all of them.
func VenueIDInvariants() []VenueIDInvariant {
	return []VenueIDInvariant{
		{
			Name:     "ccxt ticker venue vocabulary",
			Provider: ProviderCCXT,
			VenueIDs: []string{"okx", "bybit", "bitget", "mexc", "phemex", "bingx", "bitfinex", "htx", "coinbase", "kraken"},
			Source:   "apps/web/src/features/ticker/client.ts TICKER_EXCHANGES",
		},
		{
			Name:     "executor adapter vocabulary",
			Provider: ProviderInternal,
			VenueIDs: []string{"binance", "bybit", "mexc", "paper"},
			Source:   "apps/executor/internal/execution/types.go ExchangeID constants + apps/executor/internal/exchanges/paper/paper.go venuePaper",
		},
		{
			Name:     "apps/api supported venue allowlist",
			Provider: ProviderInternal,
			VenueIDs: []string{"binance", "bybit", "mexc"},
			Source:   "apps/api/internal/accounts/exchange/account.go KnownExchange",
		},
	}
}

// providerValue splits a flattened "provider=value" seed pair.
func providerValue(s string) (Provider, string, error) {
	if i := strings.IndexByte(s, '='); i >= 0 {
		return Provider(s[:i]), s[i+1:], nil
	}
	return "", "", fmt.Errorf("%w: malformed provider pair %q", ErrInvalidSeed, s)
}

// UNMAPPED - every reference the tree does not assert, recorded so an omission
// is visible instead of being mistaken for completeness.
//
//  1. Solana SPL tokens (none seeded). The sync truncates the mint to six
//     characters before it builds the row label, so the FULL mint never reaches
//     any durable place in this tree (apps/reconciler/src/streams/sync.rs:171-196).
//     A token id MUST be (chain, full address), so there is nothing to seed: the
//     live value is recoverable only by querying the chain, and inventing an
//     address would be a fabrication.
//  2. HYPE provider ids (none). Hyperliquid positions are read but never priced
//     by the sync, so no provider slug for the asset exists in the tree.
//  3. chain_numeric_id for every chain (all nil). No EVM chain id appears
//     anywhere in apps/, database or tests/.
//  4. Venue URLs (all nil) and venue display names beyond the conventional
//     capitalization: no venue metadata table exists.
//  5. market_types for the eight data-only venues (all nil): TICKER_VENUES
//     states which market types each ccxt venue serves
//     (apps/web/src/features/ticker/client.ts:103), but that is ccxt's
//     per-venue product support rather than this build's instrument model, and
//     the venue contract's description ties the field to
//     KnownExchange + instrument market types. Left out rather than
//     reinterpreted.
//  6. Hyperliquid and offchain chain provider ids (none): neither appears in
//     LLAMA_IDS and Hyperliquid has no CryptoRank chain row in the recorded
//     fixture.
//  7. Every CryptoRank coin key beyond the eight seeded assets (none): the
//     fixture holds 100+ rows and the converter body holds 5034, but only the
//     assets the tree actually names are registry members; the rest are
//     provider rows (research/coin.json), not canonical entities.
func Unmapped() []string {
	return []string{
		"solana SPL tokens (full mint not derivable: apps/reconciler/src/streams/sync.rs truncates the mint to 6 chars)",
		"HYPE provider ids (Hyperliquid balances are read but never priced: no slug in the tree)",
		"chain_numeric_id for all chains (no EVM chain id exists anywhere in the tree)",
		"venue URLs and non-conventional display names (no venue metadata table exists)",
		"market_types for the eight data-only ccxt venues (TICKER_VENUES is ccxt product support, not this build's instrument model)",
		"hyperliquid/offchain chain provider ids (absent from LLAMA_IDS; no CryptoRank chain row)",
		"CryptoRank coin keys beyond the eight seeded assets (provider rows, not canonical entities)",
	}
}

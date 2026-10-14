package canon

import "time"

// This file completes the DEX canonical entity set: routing, risk, MEV,
// perps, wallets, LP positions and pool orderbooks. Same layer and numeric
// discipline as dex_types.go / dex_trading.go (no float64, exact decimals).

// --- routing (plan §4 "Routing", §21) ---------------------------------------

// LiquiditySource names one venue a route leg draws from: the pool (or venue)
// that supplies the liquidity, and the canonical ids needed to price it. It is
// the join between a quoted route and the pool/liquidity tables.
type LiquiditySource struct {
	// PoolID is the canonical pool the leg trades against ("" when the router
	// names only a venue).
	PoolID string `json:"pool_id,omitempty"`
	// VenueID is the canonical venue id (the DEX protocol deployment).
	VenueID string `json:"venue_id,omitempty"`
	// ProtocolID is the canonical protocol id when the router names a protocol
	// without a specific pool.
	ProtocolID string `json:"protocol_id,omitempty"`
	// ChainID is the chain the source lives on.
	ChainID string `json:"chain_id"`
	// FeeBps is the source's fee in basis points, when the router reports one.
	FeeBps *int `json:"fee_bps,omitempty"`
}

// RouteLeg is one hop of a RouteQuote: swap TokenIn -> TokenOut against
// Sources. A multi-hop route has several legs; a split route has several legs
// on the SAME pair against different sources.
type RouteLeg struct {
	Index     int         `json:"index"`
	TokenIn   string      `json:"token_in"`
	TokenOut  string      `json:"token_out"`
	AmountIn  TokenAmount `json:"amount_in"`
	AmountOut TokenAmount `json:"amount_out"`
	// Sources is the set of liquidity sources this leg draws from.
	Sources []LiquiditySource `json:"sources,omitempty"`
	// PriceImpactPct is the leg's price impact as a signed percentage, exact.
	PriceImpactPct *Dec `json:"price_impact_pct,omitempty"`
}

// RouteQuote is one router's quote for swapping InAmount of InToken for
// OutToken (plan §4 "Routing", §21). It is provider-scoped (the router is part
// of the identity: two routers quoting the same pair are two rows), which is
// what makes "best execution" a comparison rather than an overwrite.
type RouteQuote struct {
	QuoteID string `json:"quote_id"`
	// NaturalKey is the RouteQuoteKey spelling the id was minted from.
	NaturalKey string      `json:"natural_key"`
	Provider   string      `json:"provider"`
	ChainID    string      `json:"chain_id"`
	TokenIn    string      `json:"token_in"`
	TokenOut   string      `json:"token_out"`
	AmountIn   TokenAmount `json:"amount_in"`
	// AmountOut is the router's expected output, exact.
	AmountOut TokenAmount `json:"amount_out"`
	// Legs is the route the router chose; a single-hop swap has one leg.
	Legs []RouteLeg `json:"legs,omitempty"`
	// ExpectedOutputUSD / GasUSD are the router's USD estimates, when given.
	ExpectedOutputUSD *Dec `json:"expected_output_usd,omitempty"`
	GasUSD            *Dec `json:"gas_estimate_usd,omitempty"`
	// GasEstimate is the router's gas estimate in wei, exact.
	GasEstimate *TokenAmount `json:"gas_estimate,omitempty"`
	// PriceImpactPct and SlippagePct are the route-level percentages, exact.
	PriceImpactPct *Dec `json:"price_impact_pct,omitempty"`
	SlippagePct    *Dec `json:"slippage_pct,omitempty"`
	// QuotedAt is when the router produced the quote (it decays).
	QuotedAt   time.Time  `json:"quoted_at"`
	Provenance Provenance `json:"provenance"`
}

// --- risk + MEV (plan §4 "Risk", "MEV") -------------------------------------

// RiskMetric is one named risk score about one subject under one algorithm
// version (plan §4 "Risk", §26). Versioning rides in the natural key, so a
// changed algorithm mints a NEW series rather than silently rewriting history.
type RiskMetric struct {
	RiskID string `json:"risk_id"`
	// NaturalKey is the RiskMetricKey spelling the id was minted from.
	NaturalKey string `json:"natural_key"`
	// SubjectKey names what the risk is about: a pool id, a token id, or a
	// chain name (matching the SeriesKey subject convention).
	SubjectKey string    `json:"subject_key"`
	Metric     string    `json:"metric"`
	At         time.Time `json:"at"`
	// Score is the metric's value; its scale is the metric's contract (a
	// [0,1] probability, a 0-100 score, a ratio). Dec, never float.
	Score Dec `json:"score"`
	// Band is the human-readable classification the algorithm assigned
	// ("low" | "medium" | "high" | ...), when it produces one.
	Band string `json:"band,omitempty"`
	// AlgorithmVersion is the plan §26 version; it is also in the natural key.
	AlgorithmVersion string `json:"algorithm_version"`
	// InputSources lists the canonical values the score was computed from.
	InputSources []string   `json:"input_sources,omitempty"`
	Provenance   Provenance `json:"provenance"`
}

// MEVEvent is one classified maximal-extractable-value event (plan §4 "MEV",
// §26 Group C): a sandwich, an arbitrage bundle, a backrun. Keyed by
// (chain, tx_hash) so a transaction is classified once.
type MEVEvent struct {
	MEVID string `json:"mev_id"`
	// NaturalKey is the MEVEventKey spelling the id was minted from.
	NaturalKey string `json:"natural_key"`
	ChainID    string `json:"chain_id"`
	TxHash     string `json:"tx_hash"`
	// BlockNumber is the block the event landed in.
	BlockNumber *int64 `json:"block_number,omitempty"`
	// Kind is the event class: "sandwich" | "arbitrage" | "backrun" |
	// "liquidation" | "jit" | "unknown".
	Kind string `json:"kind"`
	// PoolID is the pool the event acted on, when it is pool-local.
	PoolID string `json:"pool_id,omitempty"`
	// Victim is the wallet that lost value in a sandwich; empty otherwise.
	Victim string `json:"victim,omitempty"`
	// Attacker is the wallet that captured the value; empty when unknown.
	Attacker string `json:"attacker,omitempty"`
	// ProfitUSD / ProfitToken are the extractable profit, exact; either may be
	// absent when the classifier cannot price it.
	ProfitUSD   *Dec         `json:"profit_usd,omitempty"`
	ProfitToken *TokenAmount `json:"profit_token,omitempty"`
	EventTime   time.Time    `json:"event_time"`
	Provenance  Provenance   `json:"provenance"`
}

// --- perps (plan §4 "Perpetual", "Funding", "Liquidation") ------------------

// PerpMarket is one perpetual-futures market on one venue (plan §4). It is a
// DEX/CEX derivative venue's market - distinct from a spot Instrument - so it
// gets its own namespace and its own row.
type PerpMarket struct {
	PerpMarketID string `json:"perp_market_id"`
	// NaturalKey is the PerpMarketKey spelling the id was minted from.
	NaturalKey string `json:"natural_key"`
	VenueID    string `json:"venue_id"`
	// MarketType is "linear_perp" | "inverse_perp" | "linear_future" | ...
	MarketType   string  `json:"market_type"`
	BaseAssetID  *string `json:"base_asset_id,omitempty"`
	QuoteAssetID *string `json:"quote_asset_id,omitempty"`
	BaseSymbol   string  `json:"base_symbol"`
	QuoteSymbol  string  `json:"quote_symbol"`
	// IndexPrice / MarkPrice are the current prices, exact, when reported.
	IndexPrice *Dec `json:"index_price,omitempty"`
	MarkPrice  *Dec `json:"mark_price,omitempty"`
	// OpenInterestUSD / OpenInterestBase are the current open interest.
	OpenInterestUSD  *TokenAmount `json:"open_interest_usd,omitempty"`
	OpenInterestBase *Dec         `json:"open_interest_base,omitempty"`
	// FundingRate is the current funding rate as an exact ratio (0.0001 =
	// 0.01%), when reported.
	FundingRate *Dec `json:"funding_rate,omitempty"`
	// MaxLeverage is the venue's maximum leverage as an exact multiple.
	MaxLeverage *Dec       `json:"max_leverage,omitempty"`
	At          time.Time  `json:"at"`
	Provenance  Provenance `json:"provenance"`
}

// FundingSnapshot is one funding settlement (or prediction) for one perpetual
// (plan §4 "Funding"). It is the DEX/perp counterpart of the existing
// instrument-keyed FundingRate, kept separate so a perp market's funding is not
// confused with a venue-instrument's.
type FundingSnapshot struct {
	PerpMarketID string    `json:"perp_market_id"`
	VenueID      string    `json:"venue_id"`
	FundingTime  time.Time `json:"funding_time"`
	// Rate is the funding rate as an exact ratio.
	Rate Dec `json:"rate"`
	// Cap is the venue's funding-rate cap, when reported.
	Cap *Dec `json:"cap,omitempty"`
	// Predicted marks a forecast (the next settlement) vs a settled value.
	Predicted  bool       `json:"predicted"`
	Provenance Provenance `json:"provenance"`
}

// PerpLiquidation is one liquidation event on a perpetual market (plan §4
// "Liquidation"). Distinct from the instrument-keyed Liquidation because it
// names a perp market, carries a position side and (when known) the liquidated
// wallet.
type PerpLiquidation struct {
	VenueID      string    `json:"venue_id"`
	PerpMarketID string    `json:"perp_market_id"`
	At           time.Time `json:"at"`
	// Side is the liquidated position's side: "long" | "short" | "".
	Side string `json:"side,omitempty"`
	// Price / Quantity are the liquidation price and size, exact.
	Price    Dec         `json:"price"`
	Quantity TokenAmount `json:"quantity"`
	// ValueUSD is the liquidated notional, when reported.
	ValueUSD *Dec `json:"value_usd,omitempty"`
	// Wallet is the liquidated account, when named.
	Wallet string `json:"wallet,omitempty"`
	// TxHash is the on-chain transaction for a DEX liquidation.
	TxHash     string     `json:"tx_hash,omitempty"`
	Provenance Provenance `json:"provenance"`
}

// --- wallets + LP positions (plan §4 "Trader", "LP") ------------------------

// WalletActivity is one wallet event observed by one provider (plan §4
// "Trader"). It is keyed by the provider's own event id (same shape as an
// Article) because no cross-provider wallet-event identity exists.
type WalletActivity struct {
	ActivityID string `json:"activity_id"`
	// NaturalKey is the WalletActivityKey spelling the id was minted from.
	NaturalKey string `json:"natural_key"`
	Provider   string `json:"provider"`
	ChainID    string `json:"chain_id"`
	Wallet     string `json:"wallet"`
	// Kind is the activity class: "swap" | "add_liquidity" |
	// "remove_liquidity" | "transfer_in" | "transfer_out" | "claim" | ...
	Kind string `json:"kind"`
	// PoolID / TokenID name what the activity touched (either may be empty).
	PoolID  string `json:"pool_id,omitempty"`
	TokenID string `json:"token_id,omitempty"`
	// Amount is the moved amount, exact, when applicable.
	Amount *TokenAmount `json:"amount,omitempty"`
	// ValueUSD is the USD value, when reported.
	ValueUSD *Dec `json:"value_usd,omitempty"`
	// TxHash is the transaction, when the activity is on-chain.
	TxHash string `json:"tx_hash,omitempty"`
	// Counterparty is the other wallet in a transfer, when named.
	Counterparty string     `json:"counterparty,omitempty"`
	EventTime    time.Time  `json:"event_time"`
	Provenance   Provenance `json:"provenance"`
}

// DexLiquidityPosition is one owner's position in one pool (plan §4 "LP"). It
// is keyed by (pool, owner): a position is per-owner per-pool, never per token.
// The position's constituent amounts and the tick range make it a
// concentrated-liquidity-aware record.
type DexLiquidityPosition struct {
	PositionID string `json:"position_id"`
	// NaturalKey is the LiquidityPositionKey spelling the id was minted from.
	NaturalKey string `json:"natural_key"`
	PoolID     string `json:"pool_id"`
	ChainID    string `json:"chain_id"`
	Owner      string `json:"owner"`
	// TokenID is the LP token the position is represented by, when there is
	// one (a fungible LP share); empty for an NFT position.
	TokenID string `json:"token_id,omitempty"`
	// NFTTokenID is the position NFT's id for a concentrated-liquidity
	// position (Uniswap v3 / Orca Whirlpool); nil for fungible LP.
	NFTTokenID *string `json:"nft_token_id,omitempty"`
	// Amounts is the position's per-token amounts at this snapshot.
	Amounts []PoolToken `json:"amounts,omitempty"`
	// TickLower / TickUpper bound a concentrated-liquidity position.
	TickLower *int `json:"tick_lower,omitempty"`
	TickUpper *int `json:"tick_upper,omitempty"`
	// Liquidity is the position's concentrated-liquidity L value, exact.
	Liquidity *Dec `json:"liquidity,omitempty"`
	// ValueUSD is the position's USD value, when reported.
	ValueUSD   *Dec       `json:"value_usd,omitempty"`
	At         time.Time  `json:"at"`
	Provenance Provenance `json:"provenance"`
}

// --- orderbook (plan §4 "Orderbook") ----------------------------------------

// DexOrderbookSnapshot is one depth snapshot for one pool, for the DEX venues
// that expose an on-chain orderbook (Phoenix, OpenBook). Both sides are
// price/size pairs as exact decimals, so a depth-derived metric never touches a
// float.
type DexOrderbookSnapshot struct {
	SnapshotID string    `json:"snapshot_id"`
	NaturalKey string    `json:"natural_key"`
	PoolID     string    `json:"pool_id"`
	ChainID    string    `json:"chain_id"`
	At         time.Time `json:"at"`
	// Depth is the number of levels each side holds.
	Depth      int              `json:"depth"`
	Bids       []OrderbookLevel `json:"bids,omitempty"`
	Asks       []OrderbookLevel `json:"asks,omitempty"`
	Provenance Provenance       `json:"provenance"`
}

// OrderbookLevel is one price/size level, both exact decimals.
type OrderbookLevel struct {
	Price Dec `json:"price"`
	Size  Dec `json:"size"`
}

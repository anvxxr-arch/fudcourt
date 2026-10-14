package canon

import "time"

// This file is the DEX trading-venue canonical types: the pool-keyed facts
// (swaps, candles, liquidity and market snapshots). It is the second half of
// dex_types.go and follows the same layer and numeric discipline.

// Swap is one executed trade on one pool (plan §4 "Transaction"). It is
// POOL-keyed, not instrument+venue-keyed like Trade, because a DEX swap happens
// on a specific pool and the plan's §15 idempotency key is
// (chain, tx_hash, log_index) - which Trade cannot express.
//
// AmountIn/AmountOut are exact TokenAmounts; the pool's price IMPLIED by the
// swap is derivable and deliberately NOT stored here (a stored price would be a
// second source of truth for a number the amounts already determine).
type Swap struct {
	SwapID string `json:"swap_id"`
	// NaturalKey is the SwapKey spelling the id was minted from.
	NaturalKey string `json:"natural_key"`
	PoolID     string `json:"pool_id"`
	ChainID    string `json:"chain_id"`
	// TxHash and LogIndex are the plan §15 identity: one tx may contain many
	// swaps, so the index disambiguates them.
	TxHash   string `json:"tx_hash"`
	LogIndex int    `json:"log_index"`
	// BlockNumber is the block the swap landed in; nil when the provider does
	// not report one (a REST aggregator often does not).
	BlockNumber *int64 `json:"block_number,omitempty"`
	// Trader is the initiating wallet address, verbatim; empty when an
	// aggregator hides it.
	Trader string `json:"trader,omitempty"`
	// TxIndex is the swap's position within its block, when known. Together
	// with LogIndex it orders the swaps of one block deterministically.
	TxIndex *int `json:"tx_index,omitempty"`
	// TokenIn/TokenOut are the canonical token ids; AmountIn/AmountOut the
	// exact amounts moved.
	TokenIn   string      `json:"token_in"`
	TokenOut  string      `json:"token_out"`
	AmountIn  TokenAmount `json:"amount_in"`
	AmountOut TokenAmount `json:"amount_out"`
	// AmountUSD is the swap's USD value when the provider reports one (nil
	// otherwise; never derived here, never faked).
	AmountUSD *Dec `json:"amount_usd,omitempty"`
	// Side is the taker direction relative to the pool's base token:
	// "buy" | "sell" | "" (unknown).
	Side string `json:"side,omitempty"`
	// EventTime is the block/event time the swap happened at.
	EventTime time.Time `json:"event_time"`
	// Sender is the router/aggregator that submitted the swap, when it differs
	// from the EOA trader.
	Sender     string     `json:"sender,omitempty"`
	Provenance Provenance `json:"provenance"`
}

// DexCandle is one OHLCV bar for one POOL at one interval (plan §4 "Price
// history"). It is pool-keyed, not instrument+venue-keyed like Ohlcv: a DEX
// candle belongs to a liquidity pool, and the plan's §15 key is
// (pool, interval, open_timestamp). O/H/L/C/Volume are exact decimals.
type DexCandle struct {
	CandleID string `json:"candle_id"`
	// NaturalKey is the CandleKey spelling the id was minted from.
	NaturalKey string `json:"natural_key"`
	PoolID     string `json:"pool_id"`
	ChainID    string `json:"chain_id"`
	// Interval is a canon timeframe spelling (1m, 5m, 15m, 1h, 4h, 1d, 1w).
	Interval  string    `json:"interval"`
	OpenTime  time.Time `json:"open_time"`
	CloseTime time.Time `json:"close_time"`
	Open      Dec       `json:"open"`
	High      Dec       `json:"high"`
	Low       Dec       `json:"low"`
	Close     Dec       `json:"close"`
	// VolumeBase / VolumeQuote are the two sides' traded volume; either may be
	// absent when the provider reports only one.
	VolumeBase  *Dec `json:"volume_base,omitempty"`
	VolumeQuote *Dec `json:"volume_quote,omitempty"`
	// VolumeUSD is the USD volume when the provider reports one.
	VolumeUSD *Dec `json:"volume_usd,omitempty"`
	// TradeCount is the number of swaps in the bar; nil when unreported.
	TradeCount *int64 `json:"trade_count,omitempty"`
	// VWAP is the bar's volume-weighted average price, when reported.
	VWAP       *Dec       `json:"vwap,omitempty"`
	Provenance Provenance `json:"provenance"`
}

// DexLiquiditySnapshot is one pool's liquidity state at one instant (plan §4
// "Liquidity"): the reserves and the USD valuation, when the provider reports
// them. It is the fact behind the liquidity time series and the input to
// depth/impact derived metrics.
type DexLiquiditySnapshot struct {
	SnapshotID string `json:"snapshot_id"`
	// NaturalKey is the LiquiditySnapshotKey spelling the id was minted from.
	NaturalKey string    `json:"natural_key"`
	PoolID     string    `json:"pool_id"`
	ChainID    string    `json:"chain_id"`
	At         time.Time `json:"at"`
	// Reserves is the pool's per-token reserves at this instant, exact.
	Reserves []PoolToken `json:"reserves,omitempty"`
	// LiquidityUSD is the pool's total liquidity value in USD, when reported.
	LiquidityUSD *Dec `json:"liquidity_usd,omitempty"`
	// Tick is the current tick for a concentrated-liquidity pool (nil
	// otherwise); TickLower/TickUpper the active range bounds.
	Tick      *int `json:"tick,omitempty"`
	TickLower *int `json:"tick_lower,omitempty"`
	TickUpper *int `json:"tick_upper,omitempty"`
	// ActiveLiquidity is the concentrated-liquidity amount in range (the L
	// value), exact; nil for a full-range AMM.
	ActiveLiquidity *Dec       `json:"active_liquidity,omitempty"`
	Provenance      Provenance `json:"provenance"`
}

// DexMarketSnapshot is one pool's market state at one instant (plan §4 "Market
// state"): the price, 24h volume and fee tier a board renders. It is separate
// from DexLiquiditySnapshot because price/volume and reserves come from
// different providers at different cadences and must not overwrite each other.
type DexMarketSnapshot struct {
	SnapshotID string `json:"snapshot_id"`
	// NaturalKey is the MarketSnapshotKey spelling the id was minted from.
	NaturalKey string    `json:"natural_key"`
	PoolID     string    `json:"pool_id"`
	ChainID    string    `json:"chain_id"`
	At         time.Time `json:"at"`
	// PriceUSD / PriceNative are the pool's price; either may be absent.
	PriceUSD    *Dec `json:"price_usd,omitempty"`
	PriceNative *Dec `json:"price_native,omitempty"`
	// Volume24hUSD and the transaction counts the provider reports.
	Volume24hUSD *Dec   `json:"volume_24h_usd,omitempty"`
	Txns24h      *int64 `json:"txns_24h,omitempty"`
	Buys24h      *int64 `json:"buys_24h,omitempty"`
	Sells24h     *int64 `json:"sells_24h,omitempty"`
	// PriceChangePct24h is a percentage in [0,100]-style spelling (a signed
	// percentage point value, e.g. "-3.25"), exact.
	PriceChangePct24h *Dec `json:"price_change_pct_24h,omitempty"`
	FDVUSD            *Dec `json:"fdv_usd,omitempty"`
	MarketCapUSD      *Dec `json:"market_cap_usd,omitempty"`
	// FeeTierBps is the pool's fee tier in basis points, when the pool is a
	// fixed-fee AMM (a dynamic-fee pool reports the CURRENT fee instead).
	FeeTierBps *int       `json:"fee_tier_bps,omitempty"`
	Provenance Provenance `json:"provenance"`
}

// Package evmrpc is the raw EVM JSON-RPC provider adapter: chain state read
// straight from a node, with no aggregator in between.
//
// It is the S0 tier of the source hierarchy - the ground truth every other tier
// is ultimately checked against. Nothing here is derived, aggregated or
// estimated: a block header is the node's own answer to eth_getBlockByNumber.
//
// # Scope
//
// This package owns the RPC TRANSPORT and the raw-chain FACTS that ride on it.
// The split is deliberate and is the plan's §16 rule: the transport must not
// know what a swap is. The event decoders (decodeV2Swap, decodeV3Swap,
// decodeV2PairCreated, decodeV3PoolCreated) are pure functions over a decoded
// log - they hold no client, perform no I/O and mint no id - so a DEX-specific
// dataset can be layered on the same transport without reopening it.
//
// # Credentials
//
// Endpoints come from the tree's EXISTING chain-access credential: ALCHEMY_KEY,
// expanded per chain as https://<host>/v2/<KEY>, exactly as
// apps/reconciler/src/streams/sync.rs does it. The chain map mirrors
// apps/reconciler/src/chains.rs. A per-chain EVM_RPC_URL_<CHAIN> overrides the
// shared key for a self-hosted node or another provider.
//
// A missing endpoint is a loud no-credentials failure naming the variable - it
// never becomes an empty successful result, because "the chain said nothing"
// and "we never asked" must not look the same in the journal.
//
// # Never fake a number
//
// Absent upstream facts stay absent. A pre-EIP-1559 header has no
// baseFeePerGas, so the base-fee observation is not written at all rather than
// written as 0; a truncated log body is a shape error rather than a zero-padded
// amount. Every value the adapter stores is a value the node actually returned.
//
// # What this package does NOT do
//
// It mints no swap, pool or token id and writes no DEX entity. Those depend on
// the canonical id contract, which is owned elsewhere (see the DexSwap and
// DexPool contracts). The datasets here write only chain-level series
// (block height, base fee, gas utilisation) under series/blockchain/... .
//
// The log decoders exist and are tested against real mainnet payloads, but the
// dataset that would consume them is NOT registered: raw logs have no landing
// table in data-schema.sql yet, and writing a swap into data.trade would be
// wrong rather than merely incomplete - data.trade's natural key is the
// CEX-shaped (venue, instrument, provider_trade_id, trade_time), which cannot
// hold (chain, tx_hash, log_index) without discarding the on-chain identity.
// Adding that landing table is a schema decision, and it is the next step for
// this package.
package evmrpc

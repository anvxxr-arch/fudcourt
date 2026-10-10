// Package blockscout is the Blockscout provider adapter: canonical ingest
// jobs for chain stats from self-hostable Blockscout instances (keyless - no
// API key, no credentials).
//
// Endpoints (public, keyless, one stats endpoint per configured instance):
//
//	stats  GET https://eth.blockscout.com/api/v2/stats
//	       GET https://polygon.blockscout.com/api/v2/stats
//
// Wire shape (real, both instances): {"total_blocks":"26156417",
// "total_addresses":"738505157","total_transactions":"3793417199",
// "average_block_time":12000.0,"gas_prices":{"slow":0.57,"average":0.9,
// "fast":2.4},"gas_used_today":"216713915844",...} - counters as decimal
// strings, block time in MILLISECONDS, gas prices as JSON numbers in gwei.
// Blockscout v2 signals failures with HTTP statuses, not envelopes.
//
// The stats snapshot becomes one MetricPoint per metric on series
// series/blockchain/<metric>/chain:<chain_id> (domain blockchain, provider
// blockscout). Every fetch is ONE attempt: the engine owns retries; a
// transport/shape failure here is a typed HardError and nothing is written.
package blockscout

// Package mempool is the mempool.space provider adapter: keyless Bitcoin
// network data (hashrate, difficulty, per-block rewards and fees). The wire
// shapes are heterogeneous — hashrate is an object with daily rows, difficulty
// adjustments are array-of-arrays, and blocks/rewards|fees are PER-BLOCK rows
// that the adapter buckets to UTC days. Every fetch is ONE attempt: the engine
// owns retries; a transport/shape failure here is a typed HardError and nothing
// is written.
package mempool

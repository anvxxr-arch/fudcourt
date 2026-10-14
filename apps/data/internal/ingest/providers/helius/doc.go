// Package helius is the Helius provider adapter: a keyed Solana adapter
// (plan §19 priority, Tier S2) that turns Helius enhanced transactions into
// canonical DEX swaps and wallet activity.
//
// Endpoints (require an API key; no keyless fallback):
//
//	swaps   GET https://api.helius.xyz/v0/addresses/{address}/transactions?api-key=…&type=SWAP[&before=…]
//	wallet  GET https://api.helius.xyz/v0/addresses/{address}/transactions?api-key=…[&before=…]
//
// Keys are read once at module construction from HELIUS_API_KEYS (a
// comma-separated list) and HELIUS_API_KEY (the single-key spelling); requests
// round-robin across the configured keys so a burst of pages spreads over
// several rate limits instead of draining one, and a retry after a 429 lands on
// the next key. With no key at all, Fetch returns a no-credentials HardError
// without touching the network and Jobs seeds the jobs disabled. Every URL
// stored on an error passes through redact first, so no key ever reaches a
// journal, a log line or a test failure message.
//
// Wire shape (real, trimmed): [{"signature":"…","slot":250000000,
// "timestamp":1700000000,"type":"SWAP","source":"RAYDIUM",
// "feePayer":"…","events":{"swap":{"tokenInputs":[{"mint":"…",
// "rawTokenAmount":{"tokenAmount":"1000000","decimals":6}}],
// "tokenOutputs":[...],"nativeInput":{"account":"…","amount":"500000"}}}}].
// Note nativeInput/nativeOutput: a Solana swap usually has ONE token side and
// ONE native SOL side, not two token sides, so an adapter that ignores the
// native side rejects the majority of real swaps. Every body decodes with
// UseNumber and every amount stays an exact canon.TokenAmount; no value in this
// package ever passes through a float64.
//
// Mapping: one events.swap becomes one canon.Swap, pool-anchored on the
// watched subject address, with the log index carrying the swap event's
// index within the transaction (the Solana instruction index — Solana has
// no EVM log index). One transaction of any type becomes one
// canon.WalletActivity whose kind is the lowercased Helius type. Both
// datasets page backward through the address history on cursor
// {"before": signature} (Mode backfill). Swaps and activity write through
// the DEX writer the module is constructed with; chains and venues still
// upsert through the engine writer. Every fetch is ONE attempt: the engine
// owns retries; a transport/shape failure here is a typed HardError and
// nothing is written.
package helius

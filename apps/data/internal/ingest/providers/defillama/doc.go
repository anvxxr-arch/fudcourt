// Package defillama is the DefiLlama provider adapter: canonical ingest jobs
// for protocol TVL, chain TVL and per-protocol TVL history, and the upserts
// the first rows of each fetch imply (protocols, chains).
//
// Endpoints (public, keyless):
//
//	protocols        GET https://api.llama.fi/protocols
//	chains           GET https://api.llama.fi/v2/chains
//	protocolHistory  GET https://api.llama.fi/protocol/{slug}
//
// Wire shapes are plain JSON (no error envelope): a top-level array of
// protocol rows, an array of chain rows (cmcId a quoted string, absent on
// gecko-only rows), and a history object
// {"tvl":[{"date":1707163200,"totalLiquidityUSD":1234.5},...]} (date is
// UNIX SECONDS here, unlike the ms stamps elsewhere). Non-2xx is a HardError.
// Every fetch is ONE attempt: the engine owns retries; a transport/shape
// failure here is a typed HardError and nothing is written.
package defillama

// Package etherscan is the Etherscan provider adapter: canonical ingest jobs
// for native-coin supply and gas-price snapshots across the Etherscan v2
// multi-chain API.
//
// Endpoint (one host, chain-scoped by the chainid query parameter; every call
// REQUIRES an API key - there is no keyless fallback):
//
//	supply  GET https://api.etherscan.io/v2/api?chainid={id}&module=stats&action=ethsupply
//	gas     GET https://api.etherscan.io/v2/api?chainid={id}&module=gastracker&action=gasoracle
//
// The key is read once at module construction from ETHERSCAN_API_KEY. With no
// key, Fetch returns a no-credentials HardError without touching the network
// and the seed jobs register disabled; with a key the jobs register enabled.
// The key never appears in an error: HardError URLs are redacted.
//
// Wire shapes are the classic Etherscan envelope {"status":"1","message":"OK",
// "result":...} where result is a wei string (supply) or an object of decimal
// strings (gas oracle); failures arrive as {"status":"0","message":"NOTOK",
// "result":"..."} on any HTTP status. Every fetch is ONE attempt: the engine
// owns retries; a transport/shape failure here is a typed HardError and
// nothing is written.
package etherscan

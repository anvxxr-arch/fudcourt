// Package geckoterminal is the GeckoTerminal provider adapter: DEX pool
// snapshots for configured network:pool_address subjects, and the entity
// upserts the rows imply (chains, DEX venues, pool-side assets).
//
// Endpoint (public, keyless):
//
//	pool  GET https://api.geckoterminal.com/api/v2/networks/{network}/pools/{pool_address}
//	      ?include=base_token,quote_token
//
// Wire shape: a JSON-API document — {"data":{"attributes":{...},
// "relationships":{...}},"included":[token,...]}. Numerics arrive as strings
// ("reserve_in_usd":"9435637.1372"); timestamps are RFC3339. The network
// slugs are GeckoTerminal's own ("eth", "solana", ...): they are NOT the
// dexscreener spellings, so the adapter maps the ones it seeds to the
// canonical chain names and passes the rest through lowercased. The DEX id
// comes from relationships.dex ("uniswap_v3"); a pool without one records
// venue "geckoterminal".
//
// A pool row is a point-in-time snapshot: At is the fetch time, and fields
// the endpoint omits stay nil (never-fake).
package geckoterminal

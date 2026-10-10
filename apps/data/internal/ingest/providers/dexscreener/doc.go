// Package dexscreener is the DexScreener provider adapter: DEX pool
// snapshots for configured token/pair subjects, and the entity upserts the
// rows imply (chains, DEX venues, pools).
//
// Endpoints (public, keyless):
//
//	tokenPairs  GET https://api.dexscreener.com/token-pairs/v1/{chainId}/{tokenAddress}
//	pair        GET https://api.dexscreener.com/latest/dex/pairs/{chainId}/{pairAddress}
//	search      GET https://api.dexscreener.com/latest/dex/search?q={query}
//
// chainId is the slug the tree canonicalizes on ("ethereum", "solana"), so
// canon.ChainKey maps it 1:1. Wire shape: a JSON array of pair objects (the
// pair and search endpoints wrap theirs in {"pairs":[...]}); every numeric
// the adapter reads may arrive as number or string, and pairAddress on
// multi-token pools can be a hyphen-joined composite — the verbatim string
// is the pool identity (canon.PoolKey), never parsed.
//
// A pool row is a point-in-time snapshot: At is the fetch time, and prices
// the endpoint omits stay nil (never-fake).
package dexscreener

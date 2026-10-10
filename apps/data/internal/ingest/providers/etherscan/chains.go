package etherscan

import "net/url"

// chains is the adapter's chain map: the Etherscan v2 chainid -> the chain's
// canonical lowercase name (the ChainKey input). The task pins six chains;
// gasoracle is only served for the chains Etherscan's free plan covers
// (ethereum, bsc, polygon), so those are the only gas jobs seeded.
var chains = map[string]string{
	"1":     "ethereum",
	"56":    "bsc",
	"137":   "polygon",
	"42161": "arbitrum",
	"10":    "optimism",
	"8453":  "base",
}

// chainID resolves a canonical chain name to its Etherscan chainid.
func chainID(name string) (string, bool) {
	for id, n := range chains {
		if n == name {
			return id, true
		}
	}
	return "", false
}

// supplyURL builds the ethsupply request for one chainid. The apikey parameter
// carries the key; redact strips it before any URL is stored on an error.
func (c *client) supplyURL(chainid string) string {
	return Base + "?chainid=" + chainid + "&module=stats&action=ethsupply&apikey=" + url.QueryEscape(c.apiKey)
}

// gasURL builds the gasoracle request for one chainid.
func (c *client) gasURL(chainid string) string {
	return Base + "?chainid=" + chainid + "&module=gastracker&action=gasoracle&apikey=" + url.QueryEscape(c.apiKey)
}

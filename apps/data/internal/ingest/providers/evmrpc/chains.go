package evmrpc

import (
	"net/url"
	"os"
	"strings"
)

// chain is one chain's RPC binding: the canonical lowercase name (the ChainKey
// input), the EIP-155 numeric chain id, the default Alchemy host, and the
// environment variable that can override it.
//
// The SET and the NAMES are not this adapter's invention. They mirror
// apps/reconciler/src/chains.rs (the tree's existing EVM chain registry) and the
// etherscan adapter's chain map one-for-one, so all three mint the SAME chain id
// for the same chain. A chain absent here has no canonical identity yet, and
// adding one is a contract change, not an adapter-local choice: an invented name
// (say "binance-smart-chain" for what the rest of the tree calls "bsc") would
// mint a second chain id for one chain, which is the exact duplication the
// canonical-id rule exists to prevent.
type chain struct {
	Name    string
	ChainID string
	// Host is the Alchemy endpoint host. The full URL is
	// https://<host>/v2/<ALCHEMY_KEY> - the same expansion the reconciler's
	// streams/sync.rs performs.
	Host string
	// OverrideEnv names the variable holding an explicit endpoint for this
	// chain, for a self-hosted node or a non-Alchemy provider. It takes
	// precedence over the shared key.
	OverrideEnv string
}

// chains is the adapter's chain map, aligned with apps/reconciler/src/chains.rs.
var chains = []chain{
	{"ethereum", "1", "eth-mainnet.g.alchemy.com", "EVM_RPC_URL_ETHEREUM"},
	{"bsc", "56", "bnb-mainnet.g.alchemy.com", "EVM_RPC_URL_BSC"},
	{"polygon", "137", "polygon-mainnet.g.alchemy.com", "EVM_RPC_URL_POLYGON"},
	{"arbitrum", "42161", "arb-mainnet.g.alchemy.com", "EVM_RPC_URL_ARBITRUM"},
	{"optimism", "10", "opt-mainnet.g.alchemy.com", "EVM_RPC_URL_OPTIMISM"},
	{"base", "8453", "base-mainnet.g.alchemy.com", "EVM_RPC_URL_BASE"},
}

// alchemyKeyEnv is the SHARED chain-access credential the tree already uses
// (apps/reconciler, tests/oracle/sync-live.py, docs/operations/SECRETS.md).
//
// Reusing it is deliberate. Minting a second chain-access credential for the
// same six chains would give the tree two sources of truth for one fact, and
// the two would drift the first time one was rotated - the same failure mode
// as two id minters. A deployment that wants a different provider sets a
// per-chain override instead of a second global key.
const alchemyKeyEnv = "ALCHEMY_KEY"

// lookupChain resolves a canonical chain name to its binding.
func lookupChain(name string) (chain, bool) {
	for _, c := range chains {
		if c.Name == name {
			return c, true
		}
	}
	return chain{}, false
}

// endpoint resolves a chain's RPC URL: an explicit per-chain override first,
// then the shared Alchemy key. Both are read on every call rather than cached
// at construction, so an operator can rotate an endpoint or a key without a
// restart. The value is never logged - see redact.
func endpoint(c chain) string {
	if v := strings.TrimSpace(os.Getenv(c.OverrideEnv)); v != "" {
		return v
	}
	key := strings.TrimSpace(os.Getenv(alchemyKeyEnv))
	if key == "" {
		return ""
	}
	return "https://" + c.Host + "/v2/" + key
}

// redact reduces an RPC URL to scheme://host before it is stored on an error.
//
// RPC credentials are carried in the PATH on the major providers
// (https://eth-mainnet.g.alchemy.com/v2/<KEY>, .../rpc/<KEY>), so a query-only
// redaction would leak the key through every error and every journal row that
// quotes one. Keeping the origin is enough to identify the endpoint in a
// journal without exposing the credential. The userinfo is dropped with the
// rest of the URL for the same reason: a URL-embedded basic-auth password is a
// credential too.
func redact(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return "(unparseable rpc url)"
	}
	host := u.Host // host:port, and NEVER the userinfo (u.User is separate)
	if host == "" {
		return "(unparseable rpc url)"
	}
	scheme := u.Scheme
	if scheme == "" {
		scheme = "https"
	}
	return scheme + "://" + host
}

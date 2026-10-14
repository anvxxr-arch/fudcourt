// Package dexcap is the DEX Data Platform's provider capability contract (plan
// §11): what a provider CAN do, what it costs, and in which order it is
// preferred — separate from HOW it fetches (that stays ingest.Module/Fetcher).
//
// The split is deliberate. The engine needs one uniform Fetcher interface; the
// platform needs to ask "who can price this pool on Base, cheaply, right now?"
// without knowing any provider's package. This package answers the second
// question and nothing else: it imports canon (for the canonical types) and the
// standard library — never a provider, never a store, never HTTP (plan §39).
//
// A provider module registers ONE Descriptor at construction. The registry then
// resolves capability->providers by priority, with health-aware fallback.
package dexcap

// Capability is one thing a provider can supply. The set is closed so a typo in
// a descriptor cannot invent a capability no resolver looks up.
type Capability string

// The capability vocabulary (plan §11).
const (
	CapTokens         Capability = "tokens"
	CapPools          Capability = "pools"
	CapPrice          Capability = "price"
	CapSwaps          Capability = "swaps"
	CapCandles        Capability = "candles"
	CapLiquidity      Capability = "liquidity"
	CapProtocolMetric Capability = "protocol_metrics"
	CapWallet         Capability = "wallet"
	CapRouting        Capability = "routing"
	CapRisk           Capability = "risk"
	CapPerp           Capability = "perp"
	CapOrderbook      Capability = "orderbook"
	CapDiscovery      Capability = "discovery"
	CapHolders        Capability = "holders"
)

// Capabilities lists every capability in contract order.
var Capabilities = []Capability{
	CapTokens, CapPools, CapPrice, CapSwaps, CapCandles, CapLiquidity,
	CapProtocolMetric, CapWallet, CapRouting, CapRisk, CapPerp, CapOrderbook,
	CapDiscovery, CapHolders,
}

// Valid reports whether c is one of the capabilities above.
func (c Capability) Valid() bool {
	for _, v := range Capabilities {
		if c == v {
			return true
		}
	}
	return false
}

// AuthKind describes how a provider authenticates, so the operator dashboard and
// the credential-aware seeding can reason about a provider without calling it.
type AuthKind string

const (
	// AuthNone is a keyless provider (DexScreener, GeckoTerminal, DefiLlama).
	AuthNone AuthKind = "none"
	// AuthAPIKey is a single static key read from the environment.
	AuthAPIKey AuthKind = "api_key"
	// AuthOAuth is a token flow (institutional providers).
	AuthOAuth AuthKind = "oauth"
	// AuthWallet is an on-chain identity (a signer for a routing provider).
	AuthWallet AuthKind = "wallet"
)

// RateLimit is a provider's published budget (plan §57). Zero fields mean
// "unpublished", never "unlimited" — an unknown budget must not be read as a
// licence to hammer.
type RateLimit struct {
	PerSecond      float64 `json:"per_second,omitempty"`
	PerMinute      int     `json:"per_minute,omitempty"`
	PerDay         int     `json:"per_day,omitempty"`
	MonthlyCredits int64   `json:"monthly_credits,omitempty"`
	// CreditsPerRequest is the cost of one call, when the provider meters.
	CreditsPerRequest int64 `json:"credits_per_request,omitempty"`
	// CostPerRequestUSD is the marginal USD cost of one call, if any.
	CostPerRequestUSD string `json:"cost_per_request_usd,omitempty"`
}

// Descriptor is a provider's static capability declaration (plan §11). It is
// configuration, not state: the runtime health of a provider lives in the
// reliability recorder, not here.
type Descriptor struct {
	// Name is the data.job provider column value ("dexscreener", "bitquery").
	Name string `json:"name"`
	// Kind is a human label for the dashboard ("aggregator", "indexer", ...).
	Kind string `json:"kind,omitempty"`
	// Capabilities is what this provider can supply. Every entry must be a
	// valid Capability.
	Capabilities []Capability `json:"capabilities"`
	// Chains are the canonical chain NAMES this provider covers. An empty list
	// means "all chains" ONLY for a genuinely chain-agnostic provider (a
	// protocol-analytics source); a chain-scoped provider must list its chains.
	Chains []string `json:"chains,omitempty"`
	// Auth is how the provider authenticates.
	Auth AuthKind `json:"auth"`
	// APIKeyEnv names the environment variable the key is read from, when
	// Auth != AuthNone. Never the key itself.
	APIKeyEnv string `json:"api_key_env,omitempty"`
	// RequiresKey marks a provider whose jobs must seed DISABLED without a key
	// (mirrors etherscan's HasCredentials gating).
	RequiresKey bool `json:"requires_key"`
	// Limits is the published budget (plan §57).
	Limits RateLimit `json:"limits,omitempty"`
	// Realtime marks a provider that can supply sub-minute updates.
	Realtime bool `json:"realtime"`
	// Historical marks a provider that can backfill past data.
	Historical bool `json:"historical"`
	// Priority is the plan §3 tier this provider sits at. It drives fallback
	// order: S0 before S1 before S3, subject to health.
	Tier string `json:"tier"`
	// PriorityWithinTier breaks ties inside one tier (lower = preferred).
	PriorityWithinTier int `json:"priority_within_tier,omitempty"`
	// Cost is a coarse cost class: "free" | "metered" | "paid" | "enterprise".
	Cost string `json:"cost,omitempty"`
}

// Providers returns the (provider, capability) pairs this descriptor declares,
// in declaration order. Used to index a Registry.
func (d Descriptor) pairs() []struct {
	Provider   string
	Capability Capability
} {
	out := make([]struct {
		Provider   string
		Capability Capability
	}, 0, len(d.Capabilities))
	for _, c := range d.Capabilities {
		out = append(out, struct {
			Provider   string
			Capability Capability
		}{d.Name, c})
	}
	return out
}

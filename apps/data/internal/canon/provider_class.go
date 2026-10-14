package canon

import "strings"

// This file is the plan §3 source hierarchy as a resolvable vocabulary: which
// tier and source-type every provider name maps to. It exists because a DEX
// fact row stores only the provider name (see the `source` column on every
// data.dex_* table); the tier and source-type are a fixed fact about OUR
// adapter — which upstream it wraps — not a per-row observation, so they are
// resolved here rather than duplicated into every row.
//
// Read-side projection: the row scan resolves SourceProvider through
// ClassifyProvider and fills Provenance.Tier / Provenance.SourceType. A writer
// MUST set the same class on the rows it constructs; this map is the single
// vocabulary both sides agree on. A provider absent from the map is left
// unclassified (empty tier/type strings), never guessed.

// ProviderClass is one provider's plan §3 classification.
type ProviderClass struct {
	// Tier is the plan §3 source-quality tier: S0 blockchain ground truth
	// through S5 Fudcourt derived.
	Tier SourceTier
	// Type is the SourceType label: "rpc", "dex_native", "indexer",
	// "aggregator", "analytics", "derived".
	Type string
}

// providerClasses is the closed provider vocabulary. Keys are the data.job
// provider column values (lowercase), never display names.
var providerClasses = map[string]ProviderClass{
	// S0 — blockchain / contract state (ground truth). Only a DIRECT node or
	// RPC client qualifies; a keyed third-party REST API that indexes chain
	// data is S2 below, never S0.
	"evmrpc": {TierBlockchain, "rpc"},

	// S1 — DEX-native protocol truth.
	"uniswap":     {TierDexNative, "dex_native"},
	"raydium":     {TierDexNative, "dex_native"},
	"orca":        {TierDexNative, "dex_native"},
	"meteora":     {TierDexNative, "dex_native"},
	"pancakeswap": {TierDexNative, "dex_native"},
	"aerodrome":   {TierDexNative, "dex_native"},
	"curve":       {TierDexNative, "dex_native"},
	"balancer":    {TierDexNative, "dex_native"},

	// S2 — blockchain indexers (normalized chain data): a third-party API or
	// explorer that indexes a chain. etherscan/blockscout/mempool proxy their
	// own nodes and serve indexed results, so they are NOT ground truth.
	"bitquery":   {TierIndexer, "indexer"},
	"thegraph":   {TierIndexer, "indexer"},
	"goldrush":   {TierIndexer, "indexer"},
	"subsquid":   {TierIndexer, "indexer"},
	"helius":     {TierIndexer, "indexer"},
	"shyft":      {TierIndexer, "indexer"},
	"covalent":   {TierIndexer, "indexer"},
	"etherscan":  {TierIndexer, "indexer"},
	"blockscout": {TierIndexer, "indexer"},
	"mempool":    {TierIndexer, "indexer"},

	// S3 — market aggregators (discovery + fast snapshots).
	"coingecko":     {TierAggregator, "aggregator"},
	"geckoterminal": {TierAggregator, "aggregator"},
	"dexscreener":   {TierAggregator, "aggregator"},
	"birdeye":       {TierAggregator, "aggregator"},
	"jupiter":       {TierAggregator, "aggregator"},
	"0x":            {TierAggregator, "aggregator"},
	"1inch":         {TierAggregator, "aggregator"},
	"coinmarketcap": {TierAggregator, "aggregator"},
	"coinmetrics":   {TierAggregator, "aggregator"},

	// S4 — analytics providers (aggregated/deep metrics).
	"defillama": {TierAnalytics, "analytics"},
	"dune":      {TierAnalytics, "analytics"},
	"flipside":  {TierAnalytics, "analytics"},
	"footprint": {TierAnalytics, "analytics"},
	"allium":    {TierAnalytics, "analytics"},
	"kaiko":     {TierAnalytics, "analytics"},
	"amberdata": {TierAnalytics, "analytics"},
	"coinglass": {TierAnalytics, "analytics"},
	"coinank":   {TierAnalytics, "analytics"},

	// S5 — Fudcourt's own derived output.
	"derived": {TierDerived, "derived"},
}

// ClassifyProvider resolves a provider name to its class. ok is false for an
// unknown provider: the caller leaves the row's tier/type empty rather than
// inventing one.
func ClassifyProvider(name string) (ProviderClass, bool) {
	c, ok := providerClasses[strings.ToLower(strings.TrimSpace(name))]
	return c, ok
}

// ProvenanceForProvider starts a Provenance for a provider with its tier and
// source-type filled from the single class vocabulary, so a writer never
// repeats the literals and a new provider is classified in exactly one place.
// An unknown provider leaves tier/type empty (the caller must register it
// here, not invent a class on the row).
func ProvenanceForProvider(name string) Provenance {
	p := Provenance{SourceProvider: name}
	if c, ok := ClassifyProvider(name); ok {
		p.Tier = c.Tier
		p.SourceType = c.Type
	}
	return p
}

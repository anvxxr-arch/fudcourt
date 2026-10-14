package canon

import (
	"testing"
	"time"
)

func TestClassifyProvider(t *testing.T) {
	cases := []struct {
		name string
		tier SourceTier
		typ  string
	}{
		{"geckoterminal", TierAggregator, "aggregator"},
		{"dexscreener", TierAggregator, "aggregator"},
		{"jupiter", TierAggregator, "aggregator"},
		{"coingecko", TierAggregator, "aggregator"},
		{"bitquery", TierIndexer, "indexer"},
		{"helius", TierIndexer, "indexer"},
		{"thegraph", TierIndexer, "indexer"},
		// Third-party explorers index a chain; they are NOT ground truth.
		{"etherscan", TierIndexer, "indexer"},
		{"blockscout", TierIndexer, "indexer"},
		{"mempool", TierIndexer, "indexer"},
		{"uniswap", TierDexNative, "dex_native"},
		{"raydium", TierDexNative, "dex_native"},
		{"defillama", TierAnalytics, "analytics"},
		{"dune", TierAnalytics, "analytics"},
		{"derived", TierDerived, "derived"},
		{"GeckoTerminal", TierAggregator, "aggregator"}, // case-insensitive
	}
	for _, c := range cases {
		got, ok := ClassifyProvider(c.name)
		if !ok {
			t.Fatalf("%q: not classified", c.name)
		}
		if got.Tier != c.tier || got.Type != c.typ {
			t.Fatalf("%q = %s/%s, want %s/%s", c.name, got.Tier, got.Type, c.tier, c.typ)
		}
		if !got.Tier.Valid() {
			t.Fatalf("%q tier %s not valid", c.name, got.Tier)
		}
	}
}

func TestClassifyProviderUnknownIsNotGuessed(t *testing.T) {
	if c, ok := ClassifyProvider("some-totally-unknown-provider"); ok {
		t.Fatalf("unknown provider classified as %+v", c)
	}
	if c, ok := ClassifyProvider(""); ok {
		t.Fatalf("empty provider classified as %+v", c)
	}
}

// TestProvenanceForProvider proves the single-vocabulary constructor yields the
// same class the readers resolve, and leaves an unknown provider unclassified
// rather than inventing a tier on the row.
func TestProvenanceForProvider(t *testing.T) {
	p := ProvenanceForProvider("dexscreener")
	if p.SourceProvider != "dexscreener" || p.Tier != TierAggregator || p.SourceType != "aggregator" {
		t.Fatalf("provenance %+v", p)
	}
	if p.ObservedAt != (time.Time{}) || p.Confidence != 0 {
		t.Fatalf("constructor must not invent time/confidence: %+v", p)
	}
	unknown := ProvenanceForProvider("who-even")
	if unknown.Tier != "" || unknown.SourceType != "" {
		t.Fatalf("unknown provider must stay unclassified: %+v", unknown)
	}
	if unknown.SourceProvider != "who-even" {
		t.Fatalf("provider name must be preserved: %+v", unknown)
	}
}

// TestWriterProvidersAreClassified guards the writers that call
// ProvenanceForProvider: if one of them is removed from providerClasses, its
// rows would silently emit an empty tier/type. This walks them explicitly so the
// removal fails here rather than in production provenance.
func TestWriterProvidersAreClassified(t *testing.T) {
	// geckoterminal + dexscreener write DEX facts; helius + jupiter likewise.
	for _, name := range []string{"geckoterminal", "dexscreener", "helius", "jupiter"} {
		p := ProvenanceForProvider(name)
		if p.Tier == "" || p.SourceType == "" {
			t.Fatalf("writer provider %q is unclassified: tier=%q type=%q", name, p.Tier, p.SourceType)
		}
	}
	// S0 is reserved for a direct node/RPC client; no third-party API may hold
	// it, or every row it produces would claim ground-truth confidence.
	for _, name := range []string{"etherscan", "blockscout", "mempool", "helius", "geckoterminal", "dexscreener"} {
		if p, _ := ClassifyProvider(name); p.Tier == TierBlockchain {
			t.Fatalf("third-party provider %q must not be classified S0/blockchain", name)
		}
	}
}

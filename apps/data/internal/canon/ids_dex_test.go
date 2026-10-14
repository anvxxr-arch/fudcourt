package canon

import "testing"

// TestDexKeyBuildersDeterministic pins the property the id rule depends on: the
// same coordinates mint the same natural key, so two processes mint one id.
func TestDexKeyBuildersDeterministic(t *testing.T) {
	kinds := []struct {
		name  string
		key   EntityKind
		build func() string
	}{
		{"deployment", KindDeployment, func() string { return DeploymentKey("Ethereum", "Uniswap-V3") }},
		{"swap", KindSwap, func() string { return SwapKey("Ethereum", "0xABCD", 7) }},
		{"candle", KindCandle, func() string { return CandleKey("pool:abc", "1m", 1728691200) }},
		{"market_snapshot", KindMarketSnapshot, func() string { return MarketSnapshotKey("pool:abc", 1728691200) }},
		{"liquidity_snapshot", KindLiquiditySnap, func() string { return LiquiditySnapshotKey("pool:abc", 1728691200) }},
		{"liquidity_position", KindLiquidityPos, func() string { return LiquidityPositionKey("pool:abc", "0xOwner") }},
		{"wallet_activity", KindWalletActivity, func() string { return WalletActivityKey("Bitquery", "evt-1") }},
		{"route_quote", KindRouteQuote, func() string { return RouteQuoteKey("Jupiter", "token:a", "token:b", "1000000") }},
		{"risk_metric", KindRiskMetric, func() string { return RiskMetricKey("pool:abc", "wash_trading", "v1") }},
		{"mev_event", KindMEVEvent, func() string { return MEVEventKey("Ethereum", "0xABCD") }},
		{"perp_market", KindPerpMarket, func() string { return PerpMarketKey("Hyperliquid", "linear_perp", "btc", "usdc") }},
		{"provider_observation", KindProviderObs, func() string { return ProviderObservationKey("dune", "query", "rec-1") }},
	}
	for _, k := range kinds {
		a := MintID(k.key, k.build())
		b := MintID(k.key, k.build())
		if a != b {
			t.Errorf("%s: not deterministic: %q != %q", k.name, a, b)
		}
		if Kind(a) != string(k.key) {
			t.Errorf("%s: id %q has kind %q, want %q", k.name, a, Kind(a), k.key)
		}
	}
}

// TestDexKeyChainQualification is the plan §5 safety property: the same token /
// pool / tx on two chains must NOT collapse into one entity.
func TestDexKeyChainQualification(t *testing.T) {
	if SwapKey("Ethereum", "0xabc", 0) == SwapKey("Base", "0xabc", 0) {
		t.Error("swap key ignores chain")
	}
	if DeploymentKey("Ethereum", "uniswap-v3") == DeploymentKey("Base", "uniswap-v3") {
		t.Error("deployment key ignores chain")
	}
	if MEVEventKey("Ethereum", "0xabc") == MEVEventKey("Arbitrum", "0xabc") {
		t.Error("mev key ignores chain")
	}
}

// TestSwapKeyLogIndexDisambiguates: one transaction can contain several swaps;
// the index must keep them distinct.
func TestSwapKeyLogIndexDisambiguates(t *testing.T) {
	a := MintID(KindSwap, SwapKey("ethereum", "0xdead", 3))
	b := MintID(KindSwap, SwapKey("ethereum", "0xdead", 4))
	if a == b {
		t.Error("two swaps in one tx with different log indices collided")
	}
	// Case-insensitive chain spelling must NOT fork identity.
	c := MintID(KindSwap, SwapKey("Ethereum", "0xdead", 3))
	if a != c {
		t.Error("chain casing changed the swap id")
	}
}

// TestCandleKeyIntervalAndTime: a candle is (pool, interval, open) — all three
// must matter.
func TestCandleKeyIntervalAndTime(t *testing.T) {
	base := MintID(KindCandle, CandleKey("pool:x", "1m", 1000))
	if base == MintID(KindCandle, CandleKey("pool:x", "5m", 1000)) {
		t.Error("interval ignored")
	}
	if base == MintID(KindCandle, CandleKey("pool:x", "1m", 1060)) {
		t.Error("open time ignored")
	}
	if base == MintID(KindCandle, CandleKey("pool:y", "1m", 1000)) {
		t.Error("pool ignored")
	}
}

// TestRiskMetricKeyVersioning: a changed algorithm must mint a new series, not
// rewrite the old one (plan §26).
func TestRiskMetricKeyVersioning(t *testing.T) {
	v1 := MintID(KindRiskMetric, RiskMetricKey("pool:x", "wash_trading", "v1"))
	v2 := MintID(KindRiskMetric, RiskMetricKey("pool:x", "wash_trading", "v2"))
	if v1 == v2 {
		t.Error("algorithm version did not change the risk id")
	}
}

// TestRouteQuoteKeySizeMatters: two quotes for the same pair at different input
// sizes are two rows (that is what makes best-execution a query).
func TestRouteQuoteKeySizeMatters(t *testing.T) {
	small := MintID(KindRouteQuote, RouteQuoteKey("1inch", "token:a", "token:b", "1000"))
	large := MintID(KindRouteQuote, RouteQuoteKey("1inch", "token:a", "token:b", "1000000"))
	if small == large {
		t.Error("input amount ignored in route quote key")
	}
	other := MintID(KindRouteQuote, RouteQuoteKey("0x", "token:a", "token:b", "1000"))
	if small == other {
		t.Error("provider ignored in route quote key")
	}
}

// TestDexKindsAreRegistered: every new kind must be in EntityKinds so Valid()
// accepts it — a kind missing from the list is a silent id-classification bug.
func TestDexKindsAreRegistered(t *testing.T) {
	for _, k := range []EntityKind{
		KindDeployment, KindSwap, KindCandle, KindMarketSnapshot, KindLiquiditySnap,
		KindLiquidityPos, KindWalletActivity, KindRouteQuote, KindRiskMetric,
		KindMEVEvent, KindPerpMarket, KindProviderObs,
	} {
		if !k.Valid() {
			t.Errorf("kind %q not in EntityKinds", k)
		}
	}
	// And the pre-existing kinds still validate (no regression).
	for _, k := range []EntityKind{KindAsset, KindChain, KindToken, KindVenue, KindPool, KindPrediction} {
		if !k.Valid() {
			t.Errorf("pre-existing kind %q no longer valid", k)
		}
	}
}

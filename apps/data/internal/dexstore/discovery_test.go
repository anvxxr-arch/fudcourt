package dexstore

import (
	"context"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// discoveryFake records what the pipeline wrote, so a test can assert the
// pipeline's dependency order and that a rejected candidate wrote NOTHING.
type discoveryFake struct {
	chains      []canon.Chain
	venues      []canon.Venue
	deployments []canon.DexDeployment
	pools       []canon.Pool
	poolTokens  []canon.PoolToken
	err         error
}

func (f *discoveryFake) UpsertAssets(context.Context, []canon.Asset) (int, error) { return 0, f.err }
func (f *discoveryFake) UpsertChains(_ context.Context, r []canon.Chain) (int, error) {
	f.chains = append(f.chains, r...)
	return len(r), f.err
}
func (f *discoveryFake) UpsertVenues(_ context.Context, r []canon.Venue) (int, error) {
	f.venues = append(f.venues, r...)
	return len(r), f.err
}
func (f *discoveryFake) UpsertInstruments(context.Context, []canon.Instrument) (int, error) {
	return 0, f.err
}
func (f *discoveryFake) UpsertProtocols(context.Context, []canon.Protocol) (int, error) {
	return 0, f.err
}
func (f *discoveryFake) UpsertSeries(context.Context, []canon.SeriesMeta) (int, error) {
	return 0, f.err
}
func (f *discoveryFake) UpsertProviderSymbols(context.Context, []canon.ProviderSymbol) (int, error) {
	return 0, f.err
}
func (f *discoveryFake) WriteOhlcv(context.Context, []canon.Ohlcv) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteTrades(context.Context, []canon.Trade) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteQuotes(context.Context, []canon.Quote) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteOrderbook(context.Context, []canon.OrderbookSnap) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteLiquidations(context.Context, []canon.Liquidation) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteOptionQuotes(context.Context, []canon.OptionQuote) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteObservations(context.Context, []canon.Observation) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteFunding(context.Context, []canon.FundingRate) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteOpenInterest(context.Context, []canon.OpenInterest) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WritePools(_ context.Context, r []canon.Pool) (int, int, error) {
	f.pools = append(f.pools, r...)
	return len(r), 0, f.err
}
func (f *discoveryFake) WriteArticles(context.Context, []canon.Article) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WritePredictionMarkets(context.Context, []canon.PredictionMarket) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteChainTVL(context.Context, []canon.ChainTVL) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteProtocolTVL(context.Context, []canon.ProtocolTVL) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteSupply(context.Context, []canon.SupplySnapshot) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteMetric(context.Context, string, []canon.MetricPoint) (int, error) {
	return 0, f.err
}

// The remaining dexstore.Writer methods, recorded or no-op.
func (f *discoveryFake) UpsertDexDeployments(_ context.Context, r []canon.DexDeployment) (int, error) {
	f.deployments = append(f.deployments, r...)
	return len(r), f.err
}
func (f *discoveryFake) UpsertPoolTokens(_ context.Context, r []canon.PoolToken) (int, error) {
	f.poolTokens = append(f.poolTokens, r...)
	return len(r), f.err
}
func (f *discoveryFake) WriteDexSwaps(context.Context, []canon.Swap) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteDexCandles(context.Context, []canon.DexCandle) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteDexLiquiditySnapshots(context.Context, []canon.DexLiquiditySnapshot) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteDexMarketSnapshots(context.Context, []canon.DexMarketSnapshot) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteDexLiquidityPositions(context.Context, []canon.DexLiquidityPosition) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteDexWalletActivity(context.Context, []canon.WalletActivity) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteDexRouteQuotes(context.Context, []canon.RouteQuote) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteDexRiskMetrics(context.Context, []canon.RiskMetric) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteDexMEVEvents(context.Context, []canon.MEVEvent) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteDexPerpMarkets(context.Context, []canon.PerpMarket) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteDexPerpLiquidations(context.Context, []canon.PerpLiquidation) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteDexOrderbookSnapshots(context.Context, []canon.DexOrderbookSnapshot) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteProviderObservations(context.Context, []canon.ProviderObservation) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteProviderHealth(context.Context, []ProviderHealth) (int, int, error) {
	return 0, 0, f.err
}
func (f *discoveryFake) WriteQualityStatus(context.Context, []QualityStatus) (int, int, error) {
	return 0, 0, f.err
}

var (
	_ Writer       = (*discoveryFake)(nil)
	_ canon.Writer = (*discoveryFake)(nil)
)

func factoryCandidate() Candidate {
	blk := int64(21000000)
	return Candidate{
		Source:         DiscoveryFactory,
		Provider:       "uniswap",
		Confirmation:   "PoolCreated event decoded from the factory log",
		ObservedAt:     time.Date(2026, 10, 12, 11, 0, 0, 0, time.UTC),
		ChainName:      "ethereum",
		DEXSlug:        "uniswap_v3",
		PoolAddress:    "0xPOOL",
		Factory:        "0xFACTORY",
		Router:         "0xROUTER",
		ConfirmedBlock: &blk,
		Tokens: []CandidateToken{
			{Address: "0xWETH", Symbol: "WETH", Decimals: 18, HasDecimals: true},
			{Address: "0xUSDC", Symbol: "USDC", Decimals: 6, HasDecimals: true},
		},
	}
}

// TestDiscoveryStoresCanonicalRows proves the happy path writes the whole
// dependency chain and that the pool id is the SAME PoolKey every other dataset
// mints — so discovery and market data meet on one identity.
func TestDiscoveryStoresCanonicalRows(t *testing.T) {
	wc := &discoveryFake{}
	w := &discoveryFake{}
	res, err := StoreConfirmed(context.Background(), w, wc, factoryCandidate())
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !res.Stored || res.TokensKept != 2 {
		t.Fatalf("result %+v", res)
	}
	wantPool := canon.MintID(canon.KindPool, canon.PoolKey("ethereum", "0xPOOL"))
	if res.PoolID != wantPool {
		t.Fatalf("pool id %q, want %q", res.PoolID, wantPool)
	}
	if len(wc.chains) != 1 || wc.chains[0].Name != "ethereum" || wc.chains[0].Kind != "evm" {
		t.Fatalf("chains %+v", wc.chains)
	}
	if len(wc.venues) != 1 || wc.venues[0].Kind != "dex" {
		t.Fatalf("venues %+v", wc.venues)
	}
	if len(w.deployments) != 1 {
		t.Fatalf("deployments %+v", w.deployments)
	}
	d := w.deployments[0]
	if d.NaturalKey != canon.DeploymentKey("ethereum", "uniswap_v3") || d.Factory != "0xFACTORY" || d.AddressKind != "evm" {
		t.Fatalf("deployment %+v", d)
	}
	if d.Provenance.Tier != canon.TierDexNative {
		t.Fatalf("factory discovery must carry protocol-truth tier, got %+v", d.Provenance)
	}
	if d.Provenance.BlockNumber == nil || *d.Provenance.BlockNumber != 21000000 {
		t.Fatalf("confirmed block not recorded: %+v", d.Provenance)
	}
	if d.Provenance.ObservedAt.IsZero() {
		t.Fatal("observed_at must be carried onto the provenance")
	}
	// The POOL row itself must exist: without it the pool_token rows below are
	// orphans pointing at a pool id that does not exist. It is written through
	// the CANON writer (the pool table is a canon entity), so it is captured
	// there, not on the dex writer.
	if len(wc.pools) != 1 {
		t.Fatalf("discovery must write exactly one pool row, got %+v", wc.pools)
	}
	if wc.pools[0].PoolID != wantPool || wc.pools[0].Address != "0xPOOL" {
		t.Fatalf("pool row %+v", wc.pools[0])
	}
	if len(w.poolTokens) != 2 {
		t.Fatalf("pool tokens %+v", w.poolTokens)
	}
	// No base side was designated by the candidate, so IsBase stays NIL rather
	// than asserting one the source never claimed.
	if w.poolTokens[0].Index != 0 || w.poolTokens[0].IsBase != nil {
		t.Fatalf("undesignated base side must be nil: %+v", w.poolTokens[0])
	}
	if w.poolTokens[0].PoolID != wantPool || w.poolTokens[1].PoolID != wantPool {
		t.Fatalf("pool tokens carry the wrong pool: %+v", w.poolTokens)
	}
}

// TestDiscoveryDesignatedBaseHonored proves an explicit BaseTokenIndex is
// honored at the right position rather than always marking the first side.
func TestDiscoveryDesignatedBaseHonored(t *testing.T) {
	c := factoryCandidate()
	idx := 1
	c.BaseTokenIndex = &idx
	wc := &discoveryFake{}
	w := &discoveryFake{}
	if _, err := StoreConfirmed(context.Background(), w, wc, c); err != nil {
		t.Fatalf("store: %v", err)
	}
	if len(w.poolTokens) != 2 {
		t.Fatalf("pool tokens %+v", w.poolTokens)
	}
	if w.poolTokens[0].IsBase != nil {
		t.Fatalf("side 0 must not be base: %+v", w.poolTokens[0])
	}
	if w.poolTokens[1].IsBase == nil || !*w.poolTokens[1].IsBase {
		t.Fatalf("side 1 must be base: %+v", w.poolTokens[1])
	}
}

// TestDiscoveryRejectsUnverifiable is the orphan-row guard: a candidate missing
// a key coordinate is REJECTED with a reason and writes NOTHING.
func TestDiscoveryRejectsUnverifiable(t *testing.T) {
	cases := []struct {
		name  string
		mutit func(*Candidate)
	}{
		{"no chain", func(c *Candidate) { c.ChainName = "" }},
		{"no pool address", func(c *Candidate) { c.PoolAddress = "" }},
		{"no dex slug", func(c *Candidate) { c.DEXSlug = "" }},
		{"no resolvable token", func(c *Candidate) { c.Tokens = []CandidateToken{{Symbol: "NOPE"}} }},
		{"unknown source", func(c *Candidate) { c.Source = "rumour" }},
		// The verify gate: a claim nobody confirmed is not a pool, and a row
		// with no observation time cannot be stored without inventing one.
		{"no confirmation", func(c *Candidate) { c.Confirmation = "" }},
		{"no observed_at", func(c *Candidate) { c.ObservedAt = time.Time{} }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := factoryCandidate()
			tc.mutit(&c)
			wc := &discoveryFake{}
			w := &discoveryFake{}
			res, err := StoreConfirmed(context.Background(), w, wc, c)
			if err != nil {
				t.Fatalf("a rejection is not an error: %v", err)
			}
			if res.Stored {
				t.Fatalf("%s must not be stored", tc.name)
			}
			if res.Reason == "" {
				t.Fatalf("%s must carry a reason", tc.name)
			}
			if len(wc.chains)+len(wc.venues)+len(wc.pools)+len(w.pools)+len(w.deployments)+len(w.poolTokens) != 0 {
				t.Fatalf("%s wrote rows: %+v %+v", tc.name, wc, w)
			}
		})
	}
}

// TestDiscoveryAddresslessSideSkipped proves a candidate whose second side has
// no address still stores the valid side, at a frozen index order.
func TestDiscoveryAddresslessSideSkipped(t *testing.T) {
	c := factoryCandidate()
	c.Tokens = []CandidateToken{
		{Address: "0xWETH", HasDecimals: true, Decimals: 18},
		{Address: "", Symbol: "MYSTERY"},
	}
	wc := &discoveryFake{}
	w := &discoveryFake{}
	res, err := StoreConfirmed(context.Background(), w, wc, c)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !res.Stored || res.TokensKept != 1 {
		t.Fatalf("result %+v", res)
	}
	if len(w.poolTokens) != 1 || w.poolTokens[0].Index != 0 {
		t.Fatalf("pool tokens %+v", w.poolTokens)
	}
}

// TestDiscoveryDuplicateSideCollapses proves a malformed source cannot store the
// same side twice.
func TestDiscoveryDuplicateSideCollapses(t *testing.T) {
	c := factoryCandidate()
	c.Tokens = append(c.Tokens, CandidateToken{Address: "0xWETH", Symbol: "WETH-dup"})
	wc := &discoveryFake{}
	w := &discoveryFake{}
	res, err := StoreConfirmed(context.Background(), w, wc, c)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if res.TokensKept != 2 {
		t.Fatalf("duplicate side not collapsed: %+v", res)
	}
}

// TestDiscoveryTierContradictionRejected proves a provider whose class
// contradicts the discovery path is refused rather than mislabelled: an
// aggregator cannot emit a factory event.
func TestDiscoveryTierContradictionRejected(t *testing.T) {
	c := factoryCandidate()
	c.Source = DiscoveryFactory // path tier = S1 (dex_native)
	c.Provider = "defillama"    // classified S4 (analytics) -> contradiction
	wc := &discoveryFake{}
	w := &discoveryFake{}
	res, err := StoreConfirmed(context.Background(), w, wc, c)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if res.Stored {
		t.Fatal("a provider below the path tier must be rejected")
	}
	if res.Reason == "" {
		t.Fatal("rejection must carry a reason")
	}
}

// TestDiscoveryAggregatorTier proves an aggregator-path candidate is stored with
// the aggregator tier when the provider is unclassified.
func TestDiscoveryAggregatorTier(t *testing.T) {
	c := factoryCandidate()
	c.Source = DiscoveryAggregator
	c.Provider = "some-new-aggregator" // unclassified
	wc := &discoveryFake{}
	w := &discoveryFake{}
	res, err := StoreConfirmed(context.Background(), w, wc, c)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !res.Stored {
		t.Fatalf("aggregator candidate should store: %+v", res)
	}
	if w.deployments[0].Provenance.Tier != canon.TierAggregator {
		t.Fatalf("tier %q, want aggregator", w.deployments[0].Provenance.Tier)
	}
}

// TestDiscoveryNilWritersLoud proves the pipeline refuses to run without both
// ports rather than silently dropping a discovered pool.
func TestDiscoveryNilWritersLoud(t *testing.T) {
	if _, err := StoreConfirmed(context.Background(), nil, &discoveryFake{}, factoryCandidate()); err == nil {
		t.Fatal("nil dex writer must error")
	}
	if _, err := StoreConfirmed(context.Background(), &discoveryFake{}, nil, factoryCandidate()); err == nil {
		t.Fatal("nil canon writer must error")
	}
}

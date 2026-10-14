package bitquery

// regressions_test.go pins the defects found in review: an uncovered chain
// must be refused rather than silently queried on the wrong cube, an absent
// Trade.Index must not collapse to 0, and a JSON `null` data member must not
// read as an empty success.

import (
	"context"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// TestUnknownChainRejectedLoudly proves a chain the adapter does not cover is
// refused rather than silently queried on the Ethereum cube — which would mint
// rows under the wrong chain_id.
func TestUnknownChainRejectedLoudly(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: tradeFixture}, 0)
	c.apiKey = "k"
	f := &fetcher{dataset: "dex-trades", client: c, dw: &spyDexWriter{}}
	_, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "bitquery", Dataset: "dex-trades", Subject: "solana:0xpool",
	}, spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("an uncovered chain must be a loud shape error, got %v", err)
	}
}

// TestNetworkFollowsTheChainSlug proves the query's network variable is derived
// from the subject, so a base: subject cannot query the eth cube.
func TestNetworkFollowsTheChainSlug(t *testing.T) {
	cases := map[string]string{"ethereum": "eth", "base": "base", "bsc": "bsc", "arbitrum": "arbitrum"}
	for slug, want := range cases {
		got, ok := bitqueryNetwork(slug)
		if !ok || got != want {
			t.Fatalf("bitqueryNetwork(%q) = %q/%v (want %q)", slug, got, ok, want)
		}
	}
	if _, ok := bitqueryNetwork("solana"); ok {
		t.Fatal("solana is not served by this EVM adapter")
	}
}

// TestAbsentTradeIndexRejected proves a trade with no index is rejected rather
// than defaulted to 0: every row would otherwise share LogIndex 0 and a
// multi-swap transaction would collapse onto one SwapKey.
func TestAbsentTradeIndexRejected(t *testing.T) {
	body := `{"data":{"EVM":{"DEXTrades":[
		{"Block":{"Number":"100","Time":"2026-10-12T06:00:00Z"},
		 "Transaction":{"Hash":"0xtx"},
		 "Trade":{
		   "Buy":{"Amount":"1","Currency":{"SmartContract":"0xUSDC","Decimals":"6"}},
		   "Sell":{"Amount":"1","Currency":{"SmartContract":"0xWETH","Decimals":"18"}}}}
	]}}}`
	c := newClient(&fakeDoer{status: 200, body: body}, 0)
	c.apiKey = "k"
	f := &fetcher{dataset: "dex-trades", client: c, dw: &spyDexWriter{}}
	res, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "bitquery", Dataset: "dex-trades", Subject: seedPool,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsWritten != 0 || res.RowsRejected != 1 {
		t.Fatalf("an absent Trade.Index must be rejected, not defaulted to 0: %+v", res)
	}
}

// TestNullDataRejected proves a JSON `null` data member (four bytes, not zero)
// is a failure rather than a silent empty success.
func TestNullDataRejected(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: `{"data":null}`}, 0)
	c.apiKey = "k"
	f := &fetcher{dataset: "dex-trades", client: c, dw: &spyDexWriter{}}
	_, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "bitquery", Dataset: "dex-trades", Subject: seedPool,
	}, spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("a null data member must be a shape failure, got %v", err)
	}
}

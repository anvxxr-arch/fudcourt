package coinglass

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"
)

// TestLiveDecrypt hits the real hosts. It is gated on COINGLASS_LIVE=1 so the
// offline suite stays hermetic; run it with:
//
//	COINGLASS_LIVE=1 go test ./internal/research/coinglass/ -run TestLive -v
//
// NoCache is set so the test can never pass on a previously cached body.
func TestLiveDecrypt(t *testing.T) {
	if os.Getenv("COINGLASS_LIVE") != "1" {
		t.Skip("set COINGLASS_LIVE=1 to run the live probes")
	}
	f, err := New(Options{NoCache: true, Timeout: 30 * time.Second})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// 1. Futures statistics: a single object, the shape the dashboard's
	//    header row reads. Carries whichever `v` upstream picked today.
	t.Run("statistics", func(t *testing.T) {
		res, info, err := f.Fetch(ctx, CapiBase+"/api/futures/home/statistics")
		if err != nil {
			t.Fatalf("Fetch: %v", err)
		}
		if !res.Encrypted {
			t.Fatalf("statistics came back unencrypted (v=%q) — check RequestHeaders", res.V)
		}
		if !KnownV(res.V) {
			t.Fatalf("upstream sent v=%q, which is outside the known table", res.V)
		}
		var obj map[string]any
		if err := json.Unmarshal(res.JSON, &obj); err != nil {
			t.Fatalf("not an object: %v", err)
		}
		oi, ok := obj["openInterest"].(float64)
		if !ok || oi <= 0 {
			t.Fatalf("openInterest = %v, want a positive number", obj["openInterest"])
		}
		t.Logf("HTTP %d cache=%s v=%s openInterest=%.0f longRate=%v shortRate=%v",
			info.Status, info.Cache, res.V, oi, obj["longRate"], obj["shortRate"])
	})

	// 2. Per-symbol open interest: an array, and the probe that proves a
	//    symbol query survives the round trip.
	t.Run("openInterest", func(t *testing.T) {
		res, _, err := f.Fetch(ctx, CapiBase+"/api/openInterest/info?symbol=BTC")
		if err != nil {
			t.Fatalf("Fetch: %v", err)
		}
		var arr []map[string]any
		if err := json.Unmarshal(res.JSON, &arr); err != nil {
			t.Fatalf("not an array: %v", err)
		}
		if len(arr) == 0 {
			t.Fatal("empty array from a non-empty body")
		}
		if sym, _ := arr[0]["symbol"].(string); sym != "BTC" {
			t.Fatalf("symbol = %v, want BTC", arr[0]["symbol"])
		}
		t.Logf("v=%s rows=%d symbol=%v price=%v openInterest=%v",
			res.V, len(arr), arr[0]["symbol"], arr[0]["price"], arr[0]["openInterest"])
	})

	// 3. A request upstream refuses. CoinGlass answers 200 with
	//    success:false and a message — the family must report that, never an
	//    empty table.
	t.Run("upstream_refusal", func(t *testing.T) {
		res, _, err := f.Fetch(ctx, CapiBase+"/api/fundingRate/list")
		if err != nil {
			t.Fatalf("a refusal is a 200 with success:false, not an HTTP error: %v", err)
		}
		if res.Encrypted {
			t.Fatalf("a refusal came back encrypted (v=%s) — unexpected", res.V)
		}
		if !res.Refused() {
			t.Fatalf("Refused() = false for code=%q success=%v", res.Code, res.Success)
		}
		if res.Msg == "" {
			t.Fatal("refusal carries no message to surface")
		}
		t.Logf("refusal: code=%s msg=%q", res.Code, res.Msg)
	})
}

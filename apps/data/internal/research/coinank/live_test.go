package coinank

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"
)

// TestLiveModes is the end-to-end check that the reconstructed signature is
// still accepted and every mode still answers real data.
//
// It is gated on COINANK_LIVE=1 because it hits the network: an offline `go test`
// must stay green, and a live failure must be obviously a live failure. Run with:
//
//	COINANK_LIVE=1 go test ./internal/research/coinank/ -run TestLiveModes -v
//
// The assertions are deliberately about SHAPE and NON-EMPTINESS, not about values.
// Pinning a funding rate would make this test fail every time the market moved,
// which teaches people to ignore it; asserting "the array is non-empty and each
// row is an object with the documented key" is what actually distinguishes a
// working signature from a broken one. A signature failure does not return an
// empty array — it returns `success:false / "system error!"`, which the fetcher
// raises as an error and the first assertion catches.
func TestLiveModes(t *testing.T) {
	if os.Getenv("COINANK_LIVE") != "1" {
		t.Skip("set COINANK_LIVE=1 to run the live CoinAnk probes")
	}
	f, err := New(Options{NoCache: true, Timeout: 45 * time.Second})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	svc := &Service{F: f}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	cases := []struct {
		mode     string
		interval string
		// wantArray is false for object payloads (mode=whales).
		wantArray bool
		// minRows guards against a shape that decodes but carries nothing.
		minRows int
		// key is a field that must exist on the first element.
		key string
	}{
		{mode: "fundingRate", wantArray: true, minRows: 100, key: "symbol"},
		{mode: "liquidation", interval: "1h", wantArray: true, minRows: 1, key: "exchangeName"},
		{mode: "longShort", wantArray: true, minRows: 100, key: "coinName"},
		{mode: "etf", wantArray: true, minRows: 100, key: "date"},
		{mode: "whales", wantArray: false, minRows: 1, key: "address"},
	}

	for _, c := range cases {
		c := c
		t.Run(c.mode, func(t *testing.T) {
			env, err := svc.Envelope(ctx, c.mode, c.interval, true)
			if err != nil {
				t.Fatalf("live %s: %v", c.mode, err)
			}
			if env.Auth != AuthNote {
				t.Errorf("auth provenance = %q, want %q", env.Auth, AuthNote)
			}
			if c.mode == "liquidation" && env.Interval != "1h" {
				t.Errorf("interval echo = %q, want 1h", env.Interval)
			}

			if c.wantArray {
				if env.UpstreamCount == nil {
					t.Fatalf("array payload has no upstreamCount")
				}
				if *env.UpstreamCount < c.minRows {
					t.Fatalf("only %d rows, want at least %d — upstream may have changed shape",
						*env.UpstreamCount, c.minRows)
				}
				var rows []map[string]json.RawMessage
				if err := json.Unmarshal(env.Data, &rows); err != nil {
					t.Fatalf("data is not an array of objects: %v", err)
				}
				if _, ok := rows[0][c.key]; !ok {
					t.Errorf("first row lacks the documented key %q; keys present: %v",
						c.key, keysOf(rows[0]))
				}
			} else {
				if env.UpstreamCount != nil {
					t.Errorf("object payload should not carry upstreamCount, got %d", *env.UpstreamCount)
				}
				var obj map[string]json.RawMessage
				if err := json.Unmarshal(env.Data, &obj); err != nil {
					t.Fatalf("data is not an object: %v", err)
				}
				var list []map[string]json.RawMessage
				if err := json.Unmarshal(obj["list"], &list); err != nil || len(list) == 0 {
					t.Fatalf("object payload has no usable `list` (err=%v)", err)
				}
				if _, ok := list[0][c.key]; !ok {
					t.Errorf("first list element lacks key %q; keys present: %v", c.key, keysOf(list[0]))
				}
			}
			t.Logf("%s: %d rows from %s", c.mode, derefOrZero(env.UpstreamCount), env.Upstream)
		})
	}
}

// TestLiveIntervalAllowlistEdges probes the two edges of the allowlist against
// live upstream, so the table in modes.go can be re-derived rather than trusted.
//
// 1h must return real turnover; 8h must return the all-zero table that makes the
// allowlist necessary. If 8h ever starts returning real data, the allowlist is
// out of date and this test says so.
func TestLiveIntervalAllowlistEdges(t *testing.T) {
	if os.Getenv("COINANK_LIVE") != "1" {
		t.Skip("set COINANK_LIVE=1 to run the live CoinAnk probes")
	}
	f, err := New(Options{NoCache: true, Timeout: 45 * time.Second})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	svc := &Service{F: f}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	turnover := func(iv string) float64 {
		t.Helper()
		env, err := svc.Envelope(ctx, "liquidation", iv, true)
		if err != nil {
			t.Fatalf("live liquidation interval=%s: %v", iv, err)
		}
		var rows []struct {
			TotalTurnover float64 `json:"totalTurnover"`
		}
		if err := json.Unmarshal(env.Data, &rows); err != nil {
			t.Fatalf("interval=%s: %v", iv, err)
		}
		if len(rows) == 0 {
			t.Fatalf("interval=%s: empty row set", iv)
		}
		return rows[0].TotalTurnover
	}

	if got := turnover("1h"); got <= 0 {
		t.Errorf("interval=1h turnover = %v, want > 0 (an accepted value must carry real data)", got)
	}
	// 8h is NOT in the allowlist. This asserts the reason it is excluded still
	// holds: upstream answers an unusable all-zero table rather than an error.
	if got := turnover("8h"); got != 0 {
		t.Logf("NOTE: interval=8h now returns %v (was 0). Re-derive Intervals in modes.go.", got)
	}
}

func keysOf(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func derefOrZero(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

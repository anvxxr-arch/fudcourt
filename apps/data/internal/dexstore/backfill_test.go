package dexstore

import (
	"testing"
	"time"
)

// TestPlanBackfillOrder is the plan §48 contract: metadata first, the long tail
// last, and the sequence deterministic.
func TestPlanBackfillOrder(t *testing.T) {
	units := []BackfillUnit{
		{Provider: "helius", Dataset: "wallet", Subject: "solana:X"},
		{Provider: "geckoterminal", Dataset: "swaps", Subject: "eth:0xPool"},
		{Provider: "geckoterminal", Dataset: "dex-candles", Subject: "eth:0xPool"},
		{Provider: "dexscreener", Dataset: "pools", Subject: "ethereum:X"},
		{Provider: "coingecko", Dataset: "chains", Subject: ""},
		{Provider: "dexscreener", Dataset: "tokens", Subject: "ethereum:X"},
	}
	ordered, skipped := PlanBackfill(units)
	if len(skipped) != 0 {
		t.Fatalf("nothing should be skipped: %+v", skipped)
	}
	want := []BackfillStage{
		StageMetadata, StagePools, StageTokens, StageOHLCV, StageSwaps, StageWallet,
	}
	if len(ordered) != len(want) {
		t.Fatalf("ordered %d units, want %d", len(ordered), len(want))
	}
	for i, w := range want {
		if ordered[i].Stage != w {
			t.Fatalf("position %d = %s, want %s", i, ordered[i].Stage.StageName(), w.StageName())
		}
	}
}

// TestPlanBackfillDeterministic proves the same input always orders the same way
// (a resumable backfill must be reproducible).
func TestPlanBackfillDeterministic(t *testing.T) {
	mk := func() []BackfillUnit {
		return []BackfillUnit{
			{Provider: "b", Dataset: "swaps", Subject: "s2"},
			{Provider: "a", Dataset: "swaps", Subject: "s1"},
			{Provider: "a", Dataset: "pools", Subject: "s3"},
		}
	}
	first, _ := PlanBackfill(mk())
	second, _ := PlanBackfill(mk())
	for i := range first {
		if first[i] != second[i] {
			t.Fatalf("order differs at %d: %+v vs %+v", i, first[i], second[i])
		}
	}
	// Within a stage the tiebreak is provider then dataset then subject.
	if first[0].Dataset != "pools" {
		t.Fatalf("pools should precede swaps: %+v", first)
	}
}

// TestPlanBackfillSkipsUnordered proves a dataset with no stage is SKIPPED, not
// silently run first as metadata.
func TestPlanBackfillSkipsUnordered(t *testing.T) {
	ordered, skipped := PlanBackfill([]BackfillUnit{
		{Provider: "p", Dataset: "quote", Subject: "s"},  // live-only: no stage
		{Provider: "p", Dataset: "tokens", Subject: "s"}, // StageTokens
	})
	if len(ordered) != 1 || ordered[0].Dataset != "tokens" {
		t.Fatalf("ordered %+v", ordered)
	}
	if len(skipped) != 1 || skipped[0].Dataset != "quote" {
		t.Fatalf("skipped %+v", skipped)
	}
}

// TestParseStageRoundTrip proves every stage name parses back, and an unknown
// name is a loud miss rather than a silent "metadata".
func TestParseStageRoundTrip(t *testing.T) {
	for s := StageMetadata; s <= StageLongTail; s++ {
		got, ok := ParseStage(s.StageName())
		if !ok || got != s {
			t.Fatalf("%s round-trip = %v ok=%v", s.StageName(), got, ok)
		}
	}
	if _, ok := ParseStage("nope"); ok {
		t.Fatal("unknown stage must not parse")
	}
}

// TestNextWindowAscendsAndExhausts pins the window rule the newest-N readers
// force: the walk ASCENDS from the checkpoint, and reaching the present is the
// terminal condition (reported, never an infinite loop).
func TestNextWindowAscendsAndExhausts(t *testing.T) {
	now := time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)
	start := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)

	from, to, done := NextWindow(Cursor{UnixMillis: start.UnixMilli()}, 1, now)
	if done {
		t.Fatal("a mid-history window is not exhausted")
	}
	if !from.Equal(start) || !to.Equal(start.AddDate(0, 0, 1)) {
		t.Fatalf("window %v..%v", from, to)
	}

	// A window that would reach the present is the LAST one.
	from, to, done = NextWindow(Cursor{UnixMillis: now.Add(-12 * time.Hour).UnixMilli()}, 1, now)
	if !done {
		t.Fatal("a window reaching now must be terminal")
	}
	if !from.Before(now) || !to.Equal(now) {
		t.Fatalf("final window %v..%v", from, to)
	}

	// An exhausted checkpoint stays exhausted.
	if _, _, done := NextWindow(Cursor{Exhausted: true}, 1, now); !done {
		t.Fatal("exhausted checkpoint must report exhausted")
	}
}

// TestNextWindowZeroCheckpointStartsAtEpoch proves a missing checkpoint starts at
// the epoch floor (the caller overrides with the pool's real creation time) and
// does NOT read as "recent" — which is the failure a bare limit would cause.
func TestNextWindowZeroCheckpointStartsAtEpoch(t *testing.T) {
	now := time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)
	from, _, done := NextWindow(Cursor{}, 30, now)
	if done {
		t.Fatal("a full window from epoch is not terminal")
	}
	if !from.Equal(time.Unix(0, 0).UTC()) {
		t.Fatalf("zero checkpoint should start at the epoch floor, got %v", from)
	}
}

// TestAdvanceCheckpointFollowsData proves the cursor follows the newest FETCHED
// time (not the requested window end), so a short page retries its gap instead
// of skipping past unwritten history.
func TestAdvanceCheckpointFollowsData(t *testing.T) {
	got := AdvanceCheckpoint(1697049600000, false)
	if got.UnixMillis != 1697049600000 || got.Exhausted {
		t.Fatalf("checkpoint %+v", got)
	}
	done := AdvanceCheckpoint(1000, true)
	if !done.Exhausted {
		t.Fatalf("exhausted flag lost: %+v", done)
	}
}

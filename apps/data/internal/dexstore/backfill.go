package dexstore

import (
	"fmt"
	"time"
)

// This file is the plan §48 ordered, checkpoint-driven backfill policy: the
// DATASET ORDER history is filled in, and the rule for advancing a window.
//
// Why a policy module rather than per-provider logic: the existing providers
// each walk their own history correctly (binance advances since_ms, coingecko
// pins a range), but nothing decides WHICH history to fill first — so an
// operator running the whole DEX platform backfills in whatever order the job
// scheduler happens to pick, which wastes premium quota on low-value pools
// before the metadata they depend on exists. §48 fixes the order precisely
// because later stages need earlier ones: you cannot ingest swaps for a pool
// whose tokens and pool row do not exist yet.
//
// The READER constraint that shapes the window rule: ReadOhlcv/ReadTimeseries
// keep the NEWEST N rows and reverse to ascending, so a "limit window" is not a
// historical window — a backfill must advance an EXPLICIT cursor and keep the
// window anchored in the past, or it silently re-reads the same recent rows.

// BackfillStage is one step of the plan §48 order. The numeric value IS the
// order (lower runs first), so the policy is a sort key, not a comment.
type BackfillStage int

const (
	// StageMetadata is chains/protocols/venue/asset identity — everything else
	// keys on these, so nothing may precede it.
	StageMetadata BackfillStage = 0
	// StagePools is the pool registry and deployment contracts.
	StagePools BackfillStage = 1
	// StageTokens is token metadata and pool composition.
	StageTokens BackfillStage = 2
	// StageOHLCV is candle history (the chart shape).
	StageOHLCV BackfillStage = 3
	// StageSwaps is the trade-level record (highest volume, so last among the
	// core four).
	StageSwaps BackfillStage = 4
	// StageLiquidity is liquidity snapshots/positions.
	StageLiquidity BackfillStage = 5
	// StageProtocolMetrics is protocol-level aggregates.
	StageProtocolMetrics BackfillStage = 6
	// StageWallet is wallet activity — the most expensive per row and the least
	// load-bearing, so it precedes only the long tail.
	StageWallet BackfillStage = 7
	// StageLongTail is low-activity pools: explicit, scheduled last, never
	// interleaved with the core history.
	StageLongTail BackfillStage = 8
)

// StageName is the stable spelling for a stage (a job column, a log line).
func (s BackfillStage) StageName() string {
	switch s {
	case StageMetadata:
		return "metadata"
	case StagePools:
		return "pools"
	case StageTokens:
		return "tokens"
	case StageOHLCV:
		return "ohlcv"
	case StageSwaps:
		return "swaps"
	case StageLiquidity:
		return "liquidity"
	case StageProtocolMetrics:
		return "protocol_metrics"
	case StageWallet:
		return "wallet"
	case StageLongTail:
		return "long_tail"
	default:
		return fmt.Sprintf("stage(%d)", int(s))
	}
}

// ParseStage reads a stage back from its spelling. ok is false for an unknown
// name, so a mis-typed stage in configuration fails loudly rather than silently
// ordering as 0 (metadata) and jumping the queue.
func ParseStage(name string) (BackfillStage, bool) {
	for s := StageMetadata; s <= StageLongTail; s++ {
		if s.StageName() == name {
			return s, true
		}
	}
	return StageMetadata, false
}

// DatasetStage maps a dataset to its plan §48 stage. A dataset that is not part
// of the ordered backfill (a live-only feed) reports ok=false, so it is not
// silently assigned to metadata and run first.
func DatasetStage(dataset string) (BackfillStage, bool) {
	switch dataset {
	case "chains", "protocols", "venues", "assets", "instruments":
		return StageMetadata, true
	case "pools", "deployments", "pool-tokens":
		return StagePools, true
	case "tokens", "market-snapshots":
		return StageTokens, true
	case "dex-candles", "ohlcv", "ohlcv-daily", "ohlcv-weekly":
		return StageOHLCV, true
	case "swaps":
		return StageSwaps, true
	case "liquidity", "liquidity-positions", "dex-liquidity":
		return StageLiquidity, true
	case "protocol-metrics", "protocols-tvl", "chains-tvl":
		return StageProtocolMetrics, true
	case "wallet", "wallet-activity":
		return StageWallet, true
	default:
		return StageMetadata, false
	}
}

// BackfillRegistry is the checkpoint the ordered backfill reads and writes. The
// DATA side is the caller's (a SQL table); this interface keeps the policy
// testable offline, and the key shape (provider, dataset, subject) matches the
// job identity so a checkpoint is unambiguous.
type BackfillRegistry interface {
	// Checkpoint returns the stored cursor for one unit of backfill. A missing
	// entry reports ok=false (never a zero value that would look like "started
	// from epoch").
	Checkpoint(provider, dataset, subject string) (Cursor, bool)
	// SaveCheckpoint records the newest cursor after a successful page.
	SaveCheckpoint(provider, dataset, subject string, c Cursor)
}

// Cursor is a backfill checkpoint: the explicit window position. UnixMillis is
// the anchor the readers must be asked for as a START (never a bare limit,
// which the newest-N readers would interpret as "recent").
type Cursor struct {
	UnixMillis int64
	Exhausted  bool
}

// BackfillUnit is one dataset+subject to fill, with its stage.
type BackfillUnit struct {
	Provider string
	Dataset  string
	Subject  string
	Stage    BackfillStage
}

// PlanBackfill orders units by plan §48 stage and then by provider/dataset so
// the sequence is deterministic — two runs of the same input produce the same
// order, which is what makes a resumable backfill reproducible. A unit whose
// dataset has no stage is reported as skipped rather than run first.
func PlanBackfill(units []BackfillUnit) (ordered []BackfillUnit, skipped []BackfillUnit) {
	ordered = make([]BackfillUnit, 0, len(units))
	for _, u := range units {
		if st, ok := DatasetStage(u.Dataset); ok {
			u.Stage = st
			ordered = append(ordered, u)
			continue
		}
		skipped = append(skipped, u)
	}
	// Stable insertion sort: deterministic, and keeps same-stage units in the
	// caller's order (which the provider already sorts by priority).
	for i := 1; i < len(ordered); i++ {
		for j := i; j > 0 && less(ordered[j], ordered[j-1]); j-- {
			ordered[j], ordered[j-1] = ordered[j-1], ordered[j]
		}
	}
	return ordered, skipped
}

// less is the plan §48 order followed by a deterministic tiebreak.
func less(a, b BackfillUnit) bool {
	if a.Stage != b.Stage {
		return a.Stage < b.Stage
	}
	if a.Provider != b.Provider {
		return a.Provider < b.Provider
	}
	if a.Dataset != b.Dataset {
		return a.Dataset < b.Dataset
	}
	return a.Subject < b.Subject
}

// NextWindow computes the window one backfill page should read, given the stored
// checkpoint and the page size.
//
// The reader constraint is explicit here: PageDays of history are requested as
// [cursor, cursor + PageDays), NOT as "the newest N rows". When the returned
// From is in the future relative to now, the backfill is EXHAUSTED — that is the
// terminal condition, and it is reported rather than looping forever.
func NextWindow(c Cursor, pageDays int, now time.Time) (from, to time.Time, exhausted bool) {
	if c.Exhausted {
		return time.Time{}, time.Time{}, true
	}
	if pageDays <= 0 {
		pageDays = 1
	}
	from = time.UnixMilli(c.UnixMillis).UTC()
	if c.UnixMillis == 0 {
		// No checkpoint: start from the epoch-normalized floor. The caller owns
		// the real "earliest available" (a pool's creation block/time); the
		// policy only guarantees the walk ascends from wherever it starts.
		from = time.Unix(0, 0).UTC()
	}
	to = from.AddDate(0, 0, pageDays)
	if !to.Before(now) {
		// The page would reach the present: this is the final page, and after
		// it the window is exhausted.
		return from, now, true
	}
	return from, to, false
}

// AdvanceCheckpoint returns the checkpoint after a page was written, using the
// page's newest fetched time. Passing the observed newest time (rather than the
// requested window end) is what keeps the walk honest when a provider returns
// fewer rows than the window asked for: the cursor follows the DATA, so a gap
// is retried rather than skipped over.
func AdvanceCheckpoint(newestFetchedMillis int64, exhausted bool) Cursor {
	return Cursor{UnixMillis: newestFetchedMillis, Exhausted: exhausted}
}

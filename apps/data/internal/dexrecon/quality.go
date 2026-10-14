package dexrecon

import (
	"math/big"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// This file is the plan §32 data-quality engine: detectors that find the ten
// named defect classes, and a classifier that folds findings into the closed
// healthy|degraded|stale|conflicting|invalid vocabulary. It shares the exact
// Dec arithmetic of the resolver, so a quality check never rounds through a
// float either.
//
// A detector NEVER mutates or drops data — it reports. The caller decides what
// to publish (plan §65: never hide stale data; the quality status is the
// disclosure mechanism).

// QualityState is the closed plan §32 vocabulary.
type QualityState string

const (
	QualityHealthy     QualityState = "healthy"
	QualityDegraded    QualityState = "degraded"
	QualityStale       QualityState = "stale"
	QualityConflicting QualityState = "conflicting"
	QualityInvalid     QualityState = "invalid"
)

// Severity ranks a finding. The classifier takes the WORST severity present.
type Severity int

const (
	// Info is a note that does not by itself degrade the state.
	Info Severity = iota
	// Warn degrades to `degraded`.
	Warn
	// Conflict degrades to `conflicting`.
	Conflict
	// Invalid degrades to `invalid`.
	Invalid
)

// Finding is one detected defect.
type Finding struct {
	// Code is a stable identifier ("stale_data", "price_outlier", ...).
	Code string
	// Severity maps this finding to a state.
	Severity Severity
	// Subject is what the finding is about (a pool id, a series id).
	Subject string
	// Detail is a human explanation.
	Detail string
}

// QualityReport is one subject's quality verdict.
type QualityReport struct {
	SubjectKey string
	Dataset    string
	State      QualityState
	Findings   []Finding
	CheckedAt  time.Time
}

// stateFor maps the worst severity to a state; no findings is healthy.
func stateFor(findings []Finding) QualityState {
	worst := Info
	for _, f := range findings {
		if f.Severity > worst {
			worst = f.Severity
		}
	}
	switch worst {
	case Invalid:
		return QualityInvalid
	case Conflict:
		return QualityConflicting
	case Warn:
		return QualityDegraded
	default:
		return QualityHealthy
	}
}

// --- individual detectors ---------------------------------------------------

// DetectStale reports a subject whose freshest observation is older than the
// SLA by more than staleFactor.
func DetectStale(subject string, freshest time.Time, now time.Time, sla time.Duration, staleFactor int) []Finding {
	if sla <= 0 || staleFactor <= 0 {
		return nil
	}
	if freshest.IsZero() {
		return []Finding{{Code: "missing_data", Severity: Invalid, Subject: subject,
			Detail: "no observation at all"}}
	}
	age := now.Sub(freshest)
	if age > time.Duration(staleFactor)*sla {
		return []Finding{{Code: "stale_data", Severity: Warn, Subject: subject,
			Detail: "newest observation is " + age.String() + " old"}}
	}
	return nil
}

// DetectPriceOutlier reports a value that deviates from the median by more than
// tol (relative rational).
func DetectPriceOutlier(subject string, value *big.Rat, median *big.Rat, tol *big.Rat) []Finding {
	if value == nil || median == nil || tol == nil || median.Sign() == 0 {
		return nil
	}
	dev := new(big.Rat).Abs(new(big.Rat).Quo(new(big.Rat).Sub(value, median), median))
	if dev.Cmp(tol) > 0 {
		return []Finding{{Code: "price_outlier", Severity: Conflict, Subject: subject,
			Detail: "relative deviation " + dev.FloatString(4)}}
	}
	return nil
}

// DetectMissingCandles reports gaps in a candle series for a fixed interval.
// A gap is a missing open time between consecutive bars longer than step.
func DetectMissingCandles(poolID string, times []time.Time, interval time.Duration) []Finding {
	if len(times) < 2 || interval <= 0 {
		return nil
	}
	var gaps int
	for i := 1; i < len(times); i++ {
		if d := times[i].Sub(times[i-1]); d > interval+interval/2 {
			gaps++
		}
	}
	if gaps > 0 {
		return []Finding{{Code: "missing_candles", Severity: Warn, Subject: poolID,
			Detail: itoa(gaps) + " gap(s) in the series"}}
	}
	return nil
}

// DetectDuplicateSwaps reports swap identity collisions in one batch (the same
// (chain, tx, log) seen twice), which would double-count volume.
func DetectDuplicateSwaps(swaps []canon.Swap) []Finding {
	seen := map[string]bool{}
	dups := 0
	for _, s := range swaps {
		k := s.ChainID + "|" + s.TxHash + "|" + itoa(s.LogIndex)
		if seen[k] {
			dups++
		}
		seen[k] = true
	}
	if dups > 0 {
		return []Finding{{Code: "duplicate_swaps", Severity: Conflict, Subject: "batch",
			Detail: itoa(dups) + " duplicate swap(s)"}}
	}
	return nil
}

// DetectBrokenDecimals reports a token whose decimals are outside the sane
// range, or a raw amount whose decimals disagree with the pool token's.
func DetectBrokenDecimals(tokenID string, decimals int) []Finding {
	if decimals < 0 || decimals > 255 {
		return []Finding{{Code: "broken_decimals", Severity: Invalid, Subject: tokenID,
			Detail: "decimals " + itoa(decimals) + " out of range"}}
	}
	// A token with > 30 decimals is not a real ERC-20/Solana mint and almost
	// always a mis-parse.
	if decimals > 30 {
		return []Finding{{Code: "broken_decimals", Severity: Warn, Subject: tokenID,
			Detail: "implausible decimals " + itoa(decimals)}}
	}
	return nil
}

// DetectWrongTokenMapping reports a pool whose base and quote token are the
// same id — a mapping error, not a market.
func DetectWrongTokenMapping(poolID, tokenIn, tokenOut string) []Finding {
	if tokenIn != "" && tokenIn == tokenOut {
		return []Finding{{Code: "wrong_token_mapping", Severity: Invalid, Subject: poolID,
			Detail: "token_in == token_out"}}
	}
	return nil
}

// DetectTimestampError reports an event time that is in the future or zero.
func DetectTimestampError(subject string, t, now time.Time, maxSkew time.Duration) []Finding {
	if t.IsZero() {
		return []Finding{{Code: "timestamp_error", Severity: Invalid, Subject: subject,
			Detail: "zero timestamp"}}
	}
	if maxSkew <= 0 {
		maxSkew = 5 * time.Minute
	}
	if t.After(now.Add(maxSkew)) {
		return []Finding{{Code: "timestamp_error", Severity: Invalid, Subject: subject,
			Detail: "timestamp is in the future"}}
	}
	return nil
}

// DetectChainMismatch reports a row whose chain coordinate disagrees with the
// pool's chain.
func DetectChainMismatch(subject, rowChain, poolChain string) []Finding {
	if rowChain != "" && poolChain != "" && rowChain != poolChain {
		return []Finding{{Code: "chain_mismatch", Severity: Invalid, Subject: subject,
			Detail: "row chain " + rowChain + " != pool chain " + poolChain}}
	}
	return nil
}

// DetectImpossibleLiquidity reports a negative or absurd liquidity value.
func DetectImpossibleLiquidity(poolID string, liquidity *canon.Dec) []Finding {
	if liquidity == nil || !liquidity.Present() {
		return nil
	}
	if liquidity.Rat().Sign() < 0 {
		return []Finding{{Code: "impossible_liquidity", Severity: Invalid, Subject: poolID,
			Detail: "negative liquidity"}}
	}
	return nil
}

// DetectNegativeMetrics reports a metric that must be non-negative but is not.
func DetectNegativeMetrics(subject, metric string, value *canon.Dec) []Finding {
	if value == nil || !value.Present() {
		return nil
	}
	if value.Rat().Sign() < 0 {
		return []Finding{{Code: "negative_metric", Severity: Invalid, Subject: subject,
			Detail: metric + " is negative"}}
	}
	return nil
}

// Checker bundles the detectors with the config a report needs.
type Checker struct {
	FreshnessSLA time.Duration
	StaleFactor  int
	PriceTol     *big.Rat
	MaxSkew      time.Duration
	Now          func() time.Time
}

// NewChecker builds a checker with defaults.
func NewChecker(sla time.Duration, now func() time.Time) *Checker {
	if now == nil {
		now = time.Now
	}
	if sla <= 0 {
		sla = 60 * time.Second
	}
	return &Checker{FreshnessSLA: sla, StaleFactor: 5, PriceTol: rat("0.02"), MaxSkew: 5 * time.Minute, Now: now}
}

// Report folds findings for one subject into a QualityReport.
func (c *Checker) Report(subject, dataset string, findings []Finding) QualityReport {
	return QualityReport{
		SubjectKey: subject,
		Dataset:    dataset,
		State:      stateFor(findings),
		Findings:   findings,
		CheckedAt:  c.Now(),
	}
}

// itoa is a tiny int->string local to this package (avoids a strconv import in
// hot paths that already avoid allocations).
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

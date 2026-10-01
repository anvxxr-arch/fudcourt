// Package ledger is the canonical record of financial movements (objective
// §8.17). Entries are objective facts about money that moved: every other
// domain (portfolio, treasury, transactions) derives from records like these
// and never edits them.
//
// The package is built around two refusals: a movement that moves nothing is
// not a record (zero amounts are rejected), and a movement whose origin cannot
// be reconstructed is not a record (trade settlements, funding and fees carry
// their reference). Entries are immutable — the package exposes no mutation
// method, and ingestion returns fresh slices so callers can share one ledger
// across goroutines without locks.
package ledger

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
)

// Kind classifies what produced a movement. The set is closed: an unlisted
// kind would make balances non-auditable, so NewEntry refuses it.
type Kind string

const (
	KindDeposit         Kind = "deposit"          // external cash in
	KindWithdrawal      Kind = "withdrawal"       // external cash out
	KindTransfer        Kind = "transfer"         // movement between our own accounts
	KindTradeSettlement Kind = "trade_settlement" // one leg of an executed trade (reference-bound)
	KindRealizedPnl     Kind = "realized_pnl"     // realized profit or loss of a closed position
	KindFee             Kind = "fee"              // fee charged on a referenced record (reference-bound)
	KindFunding         Kind = "funding"          // funding payment on a referenced position (reference-bound)
	KindRebate          Kind = "rebate"           // venue rebate
	KindReward          Kind = "reward"           // external reward or incentive
	KindAdjustment      Kind = "adjustment"       // manual correction — the only way history is amended
)

var validKinds = map[Kind]bool{
	KindDeposit:         true,
	KindWithdrawal:      true,
	KindTransfer:        true,
	KindTradeSettlement: true,
	KindRealizedPnl:     true,
	KindFee:             true,
	KindFunding:         true,
	KindRebate:          true,
	KindReward:          true,
	KindAdjustment:      true,
}

// referenceBoundKinds are the kinds whose origin MUST stay reconstructible:
// without their reference a settlement, funding leg or fee cannot be tied back
// to the event that produced it (origin preservation).
var referenceBoundKinds = map[Kind]bool{
	KindTradeSettlement: true,
	KindFunding:         true,
	KindFee:             true,
}

// Entry is one immutable financial-movement fact.
//
// Invariants: every Entry MUST come from NewEntry, which guarantees that
// Amount is a signed canonical decimal string (never zero) and that Kind is
// from the closed set. Amount is signed: positive credits AccountID, negative
// debits it. ReferenceType/ReferenceID name the record that caused the
// movement and are required for reference-bound kinds, absent otherwise.
// OccurredAtMs and CreatedAt are Unix milliseconds; the ledger never edits an
// existing Entry and never rewrites history — corrections are new entries of
// KindAdjustment.
type Entry struct {
	ID            string
	AccountID     string
	Asset         string
	Amount        string
	Kind          Kind
	ReferenceType string
	ReferenceID   string
	OccurredAtMs  int64
	CreatedAt     int64
}

// NewEntry validates e and returns it with Amount in canonical decimal form.
//
// It refuses: blank identity fields; an Amount that is not plain decimal
// notation or that is exactly zero (a movement that moves nothing is not a
// record); a Kind outside the closed set; and a reference-bound Kind without
// ReferenceType and ReferenceID. Every refusal is errs.CategoryValidation and
// names the offending field.
func NewEntry(e Entry) (Entry, error) {
	if strings.TrimSpace(e.ID) == "" {
		return Entry{}, errs.New(errs.CategoryValidation, "LEDGER_FIELD_REQUIRED", "id is required")
	}
	if strings.TrimSpace(e.AccountID) == "" {
		return Entry{}, errs.New(errs.CategoryValidation, "LEDGER_FIELD_REQUIRED", "accountID is required")
	}
	if strings.TrimSpace(e.Asset) == "" {
		return Entry{}, errs.New(errs.CategoryValidation, "LEDGER_FIELD_REQUIRED", "asset is required")
	}
	amount, ok := parseDecimal(e.Amount)
	if !ok {
		return Entry{}, errs.New(errs.CategoryValidation, "LEDGER_AMOUNT_INVALID",
			fmt.Sprintf("amount %q is not a decimal number", e.Amount))
	}
	if amount.Sign() == 0 {
		return Entry{}, errs.New(errs.CategoryValidation, "LEDGER_AMOUNT_INVALID",
			"amount must not be zero (a movement that moves nothing is not a ledger record)")
	}
	if !validKinds[e.Kind] {
		return Entry{}, errs.New(errs.CategoryValidation, "LEDGER_KIND_INVALID",
			fmt.Sprintf("kind %q is not one of deposit, withdrawal, transfer, trade_settlement, realized_pnl, fee, funding, rebate, reward, adjustment", e.Kind))
	}
	if referenceBoundKinds[e.Kind] && (strings.TrimSpace(e.ReferenceType) == "" || strings.TrimSpace(e.ReferenceID) == "") {
		return Entry{}, errs.New(errs.CategoryValidation, "LEDGER_REFERENCE_REQUIRED",
			fmt.Sprintf("kind %s requires referenceType and referenceID to preserve the movement's origin", e.Kind))
	}
	canonical, ok := renderDecimal(amount)
	if !ok {
		return Entry{}, errs.New(errs.CategoryValidation, "LEDGER_AMOUNT_INVALID",
			fmt.Sprintf("amount %q has no exact decimal representation", e.Amount))
	}
	e.Amount = canonical
	return e, nil
}

// IdempotencyKey returns the stable identity of e for ingestion dedup: the
// tuple (AccountID, Kind, ReferenceType, ReferenceID, OccurredAtMs), encoded
// length-prefixed so no two distinct tuples can produce the same key (naive
// separator joins collapse on values that contain the separator).
//
// Amount and CreatedAt are deliberately excluded: a re-delivered event must
// key identically to its first delivery regardless of ingestion time, and a
// second entry that names the same origin is a duplicate, not a correction.
func IdempotencyKey(e Entry) string {
	var b strings.Builder
	for _, field := range []string{
		e.AccountID,
		string(e.Kind),
		e.ReferenceType,
		e.ReferenceID,
		strconv.FormatInt(e.OccurredAtMs, 10),
	} {
		b.WriteString(strconv.Itoa(len(field)))
		b.WriteByte(':')
		b.WriteString(field)
	}
	return b.String()
}

// Ingest appends e to the canonical record exactly once. It returns a fresh
// slice (entries is never mutated) with e validated and canonicalized, and
// refuses a repeat of an existing IdempotencyKey with errs.CategoryConflict
// code LEDGER_DUPLICATE — replays are detected loudly, never silently
// overwritten ("idempotent ingestion, no silent overwrite").
func Ingest(entries []Entry, e Entry) ([]Entry, error) {
	normalized, err := NewEntry(e)
	if err != nil {
		return nil, err
	}
	key := IdempotencyKey(normalized)
	for _, existing := range entries {
		if IdempotencyKey(existing) == key {
			return nil, errs.New(errs.CategoryConflict, "LEDGER_DUPLICATE",
				fmt.Sprintf("an entry with the same origin already exists (account %s, kind %s, %s %s, occurredAt %d)",
					existing.AccountID, existing.Kind, existing.ReferenceType, existing.ReferenceID, existing.OccurredAtMs))
		}
	}
	out := make([]Entry, len(entries), len(entries)+1)
	copy(out, entries)
	return append(out, normalized), nil
}

// BalanceByAsset sums the signed amounts per asset with exact decimal
// arithmetic. An asset that appears in no entry is ABSENT from the result —
// absence is rendered as absence, never as a fabricated "0" — while an asset
// whose entries happen to sum to zero is present with "0", because that zero
// is the true sum of real records. Float64 summation is never used: 0.1+0.2
// must read "0.3", not "0.30000000000000004".
func BalanceByAsset(entries []Entry) (map[string]string, error) {
	sums := make(map[string]*rational)
	for _, e := range entries {
		amount, ok := parseDecimal(e.Amount)
		if !ok {
			return nil, errs.New(errs.CategoryValidation, "LEDGER_AMOUNT_INVALID",
				fmt.Sprintf("entry %s: amount %q is not a decimal number", e.ID, e.Amount))
		}
		if sums[e.Asset] == nil {
			sums[e.Asset] = amount
		} else {
			sums[e.Asset] = addDecimals(sums[e.Asset], amount)
		}
	}
	out := make(map[string]string, len(sums))
	for asset, sum := range sums {
		rendered, ok := renderDecimal(sum)
		if !ok {
			return nil, errs.New(errs.CategoryValidation, "LEDGER_AMOUNT_INVALID",
				fmt.Sprintf("asset %s: balance has no exact decimal representation", asset))
		}
		out[asset] = rendered
	}
	return out, nil
}

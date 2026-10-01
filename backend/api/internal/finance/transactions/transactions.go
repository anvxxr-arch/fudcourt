// Package transactions is the user-visible history of money movements
// (objective §8.21): a DERIVED view assembled from the canonical sources
// (ledger entries, trade settlements, on-chain records) — never a source of
// truth itself. Nothing here writes history; the package shapes, validates and
// orders rows the sources produced.
//
// The ordering rule exists because a derived view merged from several sources
// must render deterministically (the DR-019 lesson: an ordering without a
// total-order tiebreaker is a lie waiting for a second database). Provenance
// survives every operation — Source is never dropped.
package transactions

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
)

// Direction is the sign of a movement: "in" (>= 0) or "out" (< 0), exactly the
// SCHEMA.md §1.1 rule for amount_usd ("signed: >= 0 → IN, < 0 → OUT").
type Direction string

const (
	DirectionIn  Direction = "in"  // amount >= 0 (SCHEMA.md §1.1)
	DirectionOut Direction = "out" // amount < 0
)

// Table defaults mirrored from database/schema/schema.sql + SCHEMA.md §1.1:
// the real insert path fills these when the caller omits them, and a derived
// view must agree with the source it mirrors.
const (
	DefaultChain  = "Offchain" // schema default for chain
	DefaultAsset  = "USDT"     // schema default for asset
	DefaultSource = "manual"   // schema default for source
)

// Transaction is one user-visible history row, mirroring the real
// `transactions` table (database/schema/schema.sql).
//
// Invariants (enforced by New): Date is a valid YYYY-MM-DD calendar date and
// Event is non-empty (the table requires both on insert); AmountUSD is a
// signed canonical decimal string; Direction is in/out and agrees with the
// amount's sign (derived from it when absent, never contradicted). Hash is
// nullable on the table, but exact on-chain reconciliation REQUIRES it
// (SCHEMA.md §1.1: "hash — required for exact reconciliation") — rows without
// it are for display, not reconciliation. Source names where the row came from
// and must survive every merge.
type Transaction struct {
	ID        int64
	Date      string
	Chain     string
	Asset     string
	Event     string
	AmountUSD string
	Direction Direction
	Memo      string
	WalletTo  string
	VenueID   string
	TradeID   string
	Hash      string
	URL       string
	Source    string
}

// DirectionOf derives the direction from a signed amount exactly as SCHEMA.md
// §1.1 defines it: >= 0 is "in", < 0 is "out". The zero amount is "in" — the
// schema's rule, kept as written rather than second-guessed. Unparsable
// amounts are refused with errs.CategoryValidation naming the field.
func DirectionOf(amount string) (Direction, error) {
	r, ok := parseDecimal(amount)
	if !ok {
		return "", errs.New(errs.CategoryValidation, "TXN_AMOUNT_INVALID",
			fmt.Sprintf("amount %q is not a decimal number", amount))
	}
	if r.Sign() < 0 {
		return DirectionOut, nil
	}
	return DirectionIn, nil
}

// New validates t and returns it with AmountUSD canonicalized, Direction
// derived from the sign when absent, and the table's documented defaults
// applied to empty Chain/Asset/Source.
//
// Refusals (errs.CategoryValidation, message naming the field): a missing or
// malformed date (TXN_DATE_REQUIRED / TXN_DATE_INVALID); a missing event
// (TXN_EVENT_REQUIRED); an unparsable amount (TXN_AMOUNT_INVALID); a Direction
// outside in/out (TXN_DIRECTION_CONFLICT); and — the disagreement rule — an
// explicit Direction that contradicts the amount's sign
// (TXN_DIRECTION_CONFLICT): a row whose sign and direction disagree cannot
// both be true, so the view refuses rather than pick one.
func New(t Transaction) (Transaction, error) {
	if strings.TrimSpace(t.Date) == "" {
		return Transaction{}, errs.New(errs.CategoryValidation, "TXN_DATE_REQUIRED", "date is required")
	}
	if _, err := time.Parse("2006-01-02", t.Date); err != nil {
		return Transaction{}, errs.New(errs.CategoryValidation, "TXN_DATE_INVALID",
			fmt.Sprintf("date %q is not a YYYY-MM-DD calendar date", t.Date))
	}
	if strings.TrimSpace(t.Event) == "" {
		return Transaction{}, errs.New(errs.CategoryValidation, "TXN_EVENT_REQUIRED", "event is required")
	}
	amount, ok := parseDecimal(t.AmountUSD)
	if !ok {
		return Transaction{}, errs.New(errs.CategoryValidation, "TXN_AMOUNT_INVALID",
			fmt.Sprintf("amount %q is not a decimal number", t.AmountUSD))
	}
	canonical, ok := renderDecimal(amount)
	if !ok {
		return Transaction{}, errs.New(errs.CategoryValidation, "TXN_AMOUNT_INVALID",
			fmt.Sprintf("amount %q has no exact decimal representation", t.AmountUSD))
	}
	t.AmountUSD = canonical

	derived, err := DirectionOf(t.AmountUSD)
	if err != nil {
		return Transaction{}, err
	}
	switch t.Direction {
	case "":
		t.Direction = derived
	case DirectionIn, DirectionOut:
		if t.Direction != derived {
			return Transaction{}, errs.New(errs.CategoryValidation, "TXN_DIRECTION_CONFLICT",
				fmt.Sprintf("direction %q contradicts amount %s (its sign derives %q)",
					t.Direction, t.AmountUSD, derived))
		}
	default:
		return Transaction{}, errs.New(errs.CategoryValidation, "TXN_DIRECTION_CONFLICT",
			fmt.Sprintf("direction %q is not in or out", t.Direction))
	}

	if t.Chain == "" {
		t.Chain = DefaultChain
	}
	if t.Asset == "" {
		t.Asset = DefaultAsset
	}
	if t.Source == "" {
		t.Source = DefaultSource
	}
	return t, nil
}

// Merge concatenates history slices into one view ordered by Date descending,
// then ID descending — the total-order tiebreaker mirror.ts applies to every
// query (`ORDER BY date DESC, id DESC`): two rows can share a date, and a
// merged view without a tiebreaker renders in whatever order the map iteration
// left it. Rows equal on (Date, ID) keep their merge order (stable sort), so
// the output is deterministic for deterministic input.
//
// Merge never drops or rewrites rows — deduplication is the source of truth's
// job, and a derived view that silently drops a row loses provenance (Source
// is carried through untouched).
func Merge(lists ...[]Transaction) []Transaction {
	total := 0
	for _, l := range lists {
		total += len(l)
	}
	out := make([]Transaction, 0, total)
	for _, l := range lists {
		out = append(out, l...)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Date != out[j].Date {
			return out[i].Date > out[j].Date
		}
		return out[i].ID > out[j].ID
	})
	return out
}

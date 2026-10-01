// Package treasury tracks the platform's OWN capital — organization/team/wallet
// accounts and the money parked in them (objective §8.19). It is deliberately
// separate from portfolio: portfolio answers "what are our positions worth",
// treasury answers "which internal account is funding this, and how much of it
// is already reserved".
//
// Every figure is an exact decimal string (math/big rationals, never float64).
// The package refuses inconsistent money — negative, unparsable or
// insufficient — with the offending figures named in the message; it never
// clamps a number into range and never treats an unknown balance as zero.
package treasury

import (
	"fmt"
	"strings"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
)

// OwnerKind classifies who owns a treasury account. The set is closed: an
// unlisted owner kind would make internal capital unauditable.
type OwnerKind string

const (
	OwnerOrganization OwnerKind = "organization" // the platform's own capital
	OwnerTeam         OwnerKind = "team"         // a team's ring-fenced capital
	OwnerWallet       OwnerKind = "wallet"       // capital parked in a chain wallet
)

// Account is one internal capital account, holding a single asset.
//
// Invariants: ID, OwnerID and Asset are non-empty; OwnerKind is from the
// closed set. One account holds ONE asset — multi-asset balances are several
// accounts, so every movement names the asset it moves.
type Account struct {
	ID        string
	OwnerKind OwnerKind
	OwnerID   string
	Asset     string
}

// Allocation splits one account's total into reserved and available.
//
// Invariant: Reserved + Available equals the account's total exactly — both
// figures are exact decimal strings and nothing is lost to rounding.
type Allocation struct {
	AccountID string
	Reserved  string
	Available string
}

// Movement is an internal transfer between treasury accounts.
//
// Invariants: FromAccountID and ToAccountID are distinct non-empty accounts;
// Asset is the asset moved (an account moves only in its own asset — the
// ingestion layer matches them); Amount is a strictly POSITIVE exact decimal
// magnitude and the movement goes From → To ("positive = into ToAccount");
// Reason is non-empty — internal capital that moves without a stated reason is
// unauditable. OccurredAt is Unix milliseconds.
type Movement struct {
	ID            string
	FromAccountID string
	ToAccountID   string
	Asset         string
	Amount        string
	Reason        string
	OccurredAt    int64
}

// Balances maps account ID → that account's exact signed decimal balance in
// its single asset.
//
// Invariant: every account a caller feeds to Move must be present — absence
// means UNKNOWN, not zero, so Move refuses to touch an account it cannot see
// rather than inventing a starting balance.
type Balances map[string]string

// Allocate splits total into reserved and available for one account, refusing
// anything it cannot compute honestly: unparsable or negative decimals
// (never clamped into range) with errs.CategoryValidation naming the field,
// and a reserve larger than the total with errs.CategoryInsufficientBalance
// naming both figures (required=reserve, available=total) — the split must
// keep Reserved + Available == total, which a clamped reserve would silently
// violate.
func Allocate(accountID, total, reserve string) (Allocation, error) {
	if strings.TrimSpace(accountID) == "" {
		return Allocation{}, errs.New(errs.CategoryValidation, "TREASURY_FIELD_REQUIRED", "accountID is required")
	}
	tot, ok := parseDecimal(total)
	if !ok {
		return Allocation{}, errs.New(errs.CategoryValidation, "TREASURY_AMOUNT_INVALID",
			fmt.Sprintf("total %q is not a decimal number", total))
	}
	res, ok := parseDecimal(reserve)
	if !ok {
		return Allocation{}, errs.New(errs.CategoryValidation, "TREASURY_AMOUNT_INVALID",
			fmt.Sprintf("reserve %q is not a decimal number", reserve))
	}
	if tot.Sign() < 0 {
		return Allocation{}, errs.New(errs.CategoryValidation, "TREASURY_AMOUNT_INVALID",
			fmt.Sprintf("total %q must not be negative", total))
	}
	if res.Sign() < 0 {
		return Allocation{}, errs.New(errs.CategoryValidation, "TREASURY_AMOUNT_INVALID",
			fmt.Sprintf("reserve %q must not be negative (never clamped into range)", reserve))
	}
	if res.Cmp(tot) > 0 {
		return Allocation{}, errs.New(errs.CategoryInsufficientBalance, "TREASURY_INSUFFICIENT_FUNDS",
			fmt.Sprintf("reserve exceeds total (required=%s, available=%s)", renderAmount(res), renderAmount(tot)))
	}
	available := subDecimals(tot, res)
	reservedStr, ok1 := renderDecimal(res)
	availableStr, ok2 := renderDecimal(available)
	if !ok1 || !ok2 {
		return Allocation{}, errs.New(errs.CategoryValidation, "TREASURY_AMOUNT_INVALID",
			"allocation figures have no exact decimal representation")
	}
	return Allocation{AccountID: accountID, Reserved: reservedStr, Available: availableStr}, nil
}

// Move applies movements to balances in order and returns the resulting
// balances as a NEW map — the input is never mutated, so one snapshot can be
// replayed or shared across goroutines.
//
// It refuses with errs.CategoryValidation naming the field: blank movement
// fields, a movement whose from and to are the same account, an amount that is
// not a strictly positive decimal (direction is From → To; a signed amount
// would double-encode it), and a movement touching an account absent from
// balances (TREASURY_ACCOUNT_UNKNOWN — absence is unknown, never zero). A move
// exceeding the source balance is refused with errs.CategoryInsufficientBalance
// code TREASURY_INSUFFICIENT_FUNDS naming both figures in required/available
// form; later movements then see the earlier ones' effects (multi-hop
// derivation).
func Move(balances Balances, movements []Movement) (Balances, error) {
	out := make(Balances, len(balances))
	for account, balance := range balances {
		if _, ok := parseDecimal(balance); !ok {
			return nil, errs.New(errs.CategoryValidation, "TREASURY_AMOUNT_INVALID",
				fmt.Sprintf("account %s: balance %q is not a decimal number", account, balance))
		}
		out[account] = balance
	}
	for _, m := range movements {
		if strings.TrimSpace(m.FromAccountID) == "" {
			return nil, errs.New(errs.CategoryValidation, "TREASURY_FIELD_REQUIRED", "movement fromAccountID is required")
		}
		if strings.TrimSpace(m.ToAccountID) == "" {
			return nil, errs.New(errs.CategoryValidation, "TREASURY_FIELD_REQUIRED", "movement toAccountID is required")
		}
		if m.FromAccountID == m.ToAccountID {
			return nil, errs.New(errs.CategoryValidation, "TREASURY_MOVEMENT_INVALID",
				fmt.Sprintf("movement %s: fromAccountID and toAccountID are both %s", m.ID, m.FromAccountID))
		}
		if strings.TrimSpace(m.Asset) == "" {
			return nil, errs.New(errs.CategoryValidation, "TREASURY_FIELD_REQUIRED", "movement asset is required")
		}
		if strings.TrimSpace(m.Reason) == "" {
			return nil, errs.New(errs.CategoryValidation, "TREASURY_FIELD_REQUIRED", "movement reason is required")
		}
		amount, ok := parseDecimal(m.Amount)
		if !ok {
			return nil, errs.New(errs.CategoryValidation, "TREASURY_AMOUNT_INVALID",
				fmt.Sprintf("movement %s: amount %q is not a decimal number", m.ID, m.Amount))
		}
		if amount.Sign() <= 0 {
			return nil, errs.New(errs.CategoryValidation, "TREASURY_AMOUNT_INVALID",
				fmt.Sprintf("movement %s: amount %q must be positive (direction is From → To)", m.ID, m.Amount))
		}
		from, ok := out[m.FromAccountID]
		if !ok {
			return nil, errs.New(errs.CategoryValidation, "TREASURY_ACCOUNT_UNKNOWN",
				fmt.Sprintf("movement %s: account %s has no recorded balance (absence is unknown, not zero)", m.ID, m.FromAccountID))
		}
		to, ok := out[m.ToAccountID]
		if !ok {
			return nil, errs.New(errs.CategoryValidation, "TREASURY_ACCOUNT_UNKNOWN",
				fmt.Sprintf("movement %s: account %s has no recorded balance (absence is unknown, not zero)", m.ID, m.ToAccountID))
		}
		fromBal, _ := parseDecimal(from)
		if amount.Cmp(fromBal) > 0 {
			return nil, errs.New(errs.CategoryInsufficientBalance, "TREASURY_INSUFFICIENT_FUNDS",
				fmt.Sprintf("account %s cannot fund movement %s (required=%s, available=%s)",
					m.FromAccountID, m.ID, renderAmount(amount), renderAmount(fromBal)))
		}
		toBal, _ := parseDecimal(to)
		out[m.FromAccountID] = renderAmount(subDecimals(fromBal, amount))
		out[m.ToAccountID] = renderAmount(addDecimals(toBal, amount))
	}
	return out, nil
}

// renderAmount renders an exact-decimal rational produced by this package's
// decimal-closed arithmetic; the ok-less form exists because those results are
// exact decimals by construction.
func renderAmount(r *rational) string {
	s, _ := renderDecimal(r)
	return s
}

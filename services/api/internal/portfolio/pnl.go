package portfolio

import (
	"fmt"
	"strings"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
)

// pnlScale is the labelled rendering scale for a derived P&L whose exact value
// has a repeating decimal expansion. See RealizedPnl.
const pnlScale = 10

// EntryFill is one opening fill of a position: a purchase on a long, a sale on
// a short.
//
// Invariants: Side names the position side this fill opens (never the venue
// order side — a short entry is a venue sell); Price is an exact decimal;
// Quantity is an exact non-negative decimal magnitude (direction lives in
// Side); Fee is the exact USD fee charged on this fill, "0" when none.
type EntryFill struct {
	Side     Side
	Price    string
	Quantity string
	Fee      string
}

// ExitFill is one closing fill of a position: a sale on a long, a purchase on a
// short. Invariants match EntryFill.
type ExitFill struct {
	Side     Side
	Price    string
	Quantity string
	Fee      string
}

// RealizedPnl returns the signed realized P&L in USD of one closed position,
// mirroring the executor's summarizePortfolioRisk rollup
// (apps/web/src/platform/executor/store.ts: `exit_value − exit_qty ×
// average_fill_price − fees`) and the runtime.ts sign conventions:
//
//	long:  exit proceeds − average entry × exited quantity − fees
//	short: average entry × exited quantity − exit proceeds − fees
//
// so a SHORT profits when the exit price is BELOW the entry price — the side
// flip evaluatePositionPolicy encodes with signed quantities (positive = long,
// negative = short). Every fee on both legs is subtracted ("minus every fee on
// the execution"). The result is exact decimal (never float64) and may be
// negative, "0" or positive.
//
// All entry fills must share one Side and all exit fills that same Side — one
// closed position has one side, and a mix is refused with
// errs.CategoryValidation rather than netted. Average entry is the exact
// rational Σ(price×qty)/Σ(qty) over the entry fills (the summarizeFills
// formula). The final figure is rendered exactly when its decimal expansion is
// finite; a repeating expansion (e.g. closing 1 of 3 units opened at 10 and 11
// leaves basis 32/3) has no exact decimal form and is rendered half-up at 10
// decimal places — the derived figure's single labelled approximation.
func RealizedPnl(entries []EntryFill, exits []ExitFill) (string, error) {
	var side Side
	basis, basisQty, fees := (*rational)(nil), (*rational)(nil), (*rational)(nil)
	proceeds, exitQty := (*rational)(nil), (*rational)(nil)

	for i, f := range entries {
		if err := checkFill(&side, f.Side, f.Price, f.Quantity, f.Fee, "entry", i); err != nil {
			return "", err
		}
		price := mustDecimal(f.Price)
		qty := mustDecimal(f.Quantity)
		fee := mustDecimal(f.Fee)
		if basis == nil {
			basis, basisQty, fees = mulDecimals(price, qty), qty, fee
		} else {
			basis = addDecimals(basis, mulDecimals(price, qty))
			basisQty = addDecimals(basisQty, qty)
			fees = addDecimals(fees, fee)
		}
	}
	for i, f := range exits {
		if err := checkFill(&side, f.Side, f.Price, f.Quantity, f.Fee, "exit", i); err != nil {
			return "", err
		}
		price := mustDecimal(f.Price)
		qty := mustDecimal(f.Quantity)
		fee := mustDecimal(f.Fee)
		if proceeds == nil {
			proceeds, exitQty = mulDecimals(price, qty), qty
		} else {
			proceeds = addDecimals(proceeds, mulDecimals(price, qty))
			exitQty = addDecimals(exitQty, qty)
		}
		if fees == nil {
			fees = fee
		} else {
			fees = addDecimals(fees, fee)
		}
	}
	if basis == nil || proceeds == nil {
		return "", errs.New(errs.CategoryValidation, "PORTFOLIO_FILLS_REQUIRED",
			"realized P&L needs at least one entry fill and one exit fill")
	}

	// basis × exitedQty / entryQty — the exact average-entry value of the
	// exited quantity, kept as a rational so nothing rounds mid-formula.
	basisOfExited := quoDecimals(mulDecimals(basis, exitQty), basisQty)

	diff := subDecimals(proceeds, basisOfExited) // long shape: exit proceeds − avgEntry × exitedQty
	if side == SideShort {
		diff = subDecimals(basisOfExited, proceeds) // short shape: entry value − exit cost
	}
	return renderPnl(subDecimals(diff, fees)), nil
}

// checkFill validates one fill and enforces one side per closed position,
// initializing seen on the first fill. A mixed-side "position" has no coherent
// P&L sign, so it is refused, never averaged.
func checkFill(seen *Side, s Side, price, quantity, fee, leg string, i int) error {
	if strings.TrimSpace(price) == "" || strings.TrimSpace(quantity) == "" || strings.TrimSpace(fee) == "" {
		return errs.New(errs.CategoryValidation, "PORTFOLIO_AMOUNT_INVALID",
			fmt.Sprintf("%s fill %d: price, quantity and fee are all required", leg, i))
	}
	if _, ok := parseDecimal(price); !ok {
		return errs.New(errs.CategoryValidation, "PORTFOLIO_AMOUNT_INVALID",
			fmt.Sprintf("%s fill %d: price %q is not a decimal number", leg, i, price))
	}
	q, ok := parseDecimal(quantity)
	if !ok {
		return errs.New(errs.CategoryValidation, "PORTFOLIO_AMOUNT_INVALID",
			fmt.Sprintf("%s fill %d: quantity %q is not a decimal number", leg, i, quantity))
	}
	if q.Sign() < 0 {
		return errs.New(errs.CategoryValidation, "PORTFOLIO_AMOUNT_INVALID",
			fmt.Sprintf("%s fill %d: quantity %q must be an unsigned magnitude (side carries direction)", leg, i, quantity))
	}
	if _, ok := parseDecimal(fee); !ok {
		return errs.New(errs.CategoryValidation, "PORTFOLIO_AMOUNT_INVALID",
			fmt.Sprintf("%s fill %d: fee %q is not a decimal number", leg, i, fee))
	}
	if s != SideLong && s != SideShort {
		return errs.New(errs.CategoryValidation, "PORTFOLIO_SIDE_INVALID",
			fmt.Sprintf("%s fill %d: side %q is not long or short", leg, i, s))
	}
	if *seen == "" {
		*seen = s
		return nil
	}
	if *seen != s {
		return errs.New(errs.CategoryValidation, "PORTFOLIO_SIDE_INVALID",
			fmt.Sprintf("%s fill %d: side %q contradicts the position's %s side", leg, i, s, *seen))
	}
	return nil
}

// mustDecimal re-parses a field checkFill already validated. It exists because
// checkFill and the accumulation loop walk the same fills; the values are
// validated decimal notation by contract.
func mustDecimal(s string) *rational {
	r, _ := parseDecimal(s)
	return r
}

// renderPnl renders the exact rational result: exactly when its decimal
// expansion is finite, otherwise half-up at pnlScale decimal places (a
// repeating expansion cannot be spelled as a decimal string at any length).
// This is the package's single labelled approximation and only ever applies to
// a DERIVED figure; never float64.
func renderPnl(r *rational) string {
	if s, ok := renderDecimal(r); ok {
		return s
	}
	return r.FloatString(pnlScale)
}

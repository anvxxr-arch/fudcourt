// Package portfolio is the DERIVED view of holdings and positions (objective
// §8.18): it computes what the canonical sources (ledger, trades, prices)
// imply and never mutates them. Every figure here is traceable to a holding
// quantity, a price, or an entry basis — the package invents nothing.
//
// The honesty rule runs through the whole package: a value that is not known
// is a nil pointer rendered as absent, NEVER a fabricated 0, and a total that
// would mix known and unknown inputs is itself unknown. All money arithmetic
// is exact decimal (math/big rationals); float64 never touches a value.
package portfolio

import (
	"fmt"
	"sort"
	"time"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
)

// Holding is one asset quantity held on some venue or wallet.
//
// Invariants: Quantity is an exact non-negative decimal string. ValueUSD is
// the value of the holding as known to the view — filled in by Derive from the
// price table, or nil when no price was observed — and never "0" standing in
// for unknown.
type Holding struct {
	Asset    string
	Quantity string
	ValueUSD *string
}

// Side is the direction a position profits from: "long" profits when the price
// rises, "short" when it falls. Quantities are unsigned magnitudes and Side
// carries direction (the executor's signed-quantity convention: positive =
// long, negative = short — evaluatePositionPolicy, runtime.ts).
type Side string

const (
	SideLong  Side = "long"  // profits when the price rises
	SideShort Side = "short" // profits when the price falls
)

// Position is one open exposure in an instrument.
//
// Invariants: Side is long or short; Quantity and EntryPrice are exact decimal
// strings with Quantity an unsigned magnitude (the side carries direction).
// UnrealizedPnl is nil when no mark price is known — never 0 standing in for
// unknown.
type Position struct {
	InstrumentID  string
	Side          Side
	Quantity      string
	EntryPrice    string
	UnrealizedPnl *string
}

// Exposure is the notional one instrument is exposed to.
//
// Invariant: NotionalUSD is an exact non-negative decimal string — gross
// magnitude; direction lives on Position.Side.
type Exposure struct {
	Asset       string
	NotionalUSD string
}

// Valuation is the derived view of a portfolio at one moment.
//
// Invariants: TotalValueUSD is nil whenever any holding lacks a price (and
// MissingPrices then lists exactly those assets); it is non-nil only when
// every holding is fully priced. MissingPrices is always sorted, so the view
// renders deterministically. Positions is a composing slot: Derive values
// holdings from the price table, and callers that hold live venue positions
// attach them to the returned view (positions are marked by the venue, not by
// the price table, so they never silently enter the total). AsOf is Unix
// milliseconds of when the view was derived — a snapshot must say when it was
// valid.
type Valuation struct {
	Holdings      []Holding
	Positions     []Position
	TotalValueUSD *string
	MissingPrices []string
	AsOf          int64
}

// Derive values holdings against a price table (asset → exact decimal USD
// price) and returns the view. Each holding's ValueUSD is re-derived as
// quantity × price — a derived view derives, it does not trust hand-entered
// values — and is nil when the price table has no entry for the asset.
//
// TotalValueUSD is the exact sum over holdings WITH prices — but if even one
// holding lacks a price, the total is nil and MissingPrices lists the unpriced
// assets: a total that silently ignores an unpriced holding understates the
// portfolio, which is worse than showing no total at all. An empty portfolio
// has total "0" (a real zero: nothing is unknown). Unparsable quantities or
// prices are refused with errs.CategoryValidation naming the field, never
// rounded or clamped.
func Derive(holdings []Holding, prices map[string]string) (Valuation, error) {
	out := make([]Holding, len(holdings))
	var total *rational
	pricedAny := false
	missing := map[string]bool{}
	for i, h := range holdings {
		qty, ok := parseDecimal(h.Quantity)
		if !ok {
			return Valuation{}, errs.New(errs.CategoryValidation, "PORTFOLIO_AMOUNT_INVALID",
				fmt.Sprintf("holding %s: quantity %q is not a decimal number", h.Asset, h.Quantity))
		}
		if qty.Sign() < 0 {
			return Valuation{}, errs.New(errs.CategoryValidation, "PORTFOLIO_AMOUNT_INVALID",
				fmt.Sprintf("holding %s: quantity %q must not be negative", h.Asset, h.Quantity))
		}
		out[i] = Holding{Asset: h.Asset, Quantity: h.Quantity}
		priceStr, hasPrice := prices[h.Asset]
		if !hasPrice {
			missing[h.Asset] = true
			continue
		}
		price, ok := parseDecimal(priceStr)
		if !ok {
			return Valuation{}, errs.New(errs.CategoryValidation, "PORTFOLIO_AMOUNT_INVALID",
				fmt.Sprintf("holding %s: price %q is not a decimal number", h.Asset, priceStr))
		}
		value := mulDecimals(qty, price)
		rendered, ok := renderDecimal(value)
		if !ok {
			return Valuation{}, errs.New(errs.CategoryValidation, "PORTFOLIO_AMOUNT_INVALID",
				fmt.Sprintf("holding %s: value has no exact decimal representation", h.Asset))
		}
		out[i].ValueUSD = &rendered
		if pricedAny {
			total = addDecimals(total, value)
		} else {
			total, pricedAny = value, true
		}
	}

	v := Valuation{
		Holdings:      out,
		MissingPrices: sortedKeys(missing),
		AsOf:          time.Now().UnixMilli(),
	}
	if len(missing) > 0 {
		// Honest-null rule: a portfolio with an unpriced holding has no known
		// total, however many other holdings are priced.
		return v, nil
	}
	if !pricedAny {
		zero := "0"
		v.TotalValueUSD = &zero
		return v, nil
	}
	rendered, ok := renderDecimal(total)
	if !ok {
		return Valuation{}, errs.New(errs.CategoryValidation, "PORTFOLIO_AMOUNT_INVALID",
			"total value has no exact decimal representation")
	}
	v.TotalValueUSD = &rendered
	return v, nil
}

// ExposureByAsset derives gross notional per instrument from open positions
// (notional = quantity × entry price, exact), grouped on InstrumentID — for a
// derivatives position the instrument (e.g. BTCUSDT) is the exposure key the
// "exposure by asset" view groups on; positions sharing an instrument are
// summed. Quantities are unsigned magnitudes and the side carries direction,
// so notional is gross and non-negative. The result is sorted by asset so the
// view renders deterministically. Unparsable inputs are refused with
// errs.CategoryValidation naming the field.
func ExposureByAsset(positions []Position) ([]Exposure, error) {
	notional := map[string]*rational{}
	for _, p := range positions {
		qty, ok := parseDecimal(p.Quantity)
		if !ok {
			return nil, errs.New(errs.CategoryValidation, "PORTFOLIO_AMOUNT_INVALID",
				fmt.Sprintf("position %s: quantity %q is not a decimal number", p.InstrumentID, p.Quantity))
		}
		price, ok := parseDecimal(p.EntryPrice)
		if !ok {
			return nil, errs.New(errs.CategoryValidation, "PORTFOLIO_AMOUNT_INVALID",
				fmt.Sprintf("position %s: entryPrice %q is not a decimal number", p.InstrumentID, p.EntryPrice))
		}
		if qty.Sign() < 0 {
			return nil, errs.New(errs.CategoryValidation, "PORTFOLIO_AMOUNT_INVALID",
				fmt.Sprintf("position %s: quantity %q must not be negative", p.InstrumentID, p.Quantity))
		}
		n := mulDecimals(qty, price)
		if prev := notional[p.InstrumentID]; prev != nil {
			n = addDecimals(prev, n)
		}
		notional[p.InstrumentID] = n
	}
	out := make([]Exposure, 0, len(notional))
	for asset, n := range notional {
		rendered, ok := renderDecimal(n)
		if !ok {
			return nil, errs.New(errs.CategoryValidation, "PORTFOLIO_AMOUNT_INVALID",
				fmt.Sprintf("position %s: notional has no exact decimal representation", asset))
		}
		out = append(out, Exposure{Asset: asset, NotionalUSD: rendered})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Asset < out[j].Asset })
	return out, nil
}

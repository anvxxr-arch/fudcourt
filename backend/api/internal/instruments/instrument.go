// Package instruments is the canonical, exchange-agnostic instrument model
// (PRD §70–§71, DR-020) plus the two pieces of real logic the rest of the
// domain leans on: venue-symbol normalization and exact decimal grid rounding.
//
// Every numeric field is a decimal STRING, never float64: price and quantity
// grids must survive JSON round-trips and 1e12-scale arithmetic exactly, which
// binary floats cannot promise. All arithmetic here goes through math/big.
package instruments

import (
	"fmt"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
)

// Stable refusal codes for this domain. Clients branch on these, so they are
// frozen once shipped.
const (
	// CodeSymbolUnknown marks a venue symbol that cannot be normalized without
	// guessing, or an instrument missing its symbol identity.
	CodeSymbolUnknown = "INSTRUMENT_SYMBOL_UNKNOWN"
	// CodeStepInvalid marks a grid parameter (quantity_step, tick_size and the
	// other positive grid fields) that is absent, unparseable or not positive.
	CodeStepInvalid = "INSTRUMENT_STEP_INVALID"
	// CodeQuantityInvalid marks a quantity input that cannot be rounded
	// without guessing (empty, unparseable or negative).
	CodeQuantityInvalid = "INSTRUMENT_QUANTITY_INVALID"
	// CodePriceInvalid marks a price input that cannot be rounded without
	// guessing (empty, unparseable or negative).
	CodePriceInvalid = "INSTRUMENT_PRICE_INVALID"
)

// MarketType names the instrument's market family. It mirrors the web
// executor's MarketType (apps/web/src/platform/executor/types.ts:
// 'spot' | 'linear_perp'), including the linear_perp spelling.
type MarketType string

const (
	// MarketTypeSpot is the spot market family.
	MarketTypeSpot MarketType = "spot"
	// MarketTypeLinearPerp is USDT-linear perpetual futures.
	MarketTypeLinearPerp MarketType = "linear_perp"
)

// Instrument is one tradable market on one venue. INVARIANT: every numeric
// field is a decimal string (integers included, so they too carry no float
// dust); the grid fields must be positive where Validate says they must, and
// are never clamped into range.
//
// Optional decimal fields use the honest-absence rule: the empty string means
// "the venue did not report it", never zero.
type Instrument struct {
	InstrumentID string `json:"instrument_id"`
	BaseAsset    string `json:"base_asset"`
	QuoteAsset   string `json:"quote_asset"`
	MarketType   MarketType `json:"market_type"`
	Exchange     string `json:"exchange"`
	// ExchangeSymbol is the symbol exactly as the venue spells it; use
	// CanonicalSymbol to normalize, VenueSymbol to invert.
	ExchangeSymbol string `json:"exchange_symbol"`
	// TickSize is the price grid increment (e.g. "0.01"). Must be positive.
	TickSize string `json:"tick_size"`
	// QuantityStep is the quantity grid increment (e.g. "0.001"). Must be
	// positive; RoundQuantityDown floors onto it.
	QuantityStep string `json:"quantity_step"`
	// MinQuantity is the venue's minimum order quantity, empty if unreported.
	MinQuantity string `json:"min_quantity"`
	// MinNotional is the venue's minimum order notional, empty if unreported.
	MinNotional string `json:"min_notional"`
	// ContractSize is the contract multiplier applied to quantity to get
	// notional ("1" for spot). Must be positive: a zero would silently zero
	// out every notional computed from it.
	ContractSize string `json:"contract_size"`
	// PricePrecision is the number of decimal places the venue prints for
	// prices. Zero is legal (whole-unit prices).
	PricePrecision int `json:"price_precision"`
	// QuantityPrecision is the number of decimal places the venue prints for
	// quantities. Zero is legal (whole-unit quantities).
	QuantityPrecision int `json:"quantity_precision"`
	// MaxLeverage is the venue's leverage ceiling (1 = no leverage).
	MaxLeverage int `json:"max_leverage"`
}

// Validate checks the instrument's grid invariants without ever repairing
// them. Required grid fields (tick_size, quantity_step, contract_size) must be
// present and strictly positive; optional grid fields (min_quantity,
// min_notional) must be strictly positive whenever present. The base and quote
// identity must be present. Anything else is refused, never clamped: a
// malformed grid would silently misprice every order rounded against it.
func Validate(i Instrument) error {
	if i.BaseAsset == "" {
		return errs.New(errs.CategoryValidation, CodeSymbolUnknown, "field base_asset is required")
	}
	if i.QuoteAsset == "" {
		return errs.New(errs.CategoryValidation, CodeSymbolUnknown, "field quote_asset is required")
	}
	for _, grid := range []struct {
		name     string
		value    string
		required bool
	}{
		{"tick_size", i.TickSize, true},
		{"quantity_step", i.QuantityStep, true},
		{"contract_size", i.ContractSize, true},
		{"min_quantity", i.MinQuantity, false},
		{"min_notional", i.MinNotional, false},
	} {
		if grid.value == "" {
			if grid.required {
				return errs.New(errs.CategoryValidation, CodeStepInvalid, fmt.Sprintf("field %s is required", grid.name))
			}
			continue // honest absence: an unreported minimum is not a zero minimum
		}
		d, err := parseDecimal(grid.value)
		if err != nil {
			return errs.Wrap(errs.CategoryValidation, CodeStepInvalid, fmt.Sprintf("field %s must be a plain decimal", grid.name), err)
		}
		if d.mant.Sign() <= 0 {
			return errs.New(errs.CategoryValidation, CodeStepInvalid, fmt.Sprintf("field %s must be positive", grid.name))
		}
	}
	return nil
}

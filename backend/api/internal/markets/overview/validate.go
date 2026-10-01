package markets

import (
	"fmt"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
)

// Validate checks the ticker's identity and prices without ever repairing
// them: prices must be plain non-negative decimals — and a present price must
// be positive, since a zero bid/ask/last would fabricate a market state that
// does not exist. The empty string is honest absence and stays legal.
func (t Ticker) Validate() error {
	if t.Exchange == "" {
		return errs.New(errs.CategoryValidation, CodeTickerInvalid, "field exchange is required")
	}
	if t.Symbol == "" {
		return errs.New(errs.CategoryValidation, CodeTickerInvalid, "field symbol is required")
	}
	for _, p := range []struct{ field, value string }{
		{"bid", t.Bid}, {"ask", t.Ask}, {"last", t.Last},
	} {
		if p.value == "" {
			continue // not reported, not zero
		}
		if err := requireDecimal(CodeTickerInvalid, p.field, p.value, false); err != nil {
			return err
		}
	}
	return nil
}

// Validate checks one candle: identity present and the OHLC tuple a real bar
// (positive prices with high ≥ open/close ≥ low and high ≥ low). The tuple is
// checked in full because a silently misordered bar corrupts every indicator
// built from it; volume may be zero but not negative.
func (c Candle) Validate() error {
	if c.Exchange == "" {
		return errs.New(errs.CategoryValidation, CodeCandleInvalid, "field exchange is required")
	}
	if c.Symbol == "" {
		return errs.New(errs.CategoryValidation, CodeCandleInvalid, "field symbol is required")
	}
	prices := []struct{ field, value string }{
		{"open", c.Open}, {"high", c.High}, {"low", c.Low}, {"close", c.Close},
	}
	for _, p := range prices {
		if err := requireDecimal(CodeCandleInvalid, p.field, p.value, false); err != nil {
			return err
		}
	}
	if err := requireDecimal(CodeCandleInvalid, "volume", c.Volume, true); err != nil {
		return err
	}
	vals := map[string]string{"open": c.Open, "high": c.High, "low": c.Low, "close": c.Close}
	if lessThan(vals["high"], vals["low"]) {
		return errs.New(errs.CategoryValidation, CodeCandleInvalid, "fields high/low are inconsistent: high must not be below low")
	}
	for _, field := range []string{"open", "close"} {
		if lessThan(vals["high"], vals[field]) {
			return errs.New(errs.CategoryValidation, CodeCandleInvalid, fmt.Sprintf("fields high/%s are inconsistent: high must not be below %s", field, field))
		}
		if lessThan(vals[field], vals["low"]) {
			return errs.New(errs.CategoryValidation, CodeCandleInvalid, fmt.Sprintf("fields %s/low are inconsistent: %s must not be below low", field, field))
		}
	}
	return nil
}

// Validate checks every level and then the shape of the book as a whole.
// INVARIANT: a crossed book (best bid above best ask) is refused with
// errs.CategoryValidation and CodeBookCrossed naming both fields — a crossed
// print is corrupt data, and pricing an order against it would guarantee a
// loss the user never agreed to.
func (b Book) Validate() error {
	if b.Exchange == "" {
		return errs.New(errs.CategoryValidation, CodeBookInvalid, "field exchange is required")
	}
	if b.Symbol == "" {
		return errs.New(errs.CategoryValidation, CodeBookInvalid, "field symbol is required")
	}
	for side, levels := range map[string][]Level{"bids": b.Bids, "asks": b.Asks} {
		for i, l := range levels {
			if err := requireDecimal(CodeBookInvalid, fmt.Sprintf("%s[%d].price", side, i), l.Price, false); err != nil {
				return err
			}
			if err := requireDecimal(CodeBookInvalid, fmt.Sprintf("%s[%d].quantity", side, i), l.Quantity, true); err != nil {
				return err
			}
		}
	}
	if len(b.Bids) > 0 && len(b.Asks) > 0 && lessThan(b.Asks[0].Price, b.Bids[0].Price) {
		return errs.New(errs.CategoryValidation, CodeBookCrossed,
			"fields bids/asks are crossed: best bid must not be above best ask")
	}
	return nil
}

// Validate checks the mark price: identity present, price present and
// positive. A zero mark price is refused — liquidation math against it would
// be fiction.
func (m MarkPrice) Validate() error {
	if m.Exchange == "" {
		return errs.New(errs.CategoryValidation, CodePriceInvalid, "field exchange is required")
	}
	if m.Symbol == "" {
		return errs.New(errs.CategoryValidation, CodePriceInvalid, "field symbol is required")
	}
	return requireDecimal(CodePriceInvalid, "price", m.Price, false)
}

// Validate checks the index price: identity present, price present and
// positive.
func (x IndexPrice) Validate() error {
	if x.Exchange == "" {
		return errs.New(errs.CategoryValidation, CodePriceInvalid, "field exchange is required")
	}
	if x.Symbol == "" {
		return errs.New(errs.CategoryValidation, CodePriceInvalid, "field symbol is required")
	}
	return requireDecimal(CodePriceInvalid, "price", x.Price, false)
}

// Validate checks the funding rate: identity present and the rate a plain
// decimal. The rate MAY be negative (the direction of the periodic payment is
// real data), so only absence or unparseable form is refused.
func (f FundingRate) Validate() error {
	if f.Exchange == "" {
		return errs.New(errs.CategoryValidation, CodeFundingInvalid, "field exchange is required")
	}
	if f.Symbol == "" {
		return errs.New(errs.CategoryValidation, CodeFundingInvalid, "field symbol is required")
	}
	negative, _, ok := parseDecimal(f.Rate)
	_ = negative // a negative rate is legal data, not a defect
	if !ok {
		return errs.New(errs.CategoryValidation, CodeFundingInvalid, "field rate must be a plain decimal")
	}
	return nil
}

// Validate checks open interest: identity present and the value a plain
// non-negative decimal. Zero is legal (a market with no open contracts), a
// negative interest is not.
func (o OpenInterest) Validate() error {
	if o.Exchange == "" {
		return errs.New(errs.CategoryValidation, CodeOpenInterestInvalid, "field exchange is required")
	}
	if o.Symbol == "" {
		return errs.New(errs.CategoryValidation, CodeOpenInterestInvalid, "field symbol is required")
	}
	return requireDecimal(CodeOpenInterestInvalid, "value", o.Value, true)
}

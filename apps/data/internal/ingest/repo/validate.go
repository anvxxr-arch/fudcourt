package repo

import (
	"fmt"
	"math"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// Validation (contract §35), as pure functions: every check returns a reject
// reason (empty = accept) and, for the zero-value checks, a warn reason
// (empty = nothing to note). Rejects are counted and dropped by the writers;
// warns are WRITTEN (they are real rows with a suspicious-but-legal shape)
// — the frozen Writer interface has no warn counter, so warns are advisory
// for callers, logs and tests.
//
// The checks are deliberately mechanical:
//   - NaN/Inf anywhere a float is stored -> reject (pgx would store a NULL
//     for NaN only in some casts; an IEEE NaN/Inf in a price column is
//     corrupt data, never a value)
//   - negative volume/quantity -> reject (a signed volume is a parser bug)
//   - broken OHLC (out-of-order or non-positive) -> reject
//   - timestamps beyond now+5min -> reject (clock-skewed providers only
//     ever leak a few seconds; anything further is a timezone/epoch bug)
//   - zero-value timestamps -> reject (an empty time is absence, not epoch)
//   - zero-value prices/volumes -> warn (a genuine 0.0 print is rare but
//     real; absence is spelled nil upstream, so 0 came from the wire)

// maxFutureSkew is how far past now a timestamp may legally sit.
const maxFutureSkew = 5 * time.Minute

// checkFloats rejects any NaN/Inf among vals; label names the row for the
// reason text.
func checkFloats(label string, vals ...float64) string {
	for _, v := range vals {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return fmt.Sprintf("%s: NaN/Inf in price/value", label)
		}
	}
	return ""
}

// checkTime rejects the zero timestamp and anything further than maxFutureSkew
// in the future. now is injectable for tests.
func checkTime(label string, t, now time.Time) string {
	if t.IsZero() {
		return fmt.Sprintf("%s: zero timestamp", label)
	}
	if t.After(now.Add(maxFutureSkew)) {
		return fmt.Sprintf("%s: timestamp %s is further than %s in the future", label, t, maxFutureSkew)
	}
	return ""
}

// checkNonNegative rejects negative finite values.
func checkNonNegative(label, what string, v float64) string {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return fmt.Sprintf("%s: NaN/Inf in %s", label, what)
	}
	if v < 0 {
		return fmt.Sprintf("%s: negative %s", label, what)
	}
	return ""
}

// warnZero warns on a zero value where absence should have been nil.
func warnZero(label, what string, v float64) string {
	if v == 0 {
		return fmt.Sprintf("%s: zero-value %s (absent should be nil, not 0)", label, what)
	}
	return ""
}

// validateOhlcv returns (reject, warn) reasons; empty reject = accepted.
func validateOhlcv(r canon.Ohlcv, now time.Time) (reject, warn string) {
	label := "ohlcv " + r.InstrumentID + "/" + r.VenueID + "/" + r.Timeframe
	if r.InstrumentID == "" || r.VenueID == "" {
		return label + ": empty instrument or venue id", ""
	}
	if !canon.ValidateTimeframe(r.Timeframe) {
		return label + ": unknown timeframe " + r.Timeframe, ""
	}
	if r.Source == "" {
		return label + ": empty source", ""
	}
	if reject = checkTime(label+" open_time", r.OpenTime, now); reject != "" {
		return
	}
	if reject = checkFloats(label, r.O, r.H, r.L, r.C); reject != "" {
		return
	}
	if reject = checkNonNegative(label, "volume_base", volumeOrZero(r.VolumeBase)); reject != "" {
		return
	}
	if reject = checkNonNegative(label, "volume_quote", volumeOrZero(r.VolumeQuote)); reject != "" {
		return
	}
	// Broken OHLC: highs must not sit below any other print, lows must not
	// sit above any other print, and all four must be positive.
	if r.O <= 0 || r.H <= 0 || r.L <= 0 || r.C <= 0 {
		return label + ": non-positive OHLC", ""
	}
	if r.H < r.L || r.H < r.O || r.H < r.C || r.L > r.O || r.L > r.C {
		return label + ": broken OHLC ordering", ""
	}
	if r.VolumeBase != nil {
		warn = warnZero(label, "volume_base", *r.VolumeBase)
	}
	return "", warn
}

// volumeOrZero dereferences an optional volume for the negativity check; a
// nil volume (absent) is not an error.
func volumeOrZero(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}

// ptrFloatOrZero is volumeOrZero's general form.
func ptrFloatOrZero(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}

// validateTrade returns (reject, warn).
func validateTrade(r canon.Trade, now time.Time) (reject, warn string) {
	label := "trade " + r.InstrumentID + "/" + r.VenueID + "/" + r.ProviderTradeID
	if r.InstrumentID == "" || r.VenueID == "" || r.ProviderTradeID == "" {
		return label + ": empty instrument, venue or trade id", ""
	}
	if r.Source == "" {
		return label + ": empty source", ""
	}
	if reject = checkTime(label+" trade_time", r.TradeTime, now); reject != "" {
		return
	}
	if reject = checkNonNegative(label, "price", r.Price); reject != "" {
		return
	}
	if reject = checkNonNegative(label, "quantity", r.Quantity); reject != "" {
		return
	}
	if r.Price == 0 {
		warn = warnZero(label, "price", r.Price)
	}
	return "", warn
}

// validateQuote returns (reject, warn).
func validateQuote(r canon.Quote, now time.Time) (reject, warn string) {
	label := "quote " + r.InstrumentID + "/" + r.VenueID
	if r.InstrumentID == "" || r.VenueID == "" {
		return label + ": empty instrument or venue id", ""
	}
	if r.Source == "" {
		return label + ": empty source", ""
	}
	if reject = checkTime(label+" at", r.At, now); reject != "" {
		return
	}
	if r.Bid != nil {
		if reject = checkNonNegative(label, "bid", *r.Bid); reject != "" {
			return
		}
	}
	if r.Ask != nil {
		if reject = checkNonNegative(label, "ask", *r.Ask); reject != "" {
			return
		}
	}
	// A crossed book (bid >= ask) is a snapshot bug, not a market state.
	if r.Bid != nil && r.Ask != nil && *r.Bid >= *r.Ask {
		return label + ": crossed quote (bid >= ask)", ""
	}
	return "", warn
}

// validateOrderbookSnap returns (reject, warn).
func validateOrderbookSnap(r canon.OrderbookSnap, now time.Time) (reject, warn string) {
	label := "orderbook " + r.InstrumentID + "/" + r.VenueID
	if r.InstrumentID == "" || r.VenueID == "" {
		return label + ": empty instrument or venue id", ""
	}
	if r.Source == "" {
		return label + ": empty source", ""
	}
	if reject = checkTime(label+" at", r.At, now); reject != "" {
		return
	}
	if r.Depth < 0 {
		return label + ": negative depth", ""
	}
	// A snapshot with no side is not a snapshot.
	if r.Bids == nil || r.Asks == nil {
		return label + ": nil bids or asks", ""
	}
	for i, p := range r.Bids {
		if len(p) != 2 {
			return label + fmt.Sprintf(": bids[%d] is not a [price, size] pair", i), ""
		}
		if reject = checkNonNegative(label, "bids", p[0]); reject != "" {
			return
		}
		if reject = checkNonNegative(label, "bids size", p[1]); reject != "" {
			return
		}
	}
	for i, p := range r.Asks {
		if len(p) != 2 {
			return label + fmt.Sprintf(": asks[%d] is not a [price, size] pair", i), ""
		}
		if reject = checkNonNegative(label, "asks", p[0]); reject != "" {
			return
		}
		if reject = checkNonNegative(label, "asks size", p[1]); reject != "" {
			return
		}
	}
	return "", warn
}

// validateObservation returns (reject, warn). A nil Value is a REAL row
// (provider published the period without a value — never-fake stays nil).
func validateObservation(r canon.Observation, now time.Time) (reject, warn string) {
	label := "observation " + r.SeriesID + "/" + r.Period
	if r.SeriesID == "" {
		return label + ": empty series id", ""
	}
	if r.Source == "" {
		return label + ": empty source", ""
	}
	if reject = checkTime(label+" observed_at", r.ObservedAt, now); reject != "" {
		return
	}
	if r.Value != nil {
		if reject = checkFloats(label, *r.Value); reject != "" {
			return
		}
	}
	return "", warn
}

// validateFunding returns (reject, warn).
func validateFunding(r canon.FundingRate, now time.Time) (reject, warn string) {
	label := "funding " + r.InstrumentID + "/" + r.VenueID
	if r.InstrumentID == "" || r.VenueID == "" {
		return label + ": empty instrument or venue id", ""
	}
	if r.Source == "" {
		return label + ": empty source", ""
	}
	if reject = checkTime(label+" funding_time", r.FundingTime, now); reject != "" {
		return
	}
	if reject = checkFloats(label, r.Rate); reject != "" {
		return
	}
	return "", warn
}

// validateOpenInterest returns (reject, warn).
func validateOpenInterest(r canon.OpenInterest, now time.Time) (reject, warn string) {
	label := "open_interest " + r.InstrumentID + "/" + r.VenueID
	if r.InstrumentID == "" || r.VenueID == "" {
		return label + ": empty instrument or venue id", ""
	}
	if r.Source == "" {
		return label + ": empty source", ""
	}
	if reject = checkTime(label+" at", r.OIAt, now); reject != "" {
		return
	}
	if r.OpenInterestUSD != nil {
		if reject = checkNonNegative(label, "open_interest_usd", *r.OpenInterestUSD); reject != "" {
			return
		}
	}
	if r.OpenInterestBase != nil {
		if reject = checkNonNegative(label, "open_interest_base", *r.OpenInterestBase); reject != "" {
			return
		}
	}
	return "", warn
}

// validateLiquidation returns (reject, warn). Side, price, quantity and
// value_usd are optional (feeds disagree on what they publish); whatever IS
// present must be well-formed — a negative liquidation price/quantity/value
// is a parser bug, not a market state.
func validateLiquidation(r canon.Liquidation, now time.Time) (reject, warn string) {
	label := "liquidation " + r.InstrumentID + "/" + r.VenueID
	if r.InstrumentID == "" || r.VenueID == "" {
		return label + ": empty instrument or venue id", ""
	}
	if r.Source == "" {
		return label + ": empty source", ""
	}
	if reject = checkTime(label+" at", r.At, now); reject != "" {
		return
	}
	if r.Price != nil {
		if reject = checkNonNegative(label, "price", *r.Price); reject != "" {
			return
		}
	}
	if r.Quantity != nil {
		if reject = checkNonNegative(label, "quantity", *r.Quantity); reject != "" {
			return
		}
	}
	if r.ValueUSD != nil {
		if reject = checkNonNegative(label, "value_usd", *r.ValueUSD); reject != "" {
			return
		}
	}
	return "", warn
}

// validateOptionQuote returns (reject, warn). Prices/volumes/IV/gamma are
// non-negative wherever present; delta, theta and vega are signed greeks, so
// they are only checked for NaN/Inf (the same finite-ness rule
// checkNonNegative applies internally).
func validateOptionQuote(r canon.OptionQuote, now time.Time) (reject, warn string) {
	label := "option_quote " + r.InstrumentID + "/" + r.VenueID
	if r.InstrumentID == "" || r.VenueID == "" {
		return label + ": empty instrument or venue id", ""
	}
	if r.Source == "" {
		return label + ": empty source", ""
	}
	if reject = checkTime(label+" at", r.At, now); reject != "" {
		return
	}
	if r.MarkPrice != nil {
		if reject = checkNonNegative(label, "mark_price", *r.MarkPrice); reject != "" {
			return
		}
	}
	if r.IndexPrice != nil {
		if reject = checkNonNegative(label, "index_price", *r.IndexPrice); reject != "" {
			return
		}
	}
	if r.Bid != nil {
		if reject = checkNonNegative(label, "bid", *r.Bid); reject != "" {
			return
		}
	}
	if r.Ask != nil {
		if reject = checkNonNegative(label, "ask", *r.Ask); reject != "" {
			return
		}
	}
	if r.Volume24h != nil {
		if reject = checkNonNegative(label, "volume_24h", *r.Volume24h); reject != "" {
			return
		}
	}
	if r.OpenInterest != nil {
		if reject = checkNonNegative(label, "open_interest", *r.OpenInterest); reject != "" {
			return
		}
	}
	if r.IV != nil {
		if reject = checkNonNegative(label, "iv", *r.IV); reject != "" {
			return
		}
	}
	if r.Gamma != nil {
		if reject = checkNonNegative(label, "gamma", *r.Gamma); reject != "" {
			return
		}
	}
	// Signed greeks: absence is nil, a present value only has to be finite.
	if r.Delta != nil {
		if reject = checkFloats(label, *r.Delta); reject != "" {
			return
		}
	}
	if r.Theta != nil {
		if reject = checkFloats(label, *r.Theta); reject != "" {
			return
		}
	}
	if r.Vega != nil {
		if reject = checkFloats(label, *r.Vega); reject != "" {
			return
		}
	}
	return "", warn
}

// validatePool returns (reject, warn).
func validatePool(r canon.Pool, now time.Time) (reject, warn string) {
	label := "pool " + r.PoolID
	if r.PoolID == "" || r.ChainID == "" || r.Address == "" {
		return label + ": empty pool id, chain or address", ""
	}
	if r.Source == "" {
		return label + ": empty source", ""
	}
	if reject = checkTime(label+" at", r.At, now); reject != "" {
		return
	}
	if r.LiquidityUSD != nil {
		if reject = checkNonNegative(label, "liquidity_usd", *r.LiquidityUSD); reject != "" {
			return
		}
	}
	return "", warn
}

// validateArticle returns (reject, warn).
func validateArticle(r canon.Article, now time.Time) (reject, warn string) {
	label := "article " + r.ArticleID
	if r.ArticleID == "" {
		return label + ": empty article id", ""
	}
	if r.Headline == "" {
		return label + ": empty headline", ""
	}
	if r.URL == "" {
		return label + ": empty url", ""
	}
	if r.Source == "" {
		return label + ": empty source", ""
	}
	if r.RetrievedAt.IsZero() {
		return label + ": zero retrieved_at", ""
	}
	if reject = checkTime(label+" retrieved_at", r.RetrievedAt, now); reject != "" {
		return
	}
	return "", warn
}

// validatePredictionMarket returns (reject, warn).
func validatePredictionMarket(r canon.PredictionMarket, now time.Time) (reject, warn string) {
	label := "prediction_market " + r.MarketID
	if r.MarketID == "" {
		return label + ": empty market id", ""
	}
	if r.Source == "" {
		return label + ": empty source", ""
	}
	if r.RetrievedAt.IsZero() {
		return label + ": zero retrieved_at", ""
	}
	if reject = checkTime(label+" retrieved_at", r.RetrievedAt, now); reject != "" {
		return
	}
	return "", warn
}

// validateChainTVL returns (reject, warn).
func validateChainTVL(r canon.ChainTVL, now time.Time) (reject, warn string) {
	label := "tvl_chain " + r.ChainID
	if r.ChainID == "" {
		return label + ": empty chain id", ""
	}
	if r.Source == "" {
		return label + ": empty source", ""
	}
	if reject = checkTime(label+" at", r.At, now); reject != "" {
		return
	}
	if reject = checkNonNegative(label, "tvl_usd", r.TVLUSD); reject != "" {
		return
	}
	return "", warn
}

// validateProtocolTVL returns (reject, warn).
func validateProtocolTVL(r canon.ProtocolTVL, now time.Time) (reject, warn string) {
	label := "tvl_protocol " + r.ProtocolID
	if r.ProtocolID == "" {
		return label + ": empty protocol id", ""
	}
	if r.Source == "" {
		return label + ": empty source", ""
	}
	if reject = checkTime(label+" at", r.At, now); reject != "" {
		return
	}
	if reject = checkNonNegative(label, "tvl_usd", r.TVLUSD); reject != "" {
		return
	}
	return "", warn
}

// validateSupply returns (reject, warn).
func validateSupply(r canon.SupplySnapshot, now time.Time) (reject, warn string) {
	label := "supply " + r.ChainID + "/" + r.Address
	if r.ChainID == "" || r.Address == "" {
		return label + ": empty chain or address", ""
	}
	if r.Source == "" {
		return label + ": empty source", ""
	}
	if reject = checkTime(label+" at", r.At, now); reject != "" {
		return
	}
	if r.TotalSupply != nil {
		if reject = checkNonNegative(label, "total_supply", *r.TotalSupply); reject != "" {
			return
		}
	}
	if r.CirculatingSupply != nil {
		if reject = checkNonNegative(label, "circulating_supply", *r.CirculatingSupply); reject != "" {
			return
		}
	}
	return "", warn
}

// validateMetricPoint returns (reject, warn) for one derived datapoint.
func validateMetricPoint(p canon.MetricPoint, now time.Time) (reject, warn string) {
	label := "metric point"
	if reject = checkTime(label+" at", p.At, now); reject != "" {
		return
	}
	if p.Value != nil {
		if reject = checkFloats(label, *p.Value); reject != "" {
			return
		}
	}
	return "", warn
}

// nilIfEmpty collapses an empty string to SQL NULL (entity optional text
// columns); never-fake prefers NULL over the empty string.
func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

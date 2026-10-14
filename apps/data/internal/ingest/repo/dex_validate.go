package repo

import (
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// This file is the DEX half of the write-time validation (docs/dex/audit.md
// §4). Same contract as validate.go: each function returns (reject, warn) and
// an empty reject means accept. A reject is counted and dropped; a warn is
// written (a legal-but-suspicious row).
//
// The DEX numerics are exact (canon.Dec / canon.TokenAmount), so the float
// NaN/Inf checks of validate.go do not apply. What DOES apply here:
//   - an empty required id / source is a reject;
//   - a zero/absurd timestamp is a reject (checkTime);
//   - a MONETARY dec that is present must be a parseable, finite decimal —
//     DecFromString already refuses "NaN"/"Inf" at construction, so a present
//     Dec is finite by construction, but the STRING form must round-trip;
//   - a token amount must carry a non-nil Raw (an amount with no raw integer is
//     absence, and absence is nil, not a zero amount);
//   - a NEGATIVE magnitude (volume, liquidity, an amount) is a reject.

// decOK reports whether a present Dec renders a usable decimal string. An
// absent Dec is fine (it means "not reported").
func decOK(d canon.Dec) bool {
	if !d.Present() {
		return true
	}
	s := d.String()
	if s == "" {
		return false
	}
	// Re-parse: the rendered string must itself be a valid decimal, so a
	// corrupt Dec cannot slip a malformed value into a numeric column.
	_, err := canon.DecFromString(s)
	return err == nil
}

// decNonNegative reports whether a present Dec is >= 0. An absent Dec passes.
func decNonNegative(d canon.Dec) bool {
	if !d.Present() {
		return true
	}
	return d.Rat().Sign() >= 0
}

// decOKptr is decOK for an OPTIONAL (*Dec) field: nil is absent and passes.
func decOKptr(d *canon.Dec) bool {
	if d == nil {
		return true
	}
	return decOK(*d)
}

// decNonNegativePtr is decNonNegative for an OPTIONAL (*Dec) field.
func decNonNegativePtr(d *canon.Dec) bool {
	if d == nil {
		return true
	}
	return decNonNegative(*d)
}

// tokenAmountOK reports whether an OPTIONAL amount is usable: absent is fine, a
// present one must carry a raw integer and a sane decimals exponent.
func tokenAmountOK(a *canon.TokenAmount) bool {
	if a == nil {
		return true
	}
	if a.Raw == nil {
		return false
	}
	return a.Decimals >= 0 && a.Decimals <= 255
}

// tokenAmountNonNegative reports whether a present amount is >= 0.
func tokenAmountNonNegative(a *canon.TokenAmount) bool {
	if a == nil || a.Raw == nil {
		return true
	}
	return a.Raw.Sign() >= 0
}

// validateSwap returns (reject, warn).
func validateSwap(s canon.Swap, now time.Time) (reject, warn string) {
	label := "dex swap"
	switch {
	case s.SwapID == "":
		return label + ": empty swap_id", ""
	case s.NaturalKey == "":
		return label + ": empty natural_key", ""
	case s.PoolID == "":
		return label + ": empty pool_id", ""
	case s.ChainID == "":
		return label + ": empty chain_id", ""
	case s.TxHash == "":
		return label + ": empty tx_hash", ""
	case s.TokenIn == "" || s.TokenOut == "":
		return label + ": empty token_in/token_out", ""
	case s.LogIndex < 0:
		return label + ": negative log_index", ""
	}
	if r := checkTime(label+" event_time", s.EventTime, now); r != "" {
		return r, ""
	}
	if !tokenAmountOK(&s.AmountIn) || !tokenAmountOK(&s.AmountOut) {
		return label + ": amount with nil raw", ""
	}
	if !tokenAmountNonNegative(&s.AmountIn) || !tokenAmountNonNegative(&s.AmountOut) {
		return label + ": negative amount", ""
	}
	if !decOKptr(s.AmountUSD) || !decNonNegativePtr(s.AmountUSD) {
		return label + ": bad amount_usd", ""
	}
	return "", ""
}

// validateDexCandle returns (reject, warn).
func validateDexCandle(c canon.DexCandle, now time.Time) (reject, warn string) {
	label := "dex candle"
	switch {
	case c.CandleID == "":
		return label + ": empty candle_id", ""
	case c.PoolID == "":
		return label + ": empty pool_id", ""
	case c.ChainID == "":
		return label + ": empty chain_id", ""
	case !canon.ValidateTimeframe(c.Interval):
		return label + ": invalid interval " + c.Interval, ""
	}
	if r := checkTime(label+" open_time", c.OpenTime, now); r != "" {
		return r, ""
	}
	if !decOK(c.Open) || !decOK(c.High) || !decOK(c.Low) || !decOK(c.Close) {
		return label + ": unrenderable o/h/l/c", ""
	}
	if c.Open.Rat().Sign() <= 0 || c.High.Rat().Sign() <= 0 || c.Low.Rat().Sign() <= 0 || c.Close.Rat().Sign() <= 0 {
		return label + ": non-positive OHLC", ""
	}
	// Broken OHLC ordering is a parser bug, not a market state.
	if c.High.Rat().Cmp(c.Low.Rat()) < 0 || c.High.Rat().Cmp(c.Open.Rat()) < 0 ||
		c.High.Rat().Cmp(c.Close.Rat()) < 0 || c.Low.Rat().Cmp(c.Open.Rat()) > 0 ||
		c.Low.Rat().Cmp(c.Close.Rat()) > 0 {
		return label + ": broken OHLC ordering", ""
	}
	if !decNonNegativePtr(c.VolumeBase) || !decNonNegativePtr(c.VolumeQuote) || !decNonNegativePtr(c.VolumeUSD) {
		return label + ": negative volume", ""
	}
	return "", ""
}

// validateDexLiquiditySnapshot returns (reject, warn).
func validateDexLiquiditySnapshot(s canon.DexLiquiditySnapshot, now time.Time) (reject, warn string) {
	label := "dex liquidity snapshot"
	switch {
	case s.SnapshotID == "":
		return label + ": empty snapshot_id", ""
	case s.PoolID == "":
		return label + ": empty pool_id", ""
	case s.ChainID == "":
		return label + ": empty chain_id", ""
	}
	if r := checkTime(label+" at", s.At, now); r != "" {
		return r, ""
	}
	if !decNonNegativePtr(s.LiquidityUSD) {
		return label + ": negative liquidity_usd", ""
	}
	if !decNonNegativePtr(s.ActiveLiquidity) {
		return label + ": negative active_liquidity", ""
	}
	return "", ""
}

// validateDexMarketSnapshot returns (reject, warn).
func validateDexMarketSnapshot(s canon.DexMarketSnapshot, now time.Time) (reject, warn string) {
	label := "dex market snapshot"
	switch {
	case s.SnapshotID == "":
		return label + ": empty snapshot_id", ""
	case s.PoolID == "":
		return label + ": empty pool_id", ""
	case s.ChainID == "":
		return label + ": empty chain_id", ""
	}
	if r := checkTime(label+" at", s.At, now); r != "" {
		return r, ""
	}
	if !decNonNegativePtr(s.PriceUSD) || !decNonNegativePtr(s.PriceNative) ||
		!decNonNegativePtr(s.Volume24hUSD) || !decNonNegativePtr(s.FDVUSD) ||
		!decNonNegativePtr(s.MarketCapUSD) {
		return label + ": negative price/volume/fdv", ""
	}
	return "", ""
}

// validateDexLiquidityPosition returns (reject, warn).
func validateDexLiquidityPosition(p canon.DexLiquidityPosition, now time.Time) (reject, warn string) {
	label := "dex liquidity position"
	switch {
	case p.PositionID == "":
		return label + ": empty position_id", ""
	case p.PoolID == "":
		return label + ": empty pool_id", ""
	case p.ChainID == "":
		return label + ": empty chain_id", ""
	case p.Owner == "":
		return label + ": empty owner", ""
	}
	if r := checkTime(label+" at", p.At, now); r != "" {
		return r, ""
	}
	if !decNonNegativePtr(p.Liquidity) || !decNonNegativePtr(p.ValueUSD) {
		return label + ": negative liquidity/value", ""
	}
	return "", ""
}

// validateWalletActivity returns (reject, warn).
func validateWalletActivity(a canon.WalletActivity, now time.Time) (reject, warn string) {
	label := "dex wallet activity"
	switch {
	case a.ActivityID == "":
		return label + ": empty activity_id", ""
	case a.NaturalKey == "":
		return label + ": empty natural_key", ""
	case a.Provider == "":
		return label + ": empty provider", ""
	case a.ChainID == "":
		return label + ": empty chain_id", ""
	case a.Wallet == "":
		return label + ": empty wallet", ""
	case a.Kind == "":
		return label + ": empty kind", ""
	}
	if r := checkTime(label+" event_time", a.EventTime, now); r != "" {
		return r, ""
	}
	if !tokenAmountOK(a.Amount) || !tokenAmountNonNegative(a.Amount) {
		return label + ": bad amount", ""
	}
	if !decNonNegativePtr(a.ValueUSD) {
		return label + ": negative value_usd", ""
	}
	return "", ""
}

// validateRouteQuote returns (reject, warn).
func validateRouteQuote(q canon.RouteQuote, now time.Time) (reject, warn string) {
	label := "dex route quote"
	switch {
	case q.QuoteID == "":
		return label + ": empty quote_id", ""
	case q.NaturalKey == "":
		return label + ": empty natural_key", ""
	case q.Provider == "":
		return label + ": empty provider", ""
	case q.ChainID == "":
		return label + ": empty chain_id", ""
	case q.TokenIn == "" || q.TokenOut == "":
		return label + ": empty token_in/token_out", ""
	}
	if r := checkTime(label+" quoted_at", q.QuotedAt, now); r != "" {
		return r, ""
	}
	if !tokenAmountOK(&q.AmountIn) || !tokenAmountOK(&q.AmountOut) {
		return label + ": amount with nil raw", ""
	}
	if !tokenAmountNonNegative(&q.AmountIn) || !tokenAmountNonNegative(&q.AmountOut) {
		return label + ": negative amount", ""
	}
	if !decNonNegativePtr(q.ExpectedOutputUSD) || !decNonNegativePtr(q.GasUSD) {
		return label + ": negative usd estimate", ""
	}
	return "", ""
}

// validateRiskMetric returns (reject, warn).
func validateRiskMetric(m canon.RiskMetric, now time.Time) (reject, warn string) {
	label := "dex risk metric"
	switch {
	case m.RiskID == "":
		return label + ": empty risk_id", ""
	case m.NaturalKey == "":
		return label + ": empty natural_key", ""
	case m.SubjectKey == "":
		return label + ": empty subject_key", ""
	case m.Metric == "":
		return label + ": empty metric", ""
	case m.AlgorithmVersion == "":
		return label + ": empty algorithm_version", ""
	}
	if r := checkTime(label+" at", m.At, now); r != "" {
		return r, ""
	}
	if !decOK(m.Score) {
		return label + ": unrenderable score", ""
	}
	if !decNonNegative(m.Score) {
		return label + ": negative score", ""
	}
	return "", ""
}

// validateMEVEvent returns (reject, warn).
func validateMEVEvent(e canon.MEVEvent, now time.Time) (reject, warn string) {
	label := "dex mev event"
	switch {
	case e.MEVID == "":
		return label + ": empty mev_id", ""
	case e.NaturalKey == "":
		return label + ": empty natural_key", ""
	case e.ChainID == "":
		return label + ": empty chain_id", ""
	case e.TxHash == "":
		return label + ": empty tx_hash", ""
	case e.Kind == "":
		return label + ": empty kind", ""
	}
	if r := checkTime(label+" event_time", e.EventTime, now); r != "" {
		return r, ""
	}
	if !decNonNegativePtr(e.ProfitUSD) {
		return label + ": negative profit_usd", ""
	}
	if !tokenAmountOK(e.ProfitToken) || !tokenAmountNonNegative(e.ProfitToken) {
		return label + ": bad profit token", ""
	}
	return "", ""
}

// validatePerpMarket returns (reject, warn).
func validatePerpMarket(m canon.PerpMarket, now time.Time) (reject, warn string) {
	label := "dex perp market"
	switch {
	case m.PerpMarketID == "":
		return label + ": empty perp_market_id", ""
	case m.NaturalKey == "":
		return label + ": empty natural_key", ""
	case m.VenueID == "":
		return label + ": empty venue_id", ""
	case m.MarketType == "":
		return label + ": empty market_type", ""
	case m.BaseSymbol == "" || m.QuoteSymbol == "":
		return label + ": empty base/quote symbol", ""
	}
	if r := checkTime(label+" at", m.At, now); r != "" {
		return r, ""
	}
	if !decNonNegativePtr(m.IndexPrice) || !decNonNegativePtr(m.MarkPrice) || !decNonNegativePtr(m.OpenInterestBase) {
		return label + ": negative price/oi", ""
	}
	if m.FundingRate != nil && !decOK(*m.FundingRate) {
		return label + ": unrenderable funding_rate", ""
	}
	if !tokenAmountOK(m.OpenInterestUSD) || !tokenAmountNonNegative(m.OpenInterestUSD) {
		return label + ": bad open_interest_usd", ""
	}
	return "", ""
}

// validatePerpLiquidation returns (reject, warn).
func validatePerpLiquidation(l canon.PerpLiquidation, now time.Time) (reject, warn string) {
	label := "dex perp liquidation"
	switch {
	case l.VenueID == "":
		return label + ": empty venue_id", ""
	case l.PerpMarketID == "":
		return label + ": empty perp_market_id", ""
	}
	if r := checkTime(label+" at", l.At, now); r != "" {
		return r, ""
	}
	if !decOK(l.Price) || !decNonNegative(l.Price) {
		return label + ": bad price", ""
	}
	if l.Quantity.Raw == nil {
		return label + ": nil quantity raw", ""
	}
	if !tokenAmountNonNegative(&l.Quantity) {
		return label + ": negative quantity", ""
	}
	if !decNonNegativePtr(l.ValueUSD) {
		return label + ": negative value_usd", ""
	}
	return "", ""
}

// validateOrderbookSnapshot returns (reject, warn).
func validateOrderbookSnapshot(s canon.DexOrderbookSnapshot, now time.Time) (reject, warn string) {
	label := "dex orderbook snapshot"
	switch {
	case s.SnapshotID == "":
		return label + ": empty snapshot_id", ""
	case s.PoolID == "":
		return label + ": empty pool_id", ""
	case s.ChainID == "":
		return label + ": empty chain_id", ""
	}
	if r := checkTime(label+" at", s.At, now); r != "" {
		return r, ""
	}
	if s.Depth < 0 {
		return label + ": negative depth", ""
	}
	for _, side := range [][]canon.OrderbookLevel{s.Bids, s.Asks} {
		for _, lvl := range side {
			if !decOK(lvl.Price) || !decOK(lvl.Size) {
				return label + ": unrenderable level", ""
			}
			if !decNonNegative(lvl.Price) || !decNonNegative(lvl.Size) {
				return label + ": negative level", ""
			}
		}
	}
	return "", ""
}

// validateProviderObservation returns (reject, warn).
func validateProviderObservation(o canon.ProviderObservation, now time.Time) (reject, warn string) {
	label := "dex provider observation"
	switch {
	case o.ObservationID == "":
		return label + ": empty observation_id", ""
	case o.NaturalKey == "":
		return label + ": empty natural_key", ""
	case o.Provider == "":
		return label + ": empty provider", ""
	case o.Dataset == "":
		return label + ": empty dataset", ""
	case o.RecordID == "":
		return label + ": empty record_id", ""
	}
	if r := checkTime(label+" observed_at", o.ObservedAt, now); r != "" {
		return r, ""
	}
	if o.ExpiresAt.IsZero() {
		return label + ": empty expires_at", ""
	}
	return "", ""
}

package instruments

import (
	"fmt"
	"strings"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
)

// quoteSuffixes are the quote assets a concatenated venue symbol (binance,
// bybit) can end with. Matching is longest-first so `BTCBUSD` splits on BUSD
// rather than USD, and the order below is that order.
var quoteSuffixes = []string{
	"USDT", "USDC", "FDUSD", "BUSD", "TUSD", "DAI",
	"USD", "EUR", "TRY",
	"BTC", "ETH", "BNB", "SOL", "XRP", "DOGE",
}

// CanonicalSymbol normalizes a venue-native symbol into the canonical
// `BASE/QUOTE` form shared with the web executor (fromVenueSymbol in
// apps/web/src/platform/executor/exchange.ts). It mirrors those semantics:
//
//   - binance/bybit spell symbols concatenated (`BTCUSDT`), split by the
//     longest matching quote suffix (`BTC` + `USDT`);
//   - mexc spells them underscored (`BTC_USDT`), split on the underscore;
//   - anything after a `:` is a ccxt settlement suffix (`BTC/USDT:USDT`) and is
//     stripped first;
//   - a symbol already in `BASE/QUOTE` form passes through.
//
// INVARIANT: never guess. Empty symbols, unknown exchanges, symbols that match
// no quote suffix, or symbols spelled in another exchange's form are refused
// with errs.CategoryValidation and CodeSymbolUnknown rather than split on a
// heuristic that could silently name the wrong market. Both halves are
// uppercased, matching the venue spellings.
func CanonicalSymbol(exchange, venueSymbol string) (string, error) {
	symbol := venueSymbol
	if cut := strings.IndexByte(symbol, ':'); cut >= 0 {
		symbol = symbol[:cut]
	}
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	if symbol == "" {
		return "", errs.New(errs.CategoryValidation, CodeSymbolUnknown, "field symbol is required")
	}
	if base, quote, ok := strings.Cut(symbol, "/"); ok {
		if base == "" || quote == "" {
			return "", errs.New(errs.CategoryValidation, CodeSymbolUnknown, fmt.Sprintf("field symbol %q has an empty side", venueSymbol))
		}
		return base + "/" + quote, nil
	}
	switch exchange {
	case "binance", "bybit":
		if strings.Contains(symbol, "_") {
			return "", errs.New(errs.CategoryValidation, CodeSymbolUnknown,
				fmt.Sprintf("field symbol %q is not a %s symbol", venueSymbol, exchange))
		}
		for _, quote := range quoteSuffixes {
			if len(symbol) > len(quote) && strings.HasSuffix(symbol, quote) {
				return strings.TrimSuffix(symbol, quote) + "/" + quote, nil
			}
		}
	case "mexc":
		base, quote, ok := strings.Cut(symbol, "_")
		if !ok || base == "" || quote == "" || strings.Contains(quote, "_") {
			return "", errs.New(errs.CategoryValidation, CodeSymbolUnknown,
				fmt.Sprintf("field symbol %q is not a mexc symbol", venueSymbol))
		}
		return base + "/" + quote, nil
	default:
		return "", errs.New(errs.CategoryValidation, CodeSymbolUnknown,
			fmt.Sprintf("field exchange %q has no known symbol form", exchange))
	}
	return "", errs.New(errs.CategoryValidation, CodeSymbolUnknown,
		fmt.Sprintf("field symbol %q matches no known quote asset", venueSymbol))
}

// VenueSymbol inverts CanonicalSymbol (mirroring toVenueSymbol in
// apps/web/src/platform/executor/exchange.ts): `BASE/QUOTE` becomes the
// venue-native spelling — concatenated for binance/bybit, underscored for
// mexc. INVARIANT: a canonical symbol that is not exactly `BASE/QUOTE` is
// refused (CodeSymbolUnknown), never emitted half-formed to a venue.
func VenueSymbol(exchange, canonical string) (string, error) {
	base, quote, ok := strings.Cut(canonical, "/")
	if !ok || base == "" || quote == "" || strings.ContainsAny(quote, "/:") {
		return "", errs.New(errs.CategoryValidation, CodeSymbolUnknown,
			fmt.Sprintf("field symbol %q must be BASE/QUOTE", canonical))
	}
	base, quote = strings.ToUpper(base), strings.ToUpper(quote)
	switch exchange {
	case "binance", "bybit":
		return base + quote, nil
	case "mexc":
		return base + "_" + quote, nil
	default:
		return "", errs.New(errs.CategoryValidation, CodeSymbolUnknown,
			fmt.Sprintf("field exchange %q has no known symbol form", exchange))
	}
}

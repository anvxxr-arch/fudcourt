package exchange

import (
	"strings"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/executor"
)

// Symbol normalization (PRD §49). The canonical internal symbol is
// "BASE/QUOTE" (e.g. "BTC/USDT"). Venue wire forms:
//
//	binance, bybit : BASEQUOTE   concatenated  (BTC/USDT → "BTCUSDT")
//	mexc           : BASE_QUOTE  underscored   (BTC/USDT → "BTC_USDT")
//
// FromVenueSymbol splits on the known quote-asset suffixes only. An unknown
// suffix is REFUSED with ErrUnknownQuote — the split point is never guessed,
// because a wrong guess silently trades the wrong instrument.

// knownQuotes are the quote assets this build recognizes as a venue-symbol
// suffix (ccxt's common-quote base for these three venues). Longest first so
// "USDC" never resolves as base "USDC..." with quote "C".
var knownQuotes = []string{"USDT", "USDC", "FDUSD", "TUSD", "BUSD", "BTC", "ETH", "BNB", "EUR", "TRY", "MX"}

// ToVenueSymbol maps canonical "BASE/QUOTE" to the venue wire symbol.
// Unrecognized venue ids are refused with ErrUnknownVenue; a non-canonical
// symbol is refused with ErrInvalidSymbol; a quote asset outside the known set
// is refused with ErrUnknownQuote (never concatenated into a guessed form).
func ToVenueSymbol(canonical string, venue executor.ExchangeID) (string, error) {
	base, quote, err := splitCanonical(canonical)
	if err != nil {
		return "", err
	}
	if !isKnownQuote(quote) {
		return "", ErrUnknownQuote
	}
	switch venue {
	case executor.ExchangeBinance, executor.ExchangeBybit:
		return base + quote, nil
	case executor.ExchangeMEXC:
		return base + "_" + quote, nil
	default:
		return "", ErrUnknownVenue
	}
}

// FromVenueSymbol maps a venue wire symbol back to canonical "BASE/QUOTE".
// binance/bybit: the quote is the known-quote SUFFIX of the concatenated
// string (USDTUSDT → "USDT/USDT"); mexc: the quote is the part after the last
// underscore (BTC_USDT → "BTC/USDT"). A symbol whose suffix/segment is not a
// known quote asset is refused with ErrUnknownQuote — never guessed.
func FromVenueSymbol(venueSymbol string, venue executor.ExchangeID) (string, error) {
	if venueSymbol == "" {
		return "", ErrInvalidSymbol
	}
	switch venue {
	case executor.ExchangeBinance, executor.ExchangeBybit:
		for _, q := range knownQuotes {
			if len(venueSymbol) > len(q) && strings.HasSuffix(venueSymbol, q) {
				return venueSymbol[:len(venueSymbol)-len(q)] + "/" + q, nil
			}
		}
		return "", ErrUnknownQuote
	case executor.ExchangeMEXC:
		i := strings.LastIndex(venueSymbol, "_")
		if i <= 0 || i == len(venueSymbol)-1 {
			return "", ErrInvalidSymbol
		}
		quote := venueSymbol[i+1:]
		if !isKnownQuote(quote) {
			return "", ErrUnknownQuote
		}
		return venueSymbol[:i] + "/" + quote, nil
	default:
		return "", ErrUnknownVenue
	}
}

// splitCanonical splits "BASE/QUOTE" and refuses anything else (no slash,
// empty side, extra separators).
func splitCanonical(canonical string) (base, quote string, err error) {
	parts := strings.Split(canonical, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", ErrInvalidSymbol
	}
	return parts[0], parts[1], nil
}

func isKnownQuote(asset string) bool {
	for _, q := range knownQuotes {
		if asset == q {
			return true
		}
	}
	return false
}

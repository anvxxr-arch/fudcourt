package instruments

import (
	"errors"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
)

func TestCanonicalSymbol(t *testing.T) {
	cases := []struct {
		name     string
		exchange string
		venue    string
		want     string
	}{
		{"binance concatenated", "binance", "BTCUSDT", "BTC/USDT"},
		{"bybit concatenated", "bybit", "BTCUSDT", "BTC/USDT"},
		{"mexc underscored", "mexc", "BTC_USDT", "BTC/USDT"},
		{"binance alt quote", "binance", "ETHBTC", "ETH/BTC"},
		{"mexc alt quote", "mexc", "ETH_BTC", "ETH/BTC"},
		{"longest quote wins", "binance", "BTCBUSD", "BTC/BUSD"},
		{"base that ends in a quote name", "binance", "TUSDUSDT", "TUSD/USDT"},
		{"lowercase input normalized", "binance", "btcusdt", "BTC/USDT"},
		{"ccxt settlement suffix stripped", "binance", "BTC/USDT:USDT", "BTC/USDT"},
		{"already canonical passes through", "bybit", "BTC/USDT", "BTC/USDT"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := CanonicalSymbol(tc.exchange, tc.venue)
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("CanonicalSymbol(%q, %q) = %q, want %q", tc.exchange, tc.venue, got, tc.want)
			}
		})
	}
}

func TestCanonicalSymbolRefusesRatherThanGuesses(t *testing.T) {
	cases := []struct {
		name     string
		exchange string
		venue    string
	}{
		{"empty symbol", "binance", ""},
		{"only colon suffix", "binance", ":USDT"},
		{"no known quote suffix", "binance", "NOTHING"},
		{"mexc form on binance", "binance", "BTC_USDT"},
		{"concatenated form on mexc", "mexc", "BTCUSDT"},
		{"empty side", "binance", "BTC/"},
		{"quote only", "binance", "USDT"},
		{"unknown exchange", "kraken", "BTCUSDT"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := CanonicalSymbol(tc.exchange, tc.venue)
			if err == nil {
				t.Fatalf("must refuse, got %q", got)
			}
			var e *errs.Error
			if !errors.As(err, &e) {
				t.Fatalf("err = %v, want *errs.Error", err)
			}
			if e.Category != errs.CategoryValidation || e.Code != CodeSymbolUnknown {
				t.Fatalf("got %s/%s, want validation/%s", e.Category, e.Code, CodeSymbolUnknown)
			}
			if got != "" {
				t.Fatalf("refusal must not yield a symbol, got %q", got)
			}
		})
	}
}

func TestVenueSymbolRoundTrips(t *testing.T) {
	cases := []struct {
		exchange string
		canonical string
		want     string
	}{
		{"binance", "BTC/USDT", "BTCUSDT"},
		{"bybit", "ETH/BTC", "ETHBTC"},
		{"mexc", "BTC/USDT", "BTC_USDT"},
	}
	for _, tc := range cases {
		venue, err := VenueSymbol(tc.exchange, tc.canonical)
		if err != nil {
			t.Fatalf("%s %s: %v", tc.exchange, tc.canonical, err)
		}
		if venue != tc.want {
			t.Fatalf("VenueSymbol(%q, %q) = %q, want %q", tc.exchange, tc.canonical, venue, tc.want)
		}
		back, err := CanonicalSymbol(tc.exchange, venue)
		if err != nil {
			t.Fatal(err)
		}
		if back != strings.ToUpper(tc.canonical) {
			t.Fatalf("round trip %q -> %q -> %q", tc.canonical, venue, back)
		}
	}
}

func TestVenueSymbolRefusesMalformedCanonical(t *testing.T) {
	for _, symbol := range []string{"", "BTCUSDT", "BTC/", "/USDT", "BTC/USDT/EXTRA"} {
		venue, err := VenueSymbol("binance", symbol)
		if err == nil {
			t.Fatalf("VenueSymbol(%q) = %q, want refusal", symbol, venue)
		}
	}
	if _, err := VenueSymbol("kraken", "BTC/USDT"); err == nil {
		t.Fatal("unknown exchange must be refused")
	}
}

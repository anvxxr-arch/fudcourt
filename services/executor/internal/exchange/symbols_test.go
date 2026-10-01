package exchange

import (
	"errors"
	"testing"

	"github.com/anvxxr-arch/fudcourt/services/executor/internal/executor"
)

func TestToVenueSymbol(t *testing.T) {
	cases := []struct {
		canonical string
		venue     executor.ExchangeID
		want      string
	}{
		{"BTC/USDT", executor.ExchangeBinance, "BTCUSDT"},
		{"ETH/USDT", executor.ExchangeBinance, "ETHUSDT"},
		{"BTC/USDT", executor.ExchangeBybit, "BTCUSDT"},
		{"SOL/USDC", executor.ExchangeBybit, "SOLUSDC"},
		{"BTC/USDT", executor.ExchangeMEXC, "BTC_USDT"},
		{"ETH/BTC", executor.ExchangeMEXC, "ETH_BTC"},
		{"ETH/BTC", executor.ExchangeBinance, "ETHBTC"},
		{"USDT/USDT", executor.ExchangeBinance, "USDTUSDT"},
	}
	for _, c := range cases {
		got, err := ToVenueSymbol(c.canonical, c.venue)
		if err != nil || got != c.want {
			t.Errorf("ToVenueSymbol(%q,%s) = (%q,%v), want %q", c.canonical, c.venue, got, err, c.want)
		}
	}
}

func TestToVenueSymbolRefusals(t *testing.T) {
	cases := []struct {
		name      string
		canonical string
		venue     executor.ExchangeID
		wantErr   error
	}{
		{"no separator", "BTCUSDT", executor.ExchangeBinance, ErrInvalidSymbol},
		{"empty base", "/USDT", executor.ExchangeBinance, ErrInvalidSymbol},
		{"empty quote", "BTC/", executor.ExchangeBinance, ErrInvalidSymbol},
		{"extra separator", "BTC/USDT/USD", executor.ExchangeBinance, ErrInvalidSymbol},
		{"unknown quote", "BTC/XYZ", executor.ExchangeBinance, ErrUnknownQuote},
		{"settle suffix is not canonical", "BTC/USDT:USDT", executor.ExchangeBybit, ErrUnknownQuote},
		{"unknown venue", "BTC/USDT", executor.ExchangeID("kraken"), ErrUnknownVenue},
	}
	for _, c := range cases {
		got, err := ToVenueSymbol(c.canonical, c.venue)
		if got != "" || !errors.Is(err, c.wantErr) {
			t.Errorf("%s: ToVenueSymbol(%q,%s) = (%q,%v), want refusal %v", c.name, c.canonical, c.venue, got, err, c.wantErr)
		}
	}
}

func TestFromVenueSymbol(t *testing.T) {
	cases := []struct {
		venueSymbol string
		venue       executor.ExchangeID
		want        string
	}{
		{"BTCUSDT", executor.ExchangeBinance, "BTC/USDT"},
		{"ETHBTC", executor.ExchangeBinance, "ETH/BTC"},
		{"BTCUSDT", executor.ExchangeBybit, "BTC/USDT"},
		{"SOLUSDC", executor.ExchangeBybit, "SOL/USDC"},
		{"BTC_USDT", executor.ExchangeMEXC, "BTC/USDT"},
		{"ETH_BTC", executor.ExchangeMEXC, "ETH/BTC"},
		// Longest-quote-first: suffix resolution never guesses.
		{"BTCTRY", executor.ExchangeBinance, "BTC/TRY"},
		{"BTCUSDTUSDT", executor.ExchangeBinance, "BTCUSDT/USDT"},
	}
	for _, c := range cases {
		got, err := FromVenueSymbol(c.venueSymbol, c.venue)
		if err != nil || got != c.want {
			t.Errorf("FromVenueSymbol(%q,%s) = (%q,%v), want %q", c.venueSymbol, c.venue, got, err, c.want)
		}
	}
}

func TestFromVenueSymbolRefusals(t *testing.T) {
	cases := []struct {
		name        string
		venueSymbol string
		venue       executor.ExchangeID
		wantErr     error
	}{
		{"unknown suffix never guessed", "BTCXYZ", executor.ExchangeBinance, ErrUnknownQuote},
		{"bare base has no quote", "BTC", executor.ExchangeBinance, ErrUnknownQuote},
		{"empty symbol", "", executor.ExchangeBinance, ErrInvalidSymbol},
		{"mexc unknown quote", "BTC_XYZ", executor.ExchangeMEXC, ErrUnknownQuote},
		{"mexc missing separator", "BTCUSDT", executor.ExchangeMEXC, ErrInvalidSymbol},
		{"mexc trailing separator", "BTC_", executor.ExchangeMEXC, ErrInvalidSymbol},
		{"unknown venue", "BTCUSDT", executor.ExchangeID("kraken"), ErrUnknownVenue},
	}
	for _, c := range cases {
		got, err := FromVenueSymbol(c.venueSymbol, c.venue)
		if got != "" || !errors.Is(err, c.wantErr) {
			t.Errorf("%s: FromVenueSymbol(%q,%s) = (%q,%v), want refusal %v", c.name, c.venueSymbol, c.venue, got, err, c.wantErr)
		}
	}
}

func TestSymbolRoundTrip(t *testing.T) {
	canonicals := []string{"BTC/USDT", "ETH/BTC", "SOL/USDC", "XRP/USDT"}
	venues := []executor.ExchangeID{executor.ExchangeBinance, executor.ExchangeBybit, executor.ExchangeMEXC}
	for _, v := range venues {
		for _, c := range canonicals {
			venueForm, err := ToVenueSymbol(c, v)
			if err != nil {
				t.Fatalf("ToVenueSymbol(%q,%s): %v", c, v, err)
			}
			back, err := FromVenueSymbol(venueForm, v)
			if err != nil || back != c {
				t.Errorf("round trip %q on %s: got (%q,%v)", c, v, back, err)
			}
		}
	}
}

func TestMaskAPIKey(t *testing.T) {
	cases := []struct{ key, want string }{
		{"", "***"},
		{"12345678", "***"}, // <= 8 chars never shows material
		{"123456789", "123...789"},
		{"abcdefghijklmnop", "abc...nop"},
	}
	for _, c := range cases {
		if got := MaskAPIKey(c.key); got != c.want {
			t.Errorf("MaskAPIKey(%q) = %q, want %q", c.key, got, c.want)
		}
	}
	if got := (Credentials{APIKey: "abcdefghijklmnop", APISecret: "s"}).Masked(); got != "abc...nop" {
		t.Errorf("Credentials.Masked() = %q", got)
	}
}

package exchanges

import (
	"errors"
	"testing"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
)

func TestToVenueSymbol(t *testing.T) {
	cases := []struct {
		canonical string
		venue     execution.ExchangeID
		want      string
	}{
		{"BTC/USDT", execution.ExchangeBinance, "BTCUSDT"},
		{"ETH/USDT", execution.ExchangeBinance, "ETHUSDT"},
		{"BTC/USDT", execution.ExchangeBybit, "BTCUSDT"},
		{"SOL/USDC", execution.ExchangeBybit, "SOLUSDC"},
		{"BTC/USDT", execution.ExchangeMEXC, "BTC_USDT"},
		{"ETH/BTC", execution.ExchangeMEXC, "ETH_BTC"},
		{"ETH/BTC", execution.ExchangeBinance, "ETHBTC"},
		{"USDT/USDT", execution.ExchangeBinance, "USDTUSDT"},
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
		venue     execution.ExchangeID
		wantErr   error
	}{
		{"no separator", "BTCUSDT", execution.ExchangeBinance, ErrInvalidSymbol},
		{"empty base", "/USDT", execution.ExchangeBinance, ErrInvalidSymbol},
		{"empty quote", "BTC/", execution.ExchangeBinance, ErrInvalidSymbol},
		{"extra separator", "BTC/USDT/USD", execution.ExchangeBinance, ErrInvalidSymbol},
		{"unknown quote", "BTC/XYZ", execution.ExchangeBinance, ErrUnknownQuote},
		{"settle suffix is not canonical", "BTC/USDT:USDT", execution.ExchangeBybit, ErrUnknownQuote},
		{"unknown venue", "BTC/USDT", execution.ExchangeID("kraken"), ErrUnknownVenue},
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
		venue       execution.ExchangeID
		want        string
	}{
		{"BTCUSDT", execution.ExchangeBinance, "BTC/USDT"},
		{"ETHBTC", execution.ExchangeBinance, "ETH/BTC"},
		{"BTCUSDT", execution.ExchangeBybit, "BTC/USDT"},
		{"SOLUSDC", execution.ExchangeBybit, "SOL/USDC"},
		{"BTC_USDT", execution.ExchangeMEXC, "BTC/USDT"},
		{"ETH_BTC", execution.ExchangeMEXC, "ETH/BTC"},
		// Longest-quote-first: suffix resolution never guesses.
		{"BTCTRY", execution.ExchangeBinance, "BTC/TRY"},
		{"BTCUSDTUSDT", execution.ExchangeBinance, "BTCUSDT/USDT"},
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
		venue       execution.ExchangeID
		wantErr     error
	}{
		{"unknown suffix never guessed", "BTCXYZ", execution.ExchangeBinance, ErrUnknownQuote},
		{"bare base has no quote", "BTC", execution.ExchangeBinance, ErrUnknownQuote},
		{"empty symbol", "", execution.ExchangeBinance, ErrInvalidSymbol},
		{"mexc unknown quote", "BTC_XYZ", execution.ExchangeMEXC, ErrUnknownQuote},
		{"mexc missing separator", "BTCUSDT", execution.ExchangeMEXC, ErrInvalidSymbol},
		{"mexc trailing separator", "BTC_", execution.ExchangeMEXC, ErrInvalidSymbol},
		{"unknown venue", "BTCUSDT", execution.ExchangeID("kraken"), ErrUnknownVenue},
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
	venues := []execution.ExchangeID{execution.ExchangeBinance, execution.ExchangeBybit, execution.ExchangeMEXC}
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

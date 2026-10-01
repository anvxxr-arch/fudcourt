package markets

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
)

var at = time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)

func TestSnapshotFromTickerHonestNullRule(t *testing.T) {
	cases := []struct {
		name    string
		ticker  Ticker
		want    Snapshot
		wantOK  bool
	}{
		{
			name:   "two-sided quote yields the touch pair",
			ticker: Ticker{Exchange: "binance", Symbol: "BTC/USDT", Bid: "100", Ask: "100.5", Last: "100.2", Ts: at},
			want:   Snapshot{Bid: "100", Ask: "100.5"}, wantOK: true,
		},
		{
			name:   "decimal strings pass through verbatim",
			ticker: Ticker{Exchange: "binance", Symbol: "BTC/USDT", Bid: "0.10000", Ask: "0.10010", Ts: at},
			want:   Snapshot{Bid: "0.10000", Ask: "0.10010"}, wantOK: true,
		},
		{
			// The canonical honesty case: a trade print must never be
			// promoted to a quote (no fabricated touch price).
			name:   "last-only ticker yields no snapshot",
			ticker: Ticker{Exchange: "binance", Symbol: "BTC/USDT", Last: "100.2", Ts: at},
			want:   Snapshot{}, wantOK: false,
		},
		{
			name:   "missing ask is honest absence, not a touch",
			ticker: Ticker{Exchange: "binance", Symbol: "BTC/USDT", Bid: "100", Last: "100.2", Ts: at},
			want:   Snapshot{}, wantOK: false,
		},
		{
			name:   "missing bid likewise",
			ticker: Ticker{Exchange: "binance", Symbol: "BTC/USDT", Ask: "100.5", Last: "100.2", Ts: at},
			want:   Snapshot{}, wantOK: false,
		},
		{
			name:   "fully empty ticker yields no snapshot",
			ticker: Ticker{Exchange: "binance", Symbol: "BTC/USDT", Ts: at},
			want:   Snapshot{}, wantOK: false,
		},
		{
			name:   "crossed touch is refused like a crossed book",
			ticker: Ticker{Exchange: "binance", Symbol: "BTC/USDT", Bid: "100.5", Ask: "100", Ts: at},
			want:   Snapshot{}, wantOK: false,
		},
		{
			name:   "zero bid is a fabricated price and refused",
			ticker: Ticker{Exchange: "binance", Symbol: "BTC/USDT", Bid: "0", Ask: "100", Ts: at},
			want:   Snapshot{}, wantOK: false,
		},
		{
			name:   "negative price refused",
			ticker: Ticker{Exchange: "binance", Symbol: "BTC/USDT", Bid: "-1", Ask: "100", Ts: at},
			want:   Snapshot{}, wantOK: false,
		},
		{
			name:   "unparseable price refused",
			ticker: Ticker{Exchange: "binance", Symbol: "BTC/USDT", Bid: "1e2", Ask: "100", Ts: at},
			want:   Snapshot{}, wantOK: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := SnapshotFromTicker(tc.ticker)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if got != tc.want {
				t.Fatalf("snapshot = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestValidatePerType(t *testing.T) {
	cases := []struct {
		name  string
		check func() error
		code  string
		field string // "" means the value must be accepted
	}{
		{"ticker valid", Ticker{Exchange: "binance", Symbol: "BTC/USDT", Bid: "1", Ask: "2", Last: "1.5", Ts: at}.Validate, "", ""},
		{"ticker empty price is absence", Ticker{Exchange: "binance", Symbol: "BTC/USDT", Ts: at}.Validate, "", ""},
		{"ticker missing exchange", Ticker{Symbol: "BTC/USDT", Bid: "1", Ts: at}.Validate, CodeTickerInvalid, "exchange"},
		{"ticker missing symbol", Ticker{Exchange: "binance", Bid: "1", Ts: at}.Validate, CodeTickerInvalid, "symbol"},
		{"ticker negative bid", Ticker{Exchange: "binance", Symbol: "BTC/USDT", Bid: "-1", Ts: at}.Validate, CodeTickerInvalid, "bid"},
		{"ticker zero ask", Ticker{Exchange: "binance", Symbol: "BTC/USDT", Ask: "0", Ts: at}.Validate, CodeTickerInvalid, "ask"},
		{"ticker bad last", Ticker{Exchange: "binance", Symbol: "BTC/USDT", Last: "abc", Ts: at}.Validate, CodeTickerInvalid, "last"},

		{"candle valid", Candle{Exchange: "binance", Symbol: "BTC/USDT", Interval: "1m", OpenTime: at, Open: "1", High: "3", Low: "0.5", Close: "2", Volume: "0"}.Validate, "", ""},
		{"candle high below low", Candle{Exchange: "binance", Symbol: "BTC/USDT", Interval: "1m", OpenTime: at, Open: "1", High: "0.5", Low: "1", Close: "1", Volume: "1"}.Validate, CodeCandleInvalid, "high/low"},
		{"candle close above high", Candle{Exchange: "binance", Symbol: "BTC/USDT", Interval: "1m", OpenTime: at, Open: "1", High: "2", Low: "0.5", Close: "3", Volume: "1"}.Validate, CodeCandleInvalid, "high/close"},
		{"candle negative volume", Candle{Exchange: "binance", Symbol: "BTC/USDT", Interval: "1m", OpenTime: at, Open: "1", High: "2", Low: "0.5", Close: "1", Volume: "-1"}.Validate, CodeCandleInvalid, "volume"},

		{"book valid", Book{Exchange: "binance", Symbol: "BTC/USDT", Bids: []Level{{"100", "1"}}, Asks: []Level{{"101", "1"}}, Ts: at}.Validate, "", ""},
		{"book empty is valid", Book{Exchange: "binance", Symbol: "BTC/USDT", Ts: at}.Validate, "", ""},
		{"book negative level price", Book{Exchange: "binance", Symbol: "BTC/USDT", Bids: []Level{{"-1", "1"}}, Ts: at}.Validate, CodeBookInvalid, "bids[0].price"},
		{"book negative level quantity", Book{Exchange: "binance", Symbol: "BTC/USDT", Asks: []Level{{"1", "-1"}}, Ts: at}.Validate, CodeBookInvalid, "asks[0].quantity"},

		{"mark price valid", MarkPrice{Exchange: "binance", Symbol: "BTC/USDT:USDT", Price: "100.5", Ts: at}.Validate, "", ""},
		{"mark price zero refused", MarkPrice{Exchange: "binance", Symbol: "BTC/USDT:USDT", Price: "0", Ts: at}.Validate, CodePriceInvalid, "price"},
		{"index price valid", IndexPrice{Exchange: "binance", Symbol: "BTC/USDT", Price: "100", Ts: at}.Validate, "", ""},
		{"index price negative", IndexPrice{Exchange: "binance", Symbol: "BTC/USDT", Price: "-1", Ts: at}.Validate, CodePriceInvalid, "price"},

		{"funding rate positive", FundingRate{Exchange: "binance", Symbol: "BTC/USDT:USDT", Rate: "0.0001", Ts: at}.Validate, "", ""},
		{"funding rate negative is real", FundingRate{Exchange: "binance", Symbol: "BTC/USDT:USDT", Rate: "-0.0001", Ts: at}.Validate, "", ""},
		{"funding rate zero is real", FundingRate{Exchange: "binance", Symbol: "BTC/USDT:USDT", Rate: "0", Ts: at}.Validate, "", ""},
		{"funding rate empty refused", FundingRate{Exchange: "binance", Symbol: "BTC/USDT:USDT", Ts: at}.Validate, CodeFundingInvalid, "rate"},

		{"open interest zero valid", OpenInterest{Exchange: "binance", Symbol: "BTC/USDT:USDT", Value: "0", Ts: at}.Validate, "", ""},
		{"open interest negative refused", OpenInterest{Exchange: "binance", Symbol: "BTC/USDT:USDT", Value: "-1", Ts: at}.Validate, CodeOpenInterestInvalid, "value"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.check()
			if tc.code == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			var e *errs.Error
			if !errors.As(err, &e) {
				t.Fatalf("err = %v, want *errs.Error", err)
			}
			if e.Category != errs.CategoryValidation {
				t.Fatalf("category = %q, want %q", e.Category, errs.CategoryValidation)
			}
			if e.Code != tc.code {
				t.Fatalf("code = %q, want %q", e.Code, tc.code)
			}
			if !strings.Contains(e.Message, tc.field) {
				t.Fatalf("message %q must name field %q", e.Message, tc.field)
			}
		})
	}
}

func TestCrossedBookIsRefusedNamingBothFields(t *testing.T) {
	b := Book{
		Exchange: "binance",
		Symbol:   "BTC/USDT",
		Bids:     []Level{{"101", "1"}},
		Asks:     []Level{{"100", "1"}},
		Ts:       at,
	}
	err := b.Validate()
	var e *errs.Error
	if !errors.As(err, &e) {
		t.Fatalf("err = %v, want *errs.Error", err)
	}
	if e.Category != errs.CategoryValidation || e.Code != CodeBookCrossed {
		t.Fatalf("got %s/%s, want validation/%s", e.Category, e.Code, CodeBookCrossed)
	}
	for _, field := range []string{"bids", "asks"} {
		if !strings.Contains(e.Message, field) {
			t.Fatalf("message %q must name field %q", e.Message, field)
		}
	}

	// A book crossing at depth but with a sane touch is not a crossed book:
	// only the best levels define the touch.
	sane := Book{
		Exchange: "binance",
		Symbol:   "BTC/USDT",
		Bids:     []Level{{"100", "1"}, {"103", "1"}},
		Asks:     []Level{{"101", "1"}, {"99", "1"}},
		Ts:       at,
	}
	if err := sane.Validate(); err != nil {
		t.Fatalf("deep book with a sane touch must validate: %v", err)
	}
}

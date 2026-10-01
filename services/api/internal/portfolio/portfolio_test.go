package portfolio

import (
	"errors"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
)

func str(s string) *string { return &s }

func deref(t *testing.T, p *string, what string) string {
	t.Helper()
	if p == nil {
		t.Fatalf("%s is nil", what)
	}
	return *p
}

func TestDeriveTotalsOnlyKnownHoldings(t *testing.T) {
	v, err := Derive([]Holding{
		{Asset: "BTC", Quantity: "0.5"},
		{Asset: "USDT", Quantity: "100.25"},
	}, map[string]string{"BTC": "30000", "USDT": "1"})
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if got := deref(t, v.TotalValueUSD, "TotalValueUSD"); got != "15100.25" {
		t.Fatalf("TotalValueUSD = %q, want %q", got, "15100.25")
	}
	if len(v.MissingPrices) != 0 {
		t.Fatalf("MissingPrices = %v, want empty", v.MissingPrices)
	}
	// The derived view re-derives per-holding values; it does not trust the
	// caller's ValueUSD field.
	if got := deref(t, v.Holdings[0].ValueUSD, "BTC value"); got != "15000" {
		t.Fatalf("BTC value = %q, want %q", got, "15000")
	}
	if v.AsOf == 0 {
		t.Fatal("AsOf must stamp when the view was derived")
	}
}

func TestDeriveMissingPriceHonesty(t *testing.T) {
	v, err := Derive([]Holding{
		{Asset: "BTC", Quantity: "1", ValueUSD: str("99999")},
		{Asset: "MOON", Quantity: "500"},
		{Asset: "DUST", Quantity: "0.0001"},
	}, map[string]string{"BTC": "30000"})
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if v.TotalValueUSD != nil {
		t.Fatalf("TotalValueUSD = %q, want nil when a holding is unpriced", *v.TotalValueUSD)
	}
	if len(v.MissingPrices) != 2 || v.MissingPrices[0] != "DUST" || v.MissingPrices[1] != "MOON" {
		t.Fatalf("MissingPrices = %v, want sorted [DUST MOON]", v.MissingPrices)
	}
	// Known holdings still carry their known values — honesty about the total
	// does not erase what IS known.
	if got := deref(t, v.Holdings[0].ValueUSD, "BTC value"); got != "30000" {
		t.Fatalf("BTC value = %q, want %q (the derived value, not the caller's 99999)", got, "30000")
	}
	if v.Holdings[1].ValueUSD != nil {
		t.Fatal("an unpriced holding's value must be nil, never 0")
	}
}

func TestDeriveEmptyPortfolioIsRealZero(t *testing.T) {
	v, err := Derive(nil, nil)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if got := deref(t, v.TotalValueUSD, "TotalValueUSD"); got != "0" {
		t.Fatalf("empty portfolio total = %q, want %q (nothing is unknown)", got, "0")
	}
}

func TestDeriveRefusesUnparsableInputs(t *testing.T) {
	_, err := Derive([]Holding{{Asset: "BTC", Quantity: "1/2"}}, nil)
	var canonical *errs.Error
	if !errors.As(err, &canonical) || canonical.Code != "PORTFOLIO_AMOUNT_INVALID" {
		t.Fatalf("err = %v, want PORTFOLIO_AMOUNT_INVALID", err)
	}
	if !strings.Contains(canonical.Message, "quantity") {
		t.Fatalf("message %q does not name the field", canonical.Message)
	}
	_, err = Derive([]Holding{{Asset: "BTC", Quantity: "1"}}, map[string]string{"BTC": "thirty thousand"})
	if !errors.As(err, &canonical) || canonical.Code != "PORTFOLIO_AMOUNT_INVALID" || !strings.Contains(canonical.Message, "price") {
		t.Fatalf("bad price err = %v, want PORTFOLIO_AMOUNT_INVALID naming price", err)
	}
}

func TestExposureByAssetNotionalExact(t *testing.T) {
	exposures, err := ExposureByAsset([]Position{
		{InstrumentID: "BTCUSDT", Side: SideLong, Quantity: "0.1", EntryPrice: "30000"},
		{InstrumentID: "BTCUSDT", Side: SideShort, Quantity: "0.05", EntryPrice: "31000"},
		{InstrumentID: "ETHUSDT", Side: SideLong, Quantity: "0.3", EntryPrice: "1000.5"},
	})
	if err != nil {
		t.Fatalf("ExposureByAsset: %v", err)
	}
	if len(exposures) != 2 {
		t.Fatalf("exposures = %v, want one per instrument", exposures)
	}
	// Sorted by asset; short notional is a gross magnitude (side carries sign).
	if exposures[0].Asset != "BTCUSDT" || exposures[0].NotionalUSD != "4550" {
		t.Fatalf("BTCUSDT exposure = %+v, want gross %q (3000 + 1550)", exposures[0], "4550")
	}
	if exposures[1].Asset != "ETHUSDT" || exposures[1].NotionalUSD != "300.15" {
		t.Fatalf("ETHUSDT exposure = %+v, want %q (0.3×1000.5 exact)", exposures[1], "300.15")
	}
}

func TestRealizedPnlLongSignsAndFees(t *testing.T) {
	// Long 1 BTC @ 30000, exit @ 35000, fees 20 + 30: 5000 − 50 = 4950.
	got, err := RealizedPnl(
		[]EntryFill{{Side: SideLong, Price: "30000", Quantity: "1", Fee: "20"}},
		[]ExitFill{{Side: SideLong, Price: "35000", Quantity: "1", Fee: "30"}},
	)
	if err != nil {
		t.Fatalf("RealizedPnl: %v", err)
	}
	if got != "4950" {
		t.Fatalf("long profit = %q, want %q (proceeds − basis − every fee)", got, "4950")
	}
	// Falling market on a long is a loss: 25000 − 30000 − 50 = −5050.
	got, err = RealizedPnl(
		[]EntryFill{{Side: SideLong, Price: "30000", Quantity: "1", Fee: "20"}},
		[]ExitFill{{Side: SideLong, Price: "25000", Quantity: "1", Fee: "30"}},
	)
	if err != nil {
		t.Fatalf("RealizedPnl: %v", err)
	}
	if got != "-5050" {
		t.Fatalf("long loss = %q, want %q", got, "-5050")
	}
}

func TestRealizedPnlShortSigns(t *testing.T) {
	// Short 1 BTC @ 30000 (venue sell), cover @ 25000: 30000 − 25000 − 50 = 4950
	// — a short PROFITS when the price falls.
	got, err := RealizedPnl(
		[]EntryFill{{Side: SideShort, Price: "30000", Quantity: "1", Fee: "20"}},
		[]ExitFill{{Side: SideShort, Price: "25000", Quantity: "1", Fee: "30"}},
	)
	if err != nil {
		t.Fatalf("RealizedPnl: %v", err)
	}
	if got != "4950" {
		t.Fatalf("short profit = %q, want %q", got, "4950")
	}
	// Rising market on a short is a loss: 30000 − 35000 − 50 = −5050.
	got, err = RealizedPnl(
		[]EntryFill{{Side: SideShort, Price: "30000", Quantity: "1", Fee: "20"}},
		[]ExitFill{{Side: SideShort, Price: "35000", Quantity: "1", Fee: "30"}},
	)
	if err != nil {
		t.Fatalf("RealizedPnl: %v", err)
	}
	if got != "-5050" {
		t.Fatalf("short loss = %q, want %q", got, "-5050")
	}
}

func TestRealizedPnlAverageEntryAcrossFills(t *testing.T) {
	// Long 1 @ 10 and 1 @ 12 (avg 11), exit both @ 13, no fees: 2×13 − 2×11 = 4.
	got, err := RealizedPnl(
		[]EntryFill{
			{Side: SideLong, Price: "10", Quantity: "1", Fee: "0"},
			{Side: SideLong, Price: "12", Quantity: "1", Fee: "0"},
		},
		[]ExitFill{
			{Side: SideLong, Price: "13", Quantity: "1", Fee: "0"},
			{Side: SideLong, Price: "13", Quantity: "1", Fee: "0"},
		},
	)
	if err != nil {
		t.Fatalf("RealizedPnl: %v", err)
	}
	if got != "4" {
		t.Fatalf("avg-entry pnl = %q, want %q", got, "4")
	}
	// Partial exit uses the average-entry basis: exit 1 of 2 @ 13 → 13 − 11 = 2.
	got, err = RealizedPnl(
		[]EntryFill{
			{Side: SideLong, Price: "10", Quantity: "1", Fee: "0"},
			{Side: SideLong, Price: "12", Quantity: "1", Fee: "0"},
		},
		[]ExitFill{{Side: SideLong, Price: "13", Quantity: "1", Fee: "0"}},
	)
	if err != nil {
		t.Fatalf("RealizedPnl: %v", err)
	}
	if got != "2" {
		t.Fatalf("partial-exit pnl = %q, want %q", got, "2")
	}
}

func TestRealizedPnlRefusals(t *testing.T) {
	cases := map[string]struct {
		entries []EntryFill
		exits   []ExitFill
		code    string
	}{
		"no fills at all": {nil, nil, "PORTFOLIO_FILLS_REQUIRED"},
		"entry only": {
			[]EntryFill{{Side: SideLong, Price: "1", Quantity: "1", Fee: "0"}}, nil, "PORTFOLIO_FILLS_REQUIRED",
		},
		"mixed sides": {
			[]EntryFill{{Side: SideLong, Price: "1", Quantity: "1", Fee: "0"}},
			[]ExitFill{{Side: SideShort, Price: "1", Quantity: "1", Fee: "0"}},
			"PORTFOLIO_SIDE_INVALID",
		},
		"negative quantity": {
			[]EntryFill{{Side: SideLong, Price: "1", Quantity: "-1", Fee: "0"}},
			[]ExitFill{{Side: SideLong, Price: "1", Quantity: "1", Fee: "0"}},
			"PORTFOLIO_AMOUNT_INVALID",
		},
		"unparsable fee": {
			[]EntryFill{{Side: SideLong, Price: "1", Quantity: "1", Fee: "free"}},
			[]ExitFill{{Side: SideLong, Price: "1", Quantity: "1", Fee: "0"}},
			"PORTFOLIO_AMOUNT_INVALID",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := RealizedPnl(tc.entries, tc.exits)
			var canonical *errs.Error
			if !errors.As(err, &canonical) || canonical.Code != tc.code {
				t.Fatalf("err = %v, want code %s", err, tc.code)
			}
			if canonical.Category != errs.CategoryValidation {
				t.Fatalf("category = %q, want validation", canonical.Category)
			}
		})
	}
}

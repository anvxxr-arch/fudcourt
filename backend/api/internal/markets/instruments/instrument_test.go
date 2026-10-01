package instruments

import (
	"errors"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
)

func validInstrument() Instrument {
	return Instrument{
		InstrumentID:      "binance:spot:BTC/USDT",
		BaseAsset:         "BTC",
		QuoteAsset:        "USDT",
		MarketType:        MarketTypeSpot,
		Exchange:          "binance",
		ExchangeSymbol:    "BTCUSDT",
		TickSize:          "0.01",
		QuantityStep:      "0.001",
		MinQuantity:       "0.0001",
		MinNotional:       "5",
		ContractSize:      "1",
		PricePrecision:    2,
		QuantityPrecision: 3,
		MaxLeverage:       1,
	}
}

func TestValidateAcceptsWellFormedGrid(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Instrument)
	}{
		{"as constructed", func(*Instrument) {}},
		{"whole-unit grid", func(i *Instrument) { i.TickSize = "1"; i.QuantityStep = "1"; i.PricePrecision = 0; i.QuantityPrecision = 0 }},
		{"optional minima absent", func(i *Instrument) { i.MinQuantity = ""; i.MinNotional = "" }},
		{"perp contract size", func(i *Instrument) {
			i.MarketType = MarketTypeLinearPerp
			i.ContractSize = "0.001"
			i.MaxLeverage = 125
		}},
		{"trailing zeros in grid", func(i *Instrument) { i.TickSize = "0.0100"; i.QuantityStep = "0.0010" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			inst := validInstrument()
			tc.mutate(&inst)
			if err := Validate(inst); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestValidateRefusesBadGridWithoutClamping(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Instrument)
		code   string
		field  string
	}{
		{"missing base", func(i *Instrument) { i.BaseAsset = "" }, CodeSymbolUnknown, "base_asset"},
		{"missing quote", func(i *Instrument) { i.QuoteAsset = "" }, CodeSymbolUnknown, "quote_asset"},
		{"missing tick", func(i *Instrument) { i.TickSize = "" }, CodeStepInvalid, "tick_size"},
		{"zero tick", func(i *Instrument) { i.TickSize = "0" }, CodeStepInvalid, "tick_size"},
		{"negative tick", func(i *Instrument) { i.TickSize = "-0.01" }, CodeStepInvalid, "tick_size"},
		{"unparseable tick", func(i *Instrument) { i.TickSize = "0.0.1" }, CodeStepInvalid, "tick_size"},
		{"missing step", func(i *Instrument) { i.QuantityStep = "" }, CodeStepInvalid, "quantity_step"},
		{"zero step", func(i *Instrument) { i.QuantityStep = "0" }, CodeStepInvalid, "quantity_step"},
		{"negative step", func(i *Instrument) { i.QuantityStep = "-0.001" }, CodeStepInvalid, "quantity_step"},
		{"zero contract size", func(i *Instrument) { i.ContractSize = "0" }, CodeStepInvalid, "contract_size"},
		{"missing contract size", func(i *Instrument) { i.ContractSize = "" }, CodeStepInvalid, "contract_size"},
		{"zero min quantity", func(i *Instrument) { i.MinQuantity = "0" }, CodeStepInvalid, "min_quantity"},
		{"negative min notional", func(i *Instrument) { i.MinNotional = "-5" }, CodeStepInvalid, "min_notional"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			inst := validInstrument()
			tc.mutate(&inst)
			err := Validate(inst)
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
			if !strings.Contains(e.Message, "field "+tc.field) {
				t.Fatalf("message %q must name field %q", e.Message, tc.field)
			}
			// Never clamp: the refused instrument is returned untouched.
			if err := Validate(inst); err == nil {
				t.Fatal("a bad grid must stay bad after validation")
			}
		})
	}
}

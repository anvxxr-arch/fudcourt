package instruments

import (
	"errors"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
)

// The rounding vectors mirror apps/web/scripts/tests/executor-risk-tests.ts
// ("roundQuantityDown floors to the step grid", "roundPrice snaps to tick,
// ties half-up", "huge quantities keep exact cents through Decimal").
func TestRoundQuantityDownVectors(t *testing.T) {
	cases := []struct {
		name     string
		quantity string
		step     string
		want     string
	}{
		{"floor to grid", "0.012583", "0.001", "0.012"},
		{"numeric spelling as string", "0.012583", "0.001", "0.012"},
		{"boundary value preserved", "0.013", "0.001", "0.013"},
		{"just below boundary", "0.0129999", "0.001", "0.012"},
		{"rounds to zero", "0.0009", "0.001", "0"},
		{"huge keeps exact cents", "123456789012.345", "0.001", "123456789012.345"},
		{"whole-unit step", "10", "3", "9"},
		{"step with trailing zeros", "1.2", "0.5000", "1"},
		{"zero quantity", "0", "0.001", "0"},
		{"on grid at scale", "61728394.506", "0.001", "61728394.506"},
		{"exactly one step", "0.001", "0.001", "0.001"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := RoundQuantityDown(tc.quantity, tc.step)
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("RoundQuantityDown(%q, %q) = %q, want %q", tc.quantity, tc.step, got, tc.want)
			}
		})
	}
}

func TestRoundPriceVectors(t *testing.T) {
	cases := []struct {
		name  string
		price string
		tick  string
		want  string
	}{
		{"exact tie rounds up", "1.005", "0.01", "1.01"},
		{"just below tie", "1.004", "0.01", "1"},
		{"string input at 4 dp", "100.0049", "0.01", "100"},
		{"cents snapping", "98000.126", "0.01", "98000.13"},
		{"huge keeps exact cents", "123456789012.345", "0.001", "123456789012.345"},
		{"already on tick", "0.01", "0.01", "0.01"},
		{"tie at whole unit", "2.5", "1", "3"},
		{"zero price", "0", "0.01", "0"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := RoundPrice(tc.price, tc.tick)
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("RoundPrice(%q, %q) = %q, want %q", tc.price, tc.tick, got, tc.want)
			}
		})
	}
}

// INVARIANT: never guess — bad input yields a refusal naming the field, never
// a coerced number (the TS engine clamps some of these to 0; the Go domain
// refuses outright).
func TestRoundingRefusesBadInput(t *testing.T) {
	quantityCases := []struct {
		name     string
		quantity string
		step     string
		code     string
		field    string
	}{
		{"negative quantity", "-0.005", "0.001", CodeQuantityInvalid, "quantity"},
		{"empty quantity", "", "0.001", CodeQuantityInvalid, "quantity"},
		{"unparseable quantity", "abc", "0.001", CodeQuantityInvalid, "quantity"},
		{"exponent quantity", "1e-3", "0.001", CodeQuantityInvalid, "quantity"},
		{"empty step", "0.01", "", CodeStepInvalid, "quantity_step"},
		{"zero step", "0.01", "0", CodeStepInvalid, "quantity_step"},
		{"negative step", "0.01", "-0.001", CodeStepInvalid, "quantity_step"},
		{"unparseable step", "0.01", "0.0.1", CodeStepInvalid, "quantity_step"},
	}
	for _, tc := range quantityCases {
		t.Run("quantity "+tc.name, func(t *testing.T) {
			got, err := RoundQuantityDown(tc.quantity, tc.step)
			assertRefusal(t, got, err, tc.code, tc.field)
		})
	}

	priceCases := []struct {
		name  string
		price string
		tick  string
		code  string
		field string
	}{
		{"negative price", "-1.005", "0.01", CodePriceInvalid, "price"},
		{"empty price", "", "0.01", CodePriceInvalid, "price"},
		{"unparseable price", "1,005", "0.01", CodePriceInvalid, "price"},
		{"hex price", "0x10", "0.01", CodePriceInvalid, "price"},
		{"empty tick", "1.005", "", CodeStepInvalid, "tick_size"},
		{"zero tick", "1.005", "0", CodeStepInvalid, "tick_size"},
		{"negative tick", "1.005", "-0.01", CodeStepInvalid, "tick_size"},
	}
	for _, tc := range priceCases {
		t.Run("price "+tc.name, func(t *testing.T) {
			got, err := RoundPrice(tc.price, tc.tick)
			assertRefusal(t, got, err, tc.code, tc.field)
		})
	}
}

func assertRefusal(t *testing.T, got string, err error, code, field string) {
	t.Helper()
	if err == nil {
		t.Fatalf("must refuse, got %q", got)
	}
	if got != "" {
		t.Fatalf("refusal must yield no number, got %q", got)
	}
	var e *errs.Error
	if !errors.As(err, &e) {
		t.Fatalf("err = %v, want *errs.Error", err)
	}
	if e.Category != errs.CategoryValidation {
		t.Fatalf("category = %q, want %q", e.Category, errs.CategoryValidation)
	}
	if e.Code != code {
		t.Fatalf("code = %q, want %q", e.Code, code)
	}
	if !strings.Contains(e.Message, "field "+field) {
		t.Fatalf("message %q must name field %q", e.Message, field)
	}
}

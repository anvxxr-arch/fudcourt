package treasury

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
)

func wantRefusal(t *testing.T, err error, code string, category errs.Category, namesFigures string) {
	t.Helper()
	var canonical *errs.Error
	if !errors.As(err, &canonical) {
		t.Fatalf("error %v is not a canonical errs.Error", err)
	}
	if canonical.Code != code {
		t.Fatalf("code = %q, want %q (message %q)", canonical.Code, code, canonical.Message)
	}
	if canonical.Category != category {
		t.Fatalf("category = %q, want %q", canonical.Category, category)
	}
	if namesFigures != "" && !strings.Contains(canonical.Message, namesFigures) {
		t.Fatalf("message %q does not contain %q", canonical.Message, namesFigures)
	}
}

func TestAllocateReserveMathExact(t *testing.T) {
	got, err := Allocate("ops", "100.10", "30.05")
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	want := Allocation{AccountID: "ops", Reserved: "30.05", Available: "70.05"}
	if got != want {
		t.Fatalf("Allocation = %+v, want %+v", got, want)
	}
	// The split is exact: 0.1 + 0.2 style inputs must not drift.
	got, err = Allocate("ops", "0.3", "0.1")
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	if got.Reserved != "0.1" || got.Available != "0.2" {
		t.Fatalf("Allocation = %+v, want reserved 0.1 available 0.2", got)
	}
}

func TestAllocateRefusals(t *testing.T) {
	cases := []struct {
		name           string
		accountID      string
		total, reserve string
		code           string
		category       errs.Category
		namesFigures   string
	}{
		{"blank account", "", "10", "1", "TREASURY_FIELD_REQUIRED", errs.CategoryValidation, "accountID"},
		{"unparsable total", "a", "ten", "1", "TREASURY_AMOUNT_INVALID", errs.CategoryValidation, "total"},
		{"unparsable reserve", "a", "10", "1/2", "TREASURY_AMOUNT_INVALID", errs.CategoryValidation, "reserve"},
		{"negative total", "a", "-10", "1", "TREASURY_AMOUNT_INVALID", errs.CategoryValidation, "total"},
		{"negative reserve", "a", "10", "-1", "TREASURY_AMOUNT_INVALID", errs.CategoryValidation, "reserve"},
		{"reserve exceeds total", "a", "5", "7", "TREASURY_INSUFFICIENT_FUNDS", errs.CategoryInsufficientBalance, "required=7, available=5"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Allocate(tc.accountID, tc.total, tc.reserve)
			if err == nil {
				t.Fatal("Allocate must refuse")
			}
			wantRefusal(t, err, tc.code, tc.category, tc.namesFigures)
		})
	}
}

func TestMoveAppliesWithoutMutatingInput(t *testing.T) {
	balances := Balances{"a": "100", "b": "0", "c": "0.5"}
	movements := []Movement{
		{ID: "m1", FromAccountID: "a", ToAccountID: "b", Asset: "USDT", Amount: "40", Reason: "seed desk", OccurredAt: 1},
		{ID: "m2", FromAccountID: "b", ToAccountID: "c", Asset: "USDT", Amount: "25.5", Reason: "fund wallet", OccurredAt: 2},
	}
	got, err := Move(balances, movements)
	if err != nil {
		t.Fatalf("Move: %v", err)
	}
	want := Balances{"a": "60", "b": "14.5", "c": "26"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("balances = %v, want %v (multi-hop: m2 spends m1's proceeds)", got, want)
	}
	if !reflect.DeepEqual(balances, Balances{"a": "100", "b": "0", "c": "0.5"}) {
		t.Fatalf("Move mutated its input: %v", balances)
	}
}

func TestMoveInsufficientRefusalNamesBothFigures(t *testing.T) {
	balances := Balances{"a": "5.25", "b": "0"}
	movements := []Movement{
		{ID: "m1", FromAccountID: "a", ToAccountID: "b", Asset: "USDT", Amount: "10", Reason: "overdraw", OccurredAt: 1},
	}
	_, err := Move(balances, movements)
	wantRefusal(t, err, "TREASURY_INSUFFICIENT_FUNDS", errs.CategoryInsufficientBalance, "required=10, available=5.25")
	if !reflect.DeepEqual(balances, Balances{"a": "5.25", "b": "0"}) {
		t.Fatalf("refused Move mutated its input: %v", balances)
	}
}

func TestMoveRefusesMalformedMovements(t *testing.T) {
	balances := Balances{"a": "10", "b": "10"}
	base := Movement{ID: "m", FromAccountID: "a", ToAccountID: "b", Asset: "USDT", Amount: "1", Reason: "test", OccurredAt: 1}
	cases := []struct {
		name     string
		mut      func(*Movement)
		code     string
		category errs.Category
		figures  string
	}{
		{"blank from", func(m *Movement) { m.FromAccountID = " " }, "TREASURY_FIELD_REQUIRED", errs.CategoryValidation, "fromAccountID"},
		{"blank to", func(m *Movement) { m.ToAccountID = "" }, "TREASURY_FIELD_REQUIRED", errs.CategoryValidation, "toAccountID"},
		{"blank asset", func(m *Movement) { m.Asset = "" }, "TREASURY_FIELD_REQUIRED", errs.CategoryValidation, "asset"},
		{"blank reason", func(m *Movement) { m.Reason = "  " }, "TREASURY_FIELD_REQUIRED", errs.CategoryValidation, "reason"},
		{"self move", func(m *Movement) { m.ToAccountID = m.FromAccountID }, "TREASURY_MOVEMENT_INVALID", errs.CategoryValidation, "m"},
		{"zero amount", func(m *Movement) { m.Amount = "0" }, "TREASURY_AMOUNT_INVALID", errs.CategoryValidation, "amount"},
		{"negative amount", func(m *Movement) { m.Amount = "-3" }, "TREASURY_AMOUNT_INVALID", errs.CategoryValidation, "amount"},
		{"unparsable amount", func(m *Movement) { m.Amount = "1 USDT" }, "TREASURY_AMOUNT_INVALID", errs.CategoryValidation, "amount"},
		{"unknown source", func(m *Movement) { m.FromAccountID = "ghost" }, "TREASURY_ACCOUNT_UNKNOWN", errs.CategoryValidation, "ghost"},
		{"unknown destination", func(m *Movement) { m.ToAccountID = "ghost" }, "TREASURY_ACCOUNT_UNKNOWN", errs.CategoryValidation, "ghost"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := base
			tc.mut(&m)
			_, err := Move(balances, []Movement{m})
			if err == nil {
				t.Fatal("Move must refuse")
			}
			wantRefusal(t, err, tc.code, tc.category, tc.figures)
		})
	}
}

func TestMoveRefusesUnparsableSnapshotBalances(t *testing.T) {
	_, err := Move(Balances{"a": "1.21 gigawatts"}, nil)
	wantRefusal(t, err, "TREASURY_AMOUNT_INVALID", errs.CategoryValidation, "balance")
}

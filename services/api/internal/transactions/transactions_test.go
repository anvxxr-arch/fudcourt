package transactions

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
)

func wantRefusal(t *testing.T, err error, code, namesField string) {
	t.Helper()
	var canonical *errs.Error
	if !errors.As(err, &canonical) {
		t.Fatalf("error %v is not a canonical errs.Error", err)
	}
	if canonical.Code != code {
		t.Fatalf("code = %q, want %q (message %q)", canonical.Code, code, canonical.Message)
	}
	if canonical.Category != errs.CategoryValidation {
		t.Fatalf("category = %q, want validation", canonical.Category)
	}
	if namesField != "" && !strings.Contains(canonical.Message, namesField) {
		t.Fatalf("message %q does not name %q", canonical.Message, namesField)
	}
}

func TestDirectionOfMirrorsSchemaSignRule(t *testing.T) {
	cases := []struct {
		amount string
		want   Direction
	}{
		{"12.5", DirectionIn},
		{"0", DirectionIn}, // SCHEMA.md: >= 0 → IN, kept as written
		{"-0.01", DirectionOut},
	}
	for _, tc := range cases {
		got, err := DirectionOf(tc.amount)
		if err != nil {
			t.Fatalf("DirectionOf(%q): %v", tc.amount, err)
		}
		if got != tc.want {
			t.Fatalf("DirectionOf(%q) = %q, want %q", tc.amount, got, tc.want)
		}
	}
	_, err := DirectionOf("three dollars")
	wantRefusal(t, err, "TXN_AMOUNT_INVALID", "amount")
}

func TestNewDerivesDirectionAndDefaults(t *testing.T) {
	got, err := New(Transaction{Date: "2026-10-01", Event: "deposit", AmountUSD: "-00010.500"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if got.Direction != DirectionOut {
		t.Fatalf("Direction = %q, want derived %q", got.Direction, DirectionOut)
	}
	if got.AmountUSD != "-10.5" {
		t.Fatalf("AmountUSD = %q, want canonical %q", got.AmountUSD, "-10.5")
	}
	if got.Chain != DefaultChain || got.Asset != DefaultAsset || got.Source != DefaultSource {
		t.Fatalf("defaults not applied: %+v", got)
	}

	// An explicit direction AGREEING with the sign is kept as given.
	got, err = New(Transaction{Date: "2026-10-01", Event: "deposit", AmountUSD: "5", Direction: DirectionIn})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if got.Direction != DirectionIn {
		t.Fatalf("Direction = %q, want %q", got.Direction, DirectionIn)
	}
}

func TestNewRefusals(t *testing.T) {
	base := Transaction{Date: "2026-10-01", Event: "deposit", AmountUSD: "5"}
	cases := []struct {
		name  string
		mut   func(*Transaction)
		code  string
		field string
	}{
		{"missing date", func(t *Transaction) { t.Date = " " }, "TXN_DATE_REQUIRED", "date"},
		{"malformed date", func(t *Transaction) { t.Date = "10/01/2026" }, "TXN_DATE_INVALID", "date"},
		{"missing event", func(t *Transaction) { t.Event = "" }, "TXN_EVENT_REQUIRED", "event"},
		{"unparsable amount", func(t *Transaction) { t.AmountUSD = "$5" }, "TXN_AMOUNT_INVALID", "amount"},
		{"nonsense direction", func(t *Transaction) { t.Direction = "sideways" }, "TXN_DIRECTION_CONFLICT", "direction"},
		{"direction disagrees with sign", func(t *Transaction) { t.Direction = DirectionIn; t.AmountUSD = "-5" },
			"TXN_DIRECTION_CONFLICT", "direction"},
		{"direction disagrees with zero sign", func(t *Transaction) { t.Direction = DirectionOut; t.AmountUSD = "0" },
			"TXN_DIRECTION_CONFLICT", "direction"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tx := base
			tc.mut(&tx)
			_, err := New(tx)
			if err == nil {
				t.Fatal("New must refuse")
			}
			wantRefusal(t, err, tc.code, tc.field)
		})
	}
}

func TestMergeTotalOrderWithTies(t *testing.T) {
	mk := func(id int64, date, source string) Transaction {
		return Transaction{ID: id, Date: date, Event: "deposit", AmountUSD: "1", Direction: DirectionIn, Source: source}
	}
	a := []Transaction{mk(2, "2026-10-01", "ledger"), mk(1, "2026-09-30", "ledger")}
	b := []Transaction{mk(1, "2026-10-01", "chain"), mk(3, "2026-09-30", "chain")}

	merged := Merge(a, b)
	wantOrder := []struct {
		id   int64
		date string
	}{
		{2, "2026-10-01"}, // same date: id DESC
		{1, "2026-10-01"},
		{3, "2026-09-30"}, // same date: id DESC
		{1, "2026-09-30"},
	}
	for i, want := range wantOrder {
		if merged[i].ID != want.id || merged[i].Date != want.date {
			t.Fatalf("merged[%d] = %d/%s, want %d/%s", i, merged[i].ID, merged[i].Date, want.id, want.date)
		}
	}

	// Provenance survives the merge: Source is never dropped.
	sources := map[int64][]string{}
	for _, tx := range merged {
		sources[tx.ID] = append(sources[tx.ID], tx.Source)
	}
	if !reflect.DeepEqual(sources[1], []string{"chain", "ledger"}) {
		t.Fatalf("id 1 sources = %v, want both provenances preserved", sources[1])
	}

	// The order is total and deterministic: merging the same rows in another
	// input order yields the same view (stable tie handling), and re-merging
	// is idempotent in shape.
	reordered := Merge(b, a)
	for i := range merged {
		if reordered[i].ID != merged[i].ID || reordered[i].Date != merged[i].Date {
			t.Fatalf("ordering not deterministic at %d: got %d/%s, want %d/%s",
				i, reordered[i].ID, reordered[i].Date, merged[i].ID, merged[i].Date)
		}
	}
	// (Date, ID) ties keep merge order — total order means comparable rows are
	// interchangeable only when identical; the stable sort pins even those.
	tied := Merge([]Transaction{mk(7, "2026-10-01", "first")}, []Transaction{mk(7, "2026-10-01", "second")})
	if tied[0].Source != "first" || tied[1].Source != "second" {
		t.Fatalf("tied rows reordered: %v", tied)
	}
}

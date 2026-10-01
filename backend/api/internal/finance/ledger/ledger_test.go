package ledger

import (
	"errors"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
)

func wantRefusal(t *testing.T, err error, code string, namesField string) {
	t.Helper()
	var canonical *errs.Error
	if !errors.As(err, &canonical) {
		t.Fatalf("error %v is not a canonical errs.Error", err)
	}
	if canonical.Code != code {
		t.Fatalf("code = %q, want %q (message %q)", canonical.Code, code, canonical.Message)
	}
	if canonical.Category != errs.CategoryValidation && code != "LEDGER_DUPLICATE" {
		t.Fatalf("category = %q, want validation-class refusal", canonical.Category)
	}
	if namesField != "" && !strings.Contains(canonical.Message, namesField) {
		t.Fatalf("message %q does not name field %q", canonical.Message, namesField)
	}
}

func validEntry() Entry {
	return Entry{
		ID: "e-1", AccountID: "acct-1", Asset: "USDT", Amount: "10.50",
		Kind: KindDeposit, OccurredAtMs: 1700000000000, CreatedAt: 1700000000001,
	}
}

func TestNewEntryRefusals(t *testing.T) {
	cases := []struct {
		name  string
		mut   func(*Entry)
		code  string
		field string
	}{
		{"missing id", func(e *Entry) { e.ID = "" }, "LEDGER_FIELD_REQUIRED", "id"},
		{"missing account", func(e *Entry) { e.AccountID = "  " }, "LEDGER_FIELD_REQUIRED", "accountID"},
		{"missing asset", func(e *Entry) { e.Asset = "" }, "LEDGER_FIELD_REQUIRED", "asset"},
		{"zero amount", func(e *Entry) { e.Amount = "0" }, "LEDGER_AMOUNT_INVALID", "amount"},
		{"negative zero amount", func(e *Entry) { e.Amount = "-0.000" }, "LEDGER_AMOUNT_INVALID", "amount"},
		{"unparsable amount", func(e *Entry) { e.Amount = "10,5" }, "LEDGER_AMOUNT_INVALID", "amount"},
		{"exponent amount", func(e *Entry) { e.Amount = "1e2" }, "LEDGER_AMOUNT_INVALID", "amount"},
		{"fraction amount", func(e *Entry) { e.Amount = "1/2" }, "LEDGER_AMOUNT_INVALID", "amount"},
		{"unknown kind", func(e *Entry) { e.Kind = "burn" }, "LEDGER_KIND_INVALID", "kind"},
		{"empty kind", func(e *Entry) { e.Kind = "" }, "LEDGER_KIND_INVALID", "kind"},
		{"settlement without reference type", func(e *Entry) {
			e.Kind, e.ReferenceType, e.ReferenceID = KindTradeSettlement, "", "fill-9"
		}, "LEDGER_REFERENCE_REQUIRED", "referenceType"},
		{"settlement without reference id", func(e *Entry) {
			e.Kind, e.ReferenceType, e.ReferenceID = KindTradeSettlement, "fill", ""
		}, "LEDGER_REFERENCE_REQUIRED", "referenceID"},
		{"funding without reference", func(e *Entry) {
			e.Kind, e.ReferenceType, e.ReferenceID = KindFunding, "", ""
		}, "LEDGER_REFERENCE_REQUIRED", "referenceType"},
		{"fee without reference", func(e *Entry) {
			e.Kind, e.ReferenceType, e.ReferenceID = KindFee, "", ""
		}, "LEDGER_REFERENCE_REQUIRED", "referenceType"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := validEntry()
			tc.mut(&e)
			_, err := NewEntry(e)
			if err == nil {
				t.Fatal("NewEntry must refuse")
			}
			wantRefusal(t, err, tc.code, tc.field)
		})
	}
}

func TestNewEntryAcceptsAndCanonicalizes(t *testing.T) {
	e := validEntry()
	e.Kind, e.ReferenceType, e.ReferenceID = KindFee, "fill", "fill-7"
	e.Amount = "-00010.500"
	got, err := NewEntry(e)
	if err != nil {
		t.Fatalf("NewEntry: %v", err)
	}
	if got.Amount != "-10.5" {
		t.Fatalf("Amount = %q, want %q", got.Amount, "-10.5")
	}
	// A Kind that is not reference-bound keeps references absent on purpose.
	deposit, err := NewEntry(validEntry())
	if err != nil {
		t.Fatalf("NewEntry: %v", err)
	}
	if deposit.ReferenceType != "" || deposit.ReferenceID != "" {
		t.Fatalf("deposit must not invent references: %+v", deposit)
	}
}

func TestIdempotencyKeyStableAndCollisionProof(t *testing.T) {
	base := validEntry()
	k := IdempotencyKey(base)
	if k != IdempotencyKey(base) {
		t.Fatal("key must be stable for identical tuples")
	}
	// Amount and CreatedAt are not part of the identity: a replayed event
	// delivered at another time still keys identically.
	replay := base
	replay.Amount, replay.CreatedAt, replay.ID = "999", base.CreatedAt+5, "e-2"
	if IdempotencyKey(replay) != k {
		t.Fatal("amount/createdAt/id must not change the key")
	}
	mutations := map[string]func(*Entry){
		"accountID":     func(e *Entry) { e.AccountID = "acct-2" },
		"kind":          func(e *Entry) { e.Kind = KindWithdrawal },
		"referenceType": func(e *Entry) { e.ReferenceType = "fill" },
		"referenceID":   func(e *Entry) { e.ReferenceID = "fill-2" },
		"occurredAt":    func(e *Entry) { e.OccurredAtMs++ },
	}
	for name, mut := range mutations {
		other := base
		mut(&other)
		if IdempotencyKey(other) == k {
			t.Fatalf("%s must change the key", name)
		}
	}
	// Separator collision: ("a:b", "") and ("a", "b:") are distinct tuples and
	// must not share a key under length-prefixing.
	a := Entry{AccountID: "a:b", Kind: "", ReferenceType: "", ReferenceID: "", OccurredAtMs: 0}
	b := Entry{AccountID: "a", Kind: "b:", ReferenceType: "", ReferenceID: "", OccurredAtMs: 0}
	if IdempotencyKey(a) == IdempotencyKey(b) {
		t.Fatal("distinct tuples collided")
	}
}

func TestIngestAppendsOnceWithoutMutation(t *testing.T) {
	base := validEntry()
	entries := []Entry{}
	first, err := Ingest(entries, base)
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if len(first) != 1 || len(entries) != 0 {
		t.Fatalf("Ingest must return a fresh slice: input len %d, output len %d", len(entries), len(first))
	}
	replay := base
	replay.ID = "e-2" // same origin tuple: a duplicate, not a new fact
	_, err = Ingest(first, replay)
	var canonical *errs.Error
	if !errors.As(err, &canonical) || canonical.Code != "LEDGER_DUPLICATE" {
		t.Fatalf("replay must be refused with LEDGER_DUPLICATE, got %v", err)
	}
	if canonical.Category != errs.CategoryConflict {
		t.Fatalf("duplicate category = %q, want conflict", canonical.Category)
	}
	if len(first) != 1 {
		t.Fatal("failed ingest must not touch the existing record")
	}
	distinct := base
	distinct.ReferenceID = "fill-2"
	distinct.Kind, distinct.ReferenceType = KindFee, "fill"
	third, err := Ingest(first, distinct)
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if len(third) != 2 {
		t.Fatalf("distinct origins must both be recorded, got %d entries", len(third))
	}
	if _, err := Ingest(first, Entry{}); err == nil {
		t.Fatal("Ingest must run NewEntry validation")
	}
}

func TestBalanceByAssetExactAndAbsentNotZero(t *testing.T) {
	mk := func(id, asset, amount string) Entry {
		e := validEntry()
		e.ID, e.Asset, e.Amount = id, asset, amount
		return e
	}
	balances, err := BalanceByAsset([]Entry{
		mk("a", "USDT", "0.1"),
		mk("b", "USDT", "0.2"),
		mk("c", "USDT", "-0.05"),
		mk("d", "SOL", "5"),
		mk("e", "SOL", "-5"),
	})
	if err != nil {
		t.Fatalf("BalanceByAsset: %v", err)
	}
	if got := balances["USDT"]; got != "0.25" {
		t.Fatalf("USDT = %q, want %q (float64 would say 0.30000000000000004-ish)", got, "0.25")
	}
	if got := balances["SOL"]; got != "0" {
		t.Fatalf("SOL = %q, want exact zero sum %q", got, "0")
	}
	if _, present := balances["BTC"]; present {
		t.Fatal("an asset with no entries must be ABSENT, never a fabricated 0")
	}
	if len(balances) != 2 {
		t.Fatalf("balances = %v, want exactly the two recorded assets", balances)
	}
}

func TestBalanceByAssetRejectsUnparsableAmount(t *testing.T) {
	e := validEntry()
	e.Amount = "1.21 gigawatts"
	_, err := BalanceByAsset([]Entry{e})
	wantRefusal(t, err, "LEDGER_AMOUNT_INVALID", "amount")
}

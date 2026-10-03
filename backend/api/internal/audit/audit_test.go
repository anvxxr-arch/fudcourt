package audit

import (
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
)

func validRecord() Record {
	return Record{
		ID:           "rec-1",
		ActorID:      "u1",
		Action:       ActionExecutionCreated,
		ResourceType: "execution",
		ResourceID:   "e1",
		RequestID:    "req-1",
		ExecutionID:  "e1",
		Origin:       "api",
		Result:       "created",
		OccurredAtMs: 1_700_000_000_000,
	}
}

func TestNewRecordRequiredFields(t *testing.T) {
	cases := []struct {
		name  string
		mut   func(*Record)
		field string
	}{
		{"empty ID", func(r *Record) { r.ID = "" }, "ID"},
		{"empty ActorID", func(r *Record) { r.ActorID = "" }, "ActorID"},
		{"empty Action", func(r *Record) { r.Action = "" }, "Action"},
		{"empty Result", func(r *Record) { r.Result = "" }, "Result"},
		{"zero OccurredAtMs", func(r *Record) { r.OccurredAtMs = 0 }, "OccurredAtMs"},
		{"negative OccurredAtMs", func(r *Record) { r.OccurredAtMs = -1 }, "OccurredAtMs"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := validRecord()
			c.mut(&rec)
			_, err := NewRecord(rec)
			var e *errs.Error
			if !errors.As(err, &e) {
				t.Fatalf("NewRecord() = %v, want errs.Error", err)
			}
			if e.Code != CodeRecordInvalid || e.Category != errs.CategoryValidation {
				t.Fatalf("NewRecord() = %s/%s, want validation/%s", e.Category, e.Code, CodeRecordInvalid)
			}
			if !strings.Contains(e.Message, c.field) {
				t.Errorf("refusal must name field %s: %q", c.field, e.Message)
			}
		})
	}
}

func TestNewRecordMetadataMustBePersistable(t *testing.T) {
	rec := validRecord()
	rec.Metadata = map[string]any{"bad": math.Inf(1)} // JSON cannot encode Inf.
	_, err := NewRecord(rec)
	var e *errs.Error
	if !errors.As(err, &e) {
		t.Fatalf("NewRecord() = %v, want errs.Error", err)
	}
	if e.Code != CodeMetadataInvalid {
		t.Errorf("NewRecord() = %s, want %s", e.Code, CodeMetadataInvalid)
	}
}

func TestNewRecordCopiesMetadata(t *testing.T) {
	rec := validRecord()
	rec.Metadata = map[string]any{
		"note":   "original",
		"nested": map[string]any{"k": "original"},
		"list":   []any{map[string]any{"k": "original"}},
	}
	got, err := NewRecord(rec)
	if err != nil {
		t.Fatalf("NewRecord() = %v, want nil", err)
	}
	// Mutate the caller's copy every way it can; the record must not move.
	rec.Metadata["note"] = "mutated"
	rec.Metadata["nested"].(map[string]any)["k"] = "mutated"
	rec.Metadata["list"].([]any)[0].(map[string]any)["k"] = "mutated"

	if got.Metadata["note"] != "original" {
		t.Errorf("top-level metadata aliasing: %v", got.Metadata["note"])
	}
	if got.Metadata["nested"].(map[string]any)["k"] != "original" {
		t.Error("nested map metadata must be copied, not aliased")
	}
	if got.Metadata["list"].([]any)[0].(map[string]any)["k"] != "original" {
		t.Error("metadata inside slices must be copied, not aliased")
	}
}

func TestRedactRecursive(t *testing.T) {
	in := map[string]any{
		"order_id":        "o-1",
		"API_KEY":         "sk_live_abc",
		"myPassword":      "hunter2",
		"X-Authorization": "Bearer x",
		"Set-Cookie":      "session=1",
		"nested": map[string]any{
			"note":        "visible",
			"api_secret":  "s3cr3t",
			"privateKey":  "k",
			"pass_phrase": "p",
		},
		"list": []any{
			map[string]any{"token": "t", "qty": 4},
			"raw-string-stays",
		},
	}
	got := Redact(in)

	want := map[string]any{
		"order_id":        "o-1",
		"API_KEY":         "[REDACTED]",
		"myPassword":      "[REDACTED]",
		"X-Authorization": "[REDACTED]",
		"Set-Cookie":      "[REDACTED]",
		"nested": map[string]any{
			"note":       "visible",
			"api_secret": "[REDACTED]",
			// Not literal fragment hits: "privateKey" contains neither
			// "private_key" nor "pass_phrase" contains "passphrase", so per
			// the exact-list contract their values stay untouched.
			"privateKey":  "k",
			"pass_phrase": "p",
		},
		"list": []any{
			map[string]any{"token": "[REDACTED]", "qty": 4},
			"raw-string-stays",
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Redact() = %#v, want %#v", got, want)
	}
	// The input must survive untouched: redaction copies.
	if in["API_KEY"] != "sk_live_abc" || in["nested"].(map[string]any)["api_secret"] != "s3cr3t" {
		t.Error("Redact must not mutate its input")
	}
	if got := Redact(nil); got != nil {
		t.Errorf("Redact(nil) = %v, want nil", got)
	}
}

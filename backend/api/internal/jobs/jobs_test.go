package jobs

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
)

func TestParseInterval(t *testing.T) {
	cases := []struct {
		in   string
		want time.Duration
		bad  bool
	}{
		{in: "every 1s", want: time.Second},
		{in: "every 30s", want: 30 * time.Second},
		{in: "every 5m", want: 5 * time.Minute},
		{in: "every 2h", want: 2 * time.Hour},
		{in: "every 12h", want: 12 * time.Hour},
		{in: "", bad: true},
		{in: "every ", bad: true},
		{in: "every 5", bad: true},     // no unit.
		{in: "every 5d", bad: true},    // unsupported unit.
		{in: "every 0m", bad: true},    // non-positive.
		{in: "every -5m", bad: true},   // negative, signed.
		{in: "every +5m", bad: true},   // signed.
		{in: "every 5.5m", bad: true},  // not a whole number.
		{in: "every abc m", bad: true}, // garbage count.
		{in: "5m", bad: true},          // missing grammar prefix.
		{in: "every5m", bad: true},     // missing separating space.
		{in: "EVERY 5m", bad: true},    // wrong case is not the grammar.
	}
	for _, c := range cases {
		got, err := ParseInterval(c.in)
		if c.bad {
			var e *errs.Error
			if !errors.As(err, &e) {
				t.Errorf("ParseInterval(%q) = %v, want errs.Error", c.in, err)
				continue
			}
			if e.Code != CodeSpecInvalid {
				t.Errorf("ParseInterval(%q) = %s, want %s", c.in, e.Code, CodeSpecInvalid)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParseInterval(%q) = %v, want nil", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("ParseInterval(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestValidateRefusals(t *testing.T) {
	cases := []struct {
		name  string
		spec  Spec
		field string
	}{
		{"empty name", Spec{Name: "", Schedule: "every 5m", MaxAttempts: 1}, "Name"},
		{"unparsable schedule", Spec{Name: "j", Schedule: "hourly", MaxAttempts: 1}, "Schedule"},
		{"non-positive interval", Spec{Name: "j", Schedule: "every 0m", MaxAttempts: 1}, "Schedule"},
		{"zero MaxAttempts", Spec{Name: "j", Schedule: "every 5m", MaxAttempts: 0}, "MaxAttempts"},
		{"negative MaxAttempts", Spec{Name: "j", Schedule: "every 5m", MaxAttempts: -3}, "MaxAttempts"},
		{"negative backoff", Spec{Name: "j", Schedule: "every 5m", MaxAttempts: 1, Backoff: -time.Second}, "Backoff"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := Validate(c.spec)
			var e *errs.Error
			if !errors.As(err, &e) {
				t.Fatalf("Validate() = %v, want errs.Error", err)
			}
			if e.Code != CodeSpecInvalid || e.Category != errs.CategoryValidation {
				t.Fatalf("Validate() = %s/%s, want validation/%s", e.Category, e.Code, CodeSpecInvalid)
			}
			if !strings.Contains(e.Message, c.field) {
				t.Errorf("refusal must name field %s: %q", c.field, e.Message)
			}
		})
	}
	// The well-formed spec is accepted unchanged.
	ok := Spec{Name: "rebalance", Schedule: "every 5m", Timeout: 30 * time.Second, MaxAttempts: 3, Backoff: time.Second}
	if err := Validate(ok); err != nil {
		t.Errorf("Validate(ok) = %v, want nil", err)
	}
}

func TestNextRun(t *testing.T) {
	base := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		schedule string
		want     time.Time
	}{
		{"every 30s", base.Add(30 * time.Second)},
		{"every 5m", base.Add(5 * time.Minute)},
		{"every 2h", base.Add(2 * time.Hour)},
	}
	for _, c := range cases {
		got, err := NextRun(Spec{Name: "j", Schedule: c.schedule, MaxAttempts: 1}, base)
		if err != nil {
			t.Fatalf("NextRun(%q) = %v, want nil", c.schedule, err)
		}
		if !got.Equal(c.want) {
			t.Errorf("NextRun(%q) = %v, want %v", c.schedule, got, c.want)
		}
	}
	// A spec whose schedule cannot parse is refused, never defaulted.
	if _, err := NextRun(Spec{Name: "j", Schedule: "whenever", MaxAttempts: 1}, base); err == nil {
		t.Error("NextRun with unparsable schedule must refuse")
	}
}

func TestRegistry(t *testing.T) {
	r := NewRegistry()
	spec := Spec{Name: "rebalance", Schedule: "every 5m", MaxAttempts: 3, Backoff: time.Second}
	if err := r.Add(spec); err != nil {
		t.Fatalf("Add() = %v, want nil", err)
	}
	// Duplicate names conflict with JOB_DUPLICATE and never overwrite.
	dup := spec
	dup.MaxAttempts = 9
	err := r.Add(dup)
	var e *errs.Error
	if !errors.As(err, &e) || e.Code != CodeDuplicate || e.Category != errs.CategoryConflict {
		t.Fatalf("Add(dup) = %v, want conflict/%s", err, CodeDuplicate)
	}
	got, ok := r.Get("rebalance")
	if !ok || got.MaxAttempts != 3 {
		t.Fatalf("Get() = %+v %v, want the first spec kept", got, ok)
	}
	if _, ok := r.Get("missing"); ok {
		t.Error("Get(missing) must report not found")
	}
	// An invalid spec never lands in the registry.
	if err := r.Add(Spec{Name: "bad", Schedule: "nope", MaxAttempts: 1}); err == nil {
		t.Error("Add(invalid) must refuse")
	}
	if _, ok := r.Get("bad"); ok {
		t.Error("invalid spec must not be registered")
	}
}

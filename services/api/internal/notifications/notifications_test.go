package notifications

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
)

func validRequest() Request {
	return Request{
		ID: "req-1", Event: "RiskLimitHit", Severity: SeverityWarning,
		UserID: "user-1", Title: "Risk limit hit", Body: "open risk is at the ceiling", OccurredAt: 1700000000000,
	}
}

func wantInvalid(t *testing.T, err error, namesField string) {
	t.Helper()
	var canonical *errs.Error
	if !errors.As(err, &canonical) {
		t.Fatalf("error %v is not a canonical errs.Error", err)
	}
	if canonical.Code != "NOTIF_REQUEST_INVALID" || canonical.Category != errs.CategoryValidation {
		t.Fatalf("got %s/%s, want NOTIF_REQUEST_INVALID/validation (message %q)", canonical.Category, canonical.Code, canonical.Message)
	}
	if !strings.Contains(canonical.Message, namesField) {
		t.Fatalf("message %q does not name %q", canonical.Message, namesField)
	}
}

func TestValidateRequiresContent(t *testing.T) {
	if err := Validate(validRequest()); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	cases := []struct {
		name  string
		mut   func(*Request)
		field string
	}{
		{"missing event", func(r *Request) { r.Event = "" }, "event"},
		{"missing title", func(r *Request) { r.Title = "" }, "title"},
		{"missing body", func(r *Request) { r.Body = "" }, "body"},
		{"unknown severity", func(r *Request) { r.Severity = "meh" }, "severity"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := validRequest()
			tc.mut(&r)
			err := Validate(r)
			if err == nil {
				t.Fatal("Validate must refuse")
			}
			wantInvalid(t, err, tc.field)
		})
	}
}

func TestRouteDeterministicAndFailClosed(t *testing.T) {
	prefs := Preferences{
		Channels: map[Channel]bool{
			ChannelDiscord:  true,
			ChannelTelegram: true,
			ChannelEmail:    false,
			ChannelInApp:    true,
		},
		MinSeverity: SeverityWarning,
	}
	req := validRequest() // warning
	got := Route(prefs, req)
	want := []Channel{ChannelDiscord, ChannelTelegram, ChannelInApp} // fixed order, not map order
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Route = %v, want %v", got, want)
	}

	// Severity below the threshold routes nothing — including to channels the
	// user enabled.
	info := validRequest()
	info.Severity = SeverityInfo
	if got := Route(prefs, info); len(got) != 0 {
		t.Fatalf("below-threshold request routed to %v, want none", got)
	}

	// Empty preferences: never a default blast — and an empty (non-nil) slice,
	// so callers can distinguish "routed nothing" from "not asked".
	got = Route(Preferences{}, req)
	if got == nil || len(got) != 0 {
		t.Fatalf("empty preferences must yield an empty slice, got %v", got)
	}

	// An unvalidated severity fails closed: nothing routes.
	broken := validRequest()
	broken.Severity = "meh"
	if got := Route(prefs, broken); len(got) != 0 {
		t.Fatalf("unknown severity routed to %v, want none (fail closed)", got)
	}
}

func TestPlanCoversEveryChannelWithReason(t *testing.T) {
	prefs := Preferences{
		Channels:    map[Channel]bool{ChannelDiscord: true, ChannelEmail: true},
		MinSeverity: SeverityCritical,
	}
	req := validRequest() // warning
	got := Plan(prefs, req)
	want := []PlannedDelivery{
		{Channel: ChannelDiscord, Status: StatusSkipped, Reason: ReasonSeverity},
		{Channel: ChannelTelegram, Status: StatusSkipped, Reason: ReasonDisabled},
		{Channel: ChannelEmail, Status: StatusSkipped, Reason: ReasonSeverity},
		{Channel: ChannelWebPush, Status: StatusSkipped, Reason: ReasonDisabled},
		{Channel: ChannelInApp, Status: StatusSkipped, Reason: ReasonDisabled},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Plan = %+v, want %+v", got, want)
	}

	// A request that clears the threshold plans the enabled channels and
	// carries no reason on them.
	critical := validRequest()
	critical.Severity = SeverityCritical
	got = Plan(prefs, critical)
	want = []PlannedDelivery{
		{Channel: ChannelDiscord, Status: StatusPlanned},
		{Channel: ChannelTelegram, Status: StatusSkipped, Reason: ReasonDisabled},
		{Channel: ChannelEmail, Status: StatusPlanned},
		{Channel: ChannelWebPush, Status: StatusSkipped, Reason: ReasonDisabled},
		{Channel: ChannelInApp, Status: StatusSkipped, Reason: ReasonDisabled},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Plan = %+v, want %+v", got, want)
	}

	// Every channel appears exactly once, in fixed order.
	if len(got) != len(channelsInOrder) {
		t.Fatalf("plan covers %d channels, want %d", len(got), len(channelsInOrder))
	}
}

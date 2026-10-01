// Package notifications decides WHO hears about an event and HOW — the
// delivery-routing domain (objective §8.22).
//
// The boundary this package exists to hold: only this domain knows channel
// transport semantics. The executor emits a Request and never learns that
// Discord has webhooks or Telegram has chat IDs; if a new channel appears, or
// Discord's API changes, this is the only package that changes. Routing is a
// pure, deterministic function of preferences and the request — no wall clock,
// no network, no defaults: an empty preference set sends NOTHING, because a
// channel the user never enabled must never become a default blast.
package notifications

import (
	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
)

// invalid builds the one refusal shape of this domain: a validated request is
// the only input the routers accept, so every refusal is NOTIF_REQUEST_INVALID
// naming the offending field.
func invalid(message string) error {
	return errs.New(errs.CategoryValidation, "NOTIF_REQUEST_INVALID", message)
}

// Channel is one delivery transport. The set is closed: a request cannot name
// a channel this domain has not modelled.
type Channel string

const (
	ChannelDiscord  Channel = "discord"  // Discord webhook transport
	ChannelTelegram Channel = "telegram" // Telegram bot transport
	ChannelEmail    Channel = "email"    // SMTP transport
	ChannelWebPush  Channel = "web_push" // browser push transport
	ChannelInApp    Channel = "in_app"   // in-app notification feed
)

// channelsInOrder is the fixed routing order — the deterministic output order
// of Route and Plan regardless of map iteration.
var channelsInOrder = []Channel{
	ChannelDiscord,
	ChannelTelegram,
	ChannelEmail,
	ChannelWebPush,
	ChannelInApp,
}

// Severity classifies how urgent an event is. The set is closed and totally
// ordered: info < warning < critical.
type Severity string

const (
	SeverityInfo     Severity = "info"     // routine event
	SeverityWarning  Severity = "warning"  // needs attention
	SeverityCritical Severity = "critical" // acts now
)

// rank orders severities. An unrecognized severity ranks below everything (−1)
// so an unvalidated request routes to NOBODY — failing closed can never cause
// the blast the defaulting rule forbids.
func (s Severity) rank() int {
	switch s {
	case SeverityInfo:
		return 0
	case SeverityWarning:
		return 1
	case SeverityCritical:
		return 2
	default:
		return -1
	}
}

// Preferences is one user's delivery settings.
//
// Invariants: Channels maps channel → explicitly enabled; a channel ABSENT
// from the map is disabled (absence is not consent). MinSeverity is the least
// urgent severity that routes; its zero value behaves as info — blast
// prevention comes from the explicit channel map, not from a hidden threshold.
type Preferences struct {
	Channels    map[Channel]bool
	MinSeverity Severity
}

// Request is one notification to be delivered.
//
// Invariants (enforced by Validate): Event, Title and Body are non-empty — a
// notification without them cannot be shown or traced; Severity is from the
// closed set. UserID is the recipient (empty for system-wide in-app rows).
// OccurredAt is Unix milliseconds of when the event happened — delivery
// records reference it, not the delivery time.
type Request struct {
	ID         string
	Event      string
	Severity   Severity
	UserID     string
	Title      string
	Body       string
	OccurredAt int64
}

// Delivery is one attempted delivery of a request on one channel — the
// transport layer's report back to the domain.
//
// Invariants: RequestID and Channel name what was attempted; AttemptedAt is
// Unix milliseconds; Outcome is delivered, failed or skipped (closed set).
// Error is the failure reason and is empty unless Outcome is failed — an
// outcome and its explanation never disagree.
type Delivery struct {
	RequestID   string
	Channel     Channel
	AttemptedAt int64
	Outcome     Outcome
	Error       string
}

// Outcome is the result of one delivery attempt: the channel delivered it, the
// channel failed, or the domain skipped it (disabled or below severity).
type Outcome string

const (
	OutcomeDelivered Outcome = "delivered" // the channel accepted the delivery
	OutcomeFailed    Outcome = "failed"    // the channel rejected or errored
	OutcomeSkipped   Outcome = "skipped"   // the domain decided not to send
)

// PlanStatus is the planned fate of one channel before any transport runs.
type PlanStatus string

const (
	StatusPlanned PlanStatus = "planned" // the channel will deliver
	StatusSkipped PlanStatus = "skipped" // the channel will not deliver (see Reason)
)

// SkipReason states WHY a channel is skipped — the two exhaustive causes.
type SkipReason string

const (
	ReasonDisabled SkipReason = "SKIPPED_DISABLED" // nobody enabled this channel
	ReasonSeverity SkipReason = "SKIPPED_SEVERITY" // request below the preference threshold
)

// PlannedDelivery is one channel's fate in a delivery plan.
//
// Invariants: every known channel appears exactly once per plan; a skipped
// channel carries its Reason (SKIPPED_DISABLED or SKIPPED_SEVERITY); a planned
// channel carries an empty Reason — there is no third state to invent.
type PlannedDelivery struct {
	Channel Channel
	Status  PlanStatus
	Reason  SkipReason
}

// Validate enforces Request's invariants with errs.CategoryValidation (code
// NOTIF_REQUEST_INVALID, message naming the field): Event, Title and Body are
// required, and Severity must be from the closed set — routing a request with
// an unknown severity would mean guessing an urgency the event never stated.
func Validate(req Request) error {
	if req.Event == "" {
		return invalid("event is required")
	}
	if req.Title == "" {
		return invalid("title is required")
	}
	if req.Body == "" {
		return invalid("body is required")
	}
	switch req.Severity {
	case SeverityInfo, SeverityWarning, SeverityCritical:
		return nil
	default:
		return invalid("severity is not info, warning or critical")
	}
}

// Route returns the channels this request must be delivered on: enabled in
// preferences AND the request's severity at or above MinSeverity, in the fixed
// channel order. The result is deterministic for identical input. Empty
// preferences (or a request whose severity is unknown) route NOTHING — a
// channel nobody enabled is never a default blast.
func Route(prefs Preferences, req Request) []Channel {
	out := make([]Channel, 0, len(channelsInOrder))
	for _, ch := range channelsInOrder {
		if prefs.Channels[ch] && req.Severity.rank() >= prefs.MinSeverity.rank() {
			out = append(out, ch)
		}
	}
	return out
}

// Plan returns the full delivery plan: one PlannedDelivery per known channel
// in fixed order, each saying whether it will run and — when it will not —
// exactly why (SKIPPED_DISABLED for a channel nobody enabled, SKIPPED_SEVERITY
// for one the request is not urgent enough for). Planning every channel,
// including the skipped ones, is what makes a delivery row auditable after the
// fact: the domain decided, and the decision is recorded before any transport
// runs. Same fail-closed rule as Route.
func Plan(prefs Preferences, req Request) []PlannedDelivery {
	out := make([]PlannedDelivery, 0, len(channelsInOrder))
	for _, ch := range channelsInOrder {
		switch {
		case !prefs.Channels[ch]:
			out = append(out, PlannedDelivery{Channel: ch, Status: StatusSkipped, Reason: ReasonDisabled})
		case req.Severity.rank() < prefs.MinSeverity.rank():
			out = append(out, PlannedDelivery{Channel: ch, Status: StatusSkipped, Reason: ReasonSeverity})
		default:
			out = append(out, PlannedDelivery{Channel: ch, Status: StatusPlanned})
		}
	}
	return out
}

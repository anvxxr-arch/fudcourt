package notify

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/execution"
)

// notifiable maps the events worth waking someone for to the glyph that leads
// their message. The language is the executor's, not a new vocabulary: every
// key is a canonical ExecutionEventName from internal/execution/enums.go,
// and policy_test.go asserts that (the immutable event list is the contract —
// this map may only ever be a SUBSET of it).
//
// Rows 1–5 are PRD §120's own list, mapped onto the vocabulary:
//
//	§120 "execution started"   -> EXECUTION_STARTED
//	§120 "execution completed" -> EXECUTION_COMPLETED
//	§120 "execution paused"    -> EXECUTION_PAUSED
//	§120 "execution failed"    -> EXECUTION_FAILED
//	§120 "risk limit reached"  -> EXECUTION_RISK_STOPPED
//
// Rows 6–8 extend that list with three events that are equally worth knowing
// about; they are marked so, never presented as §120 itself.
var notifiable = map[execution.ExecutionEventName]string{
	execution.EventExecutionStarted:     "▶️",
	execution.EventExecutionCompleted:   "✅",
	execution.EventExecutionPaused:      "⏸️",
	execution.EventExecutionFailed:      "❌",
	execution.EventExecutionRiskStopped: "🛑",
	// --- beyond PRD §120's list, same family -----------------------------
	execution.EventExecutionCancelled:     "🚫",
	execution.EventOrderRejected:          "⚠️",
	execution.EventReconciliationMismatch: "🧩",
}

// Gaps lists the PRD §120 events that have NO counterpart in the 23-value
// ExecutionEventName vocabulary, and therefore cannot be notified on without
// inventing an event. They are recorded here because a silent shortfall reads
// as a covered one.
//
// Closing a gap means a contract change to the append-only event vocabulary
// (contracts/events/catalog.json is drift-gated), not a change here.
var Gaps = []string{
	"credential invalid — no execution event; credential health is not an event (PRD §120)",
	"exchange disconnected — no execution event; adapter connectivity is not an event (PRD §120)",
	"SL triggered — no stop-loss event; a risk stop surfaces as EXECUTION_RISK_STOPPED (PRD §120)",
	"TP filled — no take-profit event; a fill surfaces as ORDER_FILLED (PRD §120)",
}

// Notifiable reports whether an event is worth an outbound message.
func Notifiable(name execution.ExecutionEventName) bool {
	_, ok := notifiable[name]
	return ok
}

// NotifiableEvents lists the notifiable events in vocabulary order (not map
// order), so logging or asserting the channel's coverage is deterministic.
func NotifiableEvents() []execution.ExecutionEventName {
	out := make([]execution.ExecutionEventName, 0, len(notifiable))
	for _, name := range execution.ExecutionEventNames {
		if _, ok := notifiable[name]; ok {
			out = append(out, name)
		}
	}
	return out
}

// Format renders one event as the message that crosses the wire. The second
// return value is false for a non-notifiable event, so a caller can drop it
// without a second lookup.
//
// The body is drawn only from fields the event record actually carries — the
// execution id, the event name, the payload the emitter wrote, and the event
// time. Nothing is inferred, defaulted or invented; an absent payload field is
// simply absent from the message.
func Format(ev execution.ExecutionEventRecord) (string, bool) {
	glyph, ok := notifiable[ev.Name]
	if !ok {
		return "", false
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s FUDCourt · %s\n", glyph, ev.Name)
	if ev.ExecutionID != "" {
		fmt.Fprintf(&b, "execution %s\n", ev.ExecutionID)
	}
	if payload := formatPayload(ev.Payload); payload != "" {
		b.WriteString(payload)
		b.WriteString("\n")
	}
	if ev.CreatedAt > 0 {
		fmt.Fprintf(&b, "at %s", time.UnixMilli(ev.CreatedAt).UTC().Format(time.RFC3339))
	}
	return strings.TrimRight(b.String(), "\n"), true
}

// formatPayload renders the event payload as a stable, sorted `key=value` list.
// Keys are sorted so two identical events always produce identical text (which
// makes the channel's own history greppable and the formatter testable).
func formatPayload(payload map[string]any) string {
	if len(payload) == 0 {
		return ""
	}
	keys := make([]string, 0, len(payload))
	for k := range payload {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		v := payload[k]
		if v == nil {
			continue // an absent figure is absent, never "null"
		}
		rendered := strings.TrimSpace(fmt.Sprintf("%v", v))
		if rendered == "" {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s=%s", k, rendered))
	}
	return strings.Join(parts, "\n")
}

// SendEvent delivers one event and reports whether it was notifiable. A
// non-notifiable event is a no-op with a nil error: the caller observes every
// append, and only the interesting ones cost a round trip.
func (t *Telegram) SendEvent(ctx context.Context, ev execution.ExecutionEventRecord) (bool, error) {
	text, ok := Format(ev)
	if !ok {
		return false, nil
	}
	if _, err := t.Send(ctx, text); err != nil {
		return true, err
	}
	return true, nil
}

package execution

import (
	"errors"
	"testing"

	"github.com/anvxxr-arch/fudcourt/services/executor/internal/executor"
)

// commandFor maps a target status back to the command that produces it (only
// statuses some command targets need a case here).
func commandFor(target executor.ExecutionStatus) (Command, bool) {
	switch target {
	case executor.StatusRunning:
		return CommandStart, true // start and resume both target RUNNING
	case executor.StatusPaused:
		return CommandPause, true
	case executor.StatusCancelRequested:
		return CommandCancel, true
	case executor.StatusFilled:
		return CommandComplete, true
	case executor.StatusFailed:
		return CommandFail, true
	}
	return "", false
}

// TestApplyLegalTransitions covers EVERY legal transition in
// executor.ExecutionTransitions — each legal edge is reachable by one of the
// commands (objective §8.10).
func TestApplyLegalTransitions(t *testing.T) {
	for from, targets := range executor.ExecutionTransitions {
		for _, to := range targets {
			cmd, ok := commandFor(to)
			if !ok {
				// A legal edge no command targets (e.g. →RECONCILING) is exercised
				// through Transition instead.
				rec := New(executor.ExecutionRecord{Status: from}).Record()
				agg := New(rec)
				updated, transitioned, err := agg.Transition(to, 1000)
				if err != nil || !transitioned || updated.Status != to {
					t.Fatalf("Transition(%s -> %s) = (%s, %v, %v), want legal", from, to, updated.Status, transitioned, err)
				}
				continue
			}
			t.Run(string(from)+"->"+string(to), func(t *testing.T) {
				agg := New(executor.ExecutionRecord{Status: from})
				updated, transitioned, err := agg.Apply(cmd, 1000)
				if err != nil {
					t.Fatalf("Apply(%s) from %s: %v", cmd, from, err)
				}
				if !transitioned || updated.Status != to {
					t.Fatalf("Apply(%s) from %s -> %s, transitioned=%v", cmd, from, updated.Status, transitioned)
				}
			})
		}
	}
}

// TestApplyIllegalTransitions refuses every non-edge state change with an error
// naming BOTH states (the caller maps it to 409). Terminal states accept
// nothing.
func TestApplyIllegalTransitions(t *testing.T) {
	// Every command against every status not equal to its target and not a legal
	// edge: refused. Table-driven over the whole matrix.
	commands := []Command{CommandStart, CommandPause, CommandResume, CommandCancel, CommandComplete, CommandFail}
	all := []executor.ExecutionStatus{
		executor.StatusDraft, executor.StatusCalculated, executor.StatusValidated, executor.StatusReady,
		executor.StatusRunning, executor.StatusPartiallyFilled, executor.StatusFilled, executor.StatusPaused,
		executor.StatusCancelRequested, executor.StatusCancelled, executor.StatusFailed,
		executor.StatusRiskStopped, executor.StatusExpired, executor.StatusReconciling, executor.StatusStopped,
	}
	for _, from := range all {
		for _, cmd := range commands {
			target, _ := commandTarget[cmd]
			if from == target {
				continue // idempotent case, covered separately
			}
			if executor.CanTransition(from, target) {
				continue // legal, covered by TestApplyLegalTransitions
			}
			t.Run(string(from)+"/"+string(cmd), func(t *testing.T) {
				agg := New(executor.ExecutionRecord{Status: from})
				rec, transitioned, err := agg.Apply(cmd, 1000)
				if err == nil {
					t.Fatalf("Apply(%s) from %s must be refused", cmd, from)
				}
				if transitioned {
					t.Fatal("refused transition must not report transitioned")
				}
				if rec.Status != from {
					t.Fatalf("refused transition must not move state: %s", rec.Status)
				}
				var te *TransitionError
				if !errors.As(err, &te) {
					t.Fatalf("error must be *TransitionError, got %T", err)
				}
				if te.From != from || te.To != target {
					t.Fatalf("error must name both states: %s -> %s", te.From, te.To)
				}
			})
		}
	}
	// Terminal states accept nothing — spelled out beyond the matrix.
	for _, from := range []executor.ExecutionStatus{
		executor.StatusFilled, executor.StatusCancelled, executor.StatusFailed,
		executor.StatusRiskStopped, executor.StatusExpired, executor.StatusStopped,
	} {
		for _, cmd := range commands {
			agg := New(executor.ExecutionRecord{Status: from})
			// Idempotent repeats of the command that produced this state are no-ops;
			// everything else is refused.
			target, _ := commandTarget[cmd]
			_, transitioned, err := agg.Apply(cmd, 1000)
			if target == from {
				if err != nil || transitioned {
					t.Fatalf("terminal %s + %s must be an idempotent no-op", from, cmd)
				}
				continue
			}
			if err == nil {
				t.Fatalf("terminal %s must accept nothing (%s)", from, cmd)
			}
		}
	}
}

// TestApplyIdempotentRepeat pins objective §23: a repeated command at its
// target is a no-op (transitioned=false, err=nil) and MUST NOT re-drive —
// in particular a repeated Start never re-stamps or re-enters RUNNING.
func TestApplyIdempotentRepeat(t *testing.T) {
	for _, tc := range []struct {
		cmd    Command
		status executor.ExecutionStatus
	}{
		{CommandStart, executor.StatusRunning},
		{CommandPause, executor.StatusPaused},
		{CommandResume, executor.StatusRunning},
		{CommandCancel, executor.StatusCancelRequested},
		{CommandComplete, executor.StatusFilled},
		{CommandFail, executor.StatusFailed},
	} {
		t.Run(string(tc.cmd), func(t *testing.T) {
			agg := New(executor.ExecutionRecord{Status: tc.status, StartedAt: 5000})
			rec, transitioned, err := agg.Apply(tc.cmd, 1000)
			if err != nil || transitioned {
				t.Fatalf("repeat %s at target: transitioned=%v err=%v, want false/nil", tc.cmd, transitioned, err)
			}
			if rec.StartedAt != 5000 {
				t.Fatalf("repeat must not rewind timestamps: StartedAt=%d", rec.StartedAt)
			}
			if agg.UpdatedAt() != 0 {
				t.Fatal("a no-op must not advance the change clock")
			}
		})
	}
}

// TestStampMonotonic: accepted changes stamp StartedAt/CompletedAt/CancelledAt
// and the UpdatedAt clock monotonically — a backwards clock can never rewind
// history (objective §8.10).
func TestStampMonotonic(t *testing.T) {
	agg := New(executor.ExecutionRecord{Status: executor.StatusReady})
	rec, _, err := agg.Apply(CommandStart, 5000)
	if err != nil {
		t.Fatal(err)
	}
	if rec.StartedAt != 5000 {
		t.Fatalf("StartedAt=%d, want 5000", rec.StartedAt)
	}
	// Backwards clock on a later command: stamp stays at the high-water mark.
	rec, _, err = agg.Apply(CommandCancel, 3000)
	if err != nil {
		t.Fatal(err)
	}
	if rec.StartedAt != 5000 || rec.CancelledAt != 3000 {
		// CancelledAt fills a zero field (honest first stamp) while StartedAt —
		// already stamped — never rewinds.
		t.Fatalf("StartedAt=%d CancelledAt=%d", rec.StartedAt, rec.CancelledAt)
	}
	if got := agg.UpdatedAt(); got != 5000 {
		t.Fatalf("UpdatedAt=%d, want the high-water mark 5000", got)
	}
	if _, _, err := agg.Apply(CommandComplete, 4000); err == nil {
		t.Fatal("CANCEL_REQUESTED -> FILLED must be refused")
	}
	if got := agg.UpdatedAt(); got != 5000 {
		t.Fatalf("a refused apply must not advance the clock: %d", got)
	}
}

// TestUnknownCommand: a command outside the vocabulary is refused, never mapped.
func TestUnknownCommand(t *testing.T) {
	agg := New(executor.ExecutionRecord{Status: executor.StatusReady})
	_, _, err := agg.Apply(Command("explode"), 1000)
	if !errors.Is(err, ErrUnknownCommand) {
		t.Fatalf("err = %v, want ErrUnknownCommand", err)
	}
}

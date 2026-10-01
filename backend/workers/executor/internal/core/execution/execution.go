package execution

import (
	"errors"
	"fmt"
	"sync"
)

// Command is one lifecycle intent addressed to an execution aggregate
// (objective §8.10). Commands are user/API intents; the worker performs them.
type Command string

// The command vocabulary. Each command names exactly one target status.
const (
	CommandStart    Command = "start"
	CommandPause    Command = "pause"
	CommandResume   Command = "resume"
	CommandCancel   Command = "cancel"
	CommandComplete Command = "complete"
	CommandFail     Command = "fail"
)

// commandTarget is the ONE mapping from command to target status (objective
// §8.10): start→RUNNING, pause→PAUSED, resume→RUNNING, cancel→CANCEL_REQUESTED,
// complete→FILLED, fail→FAILED.
var commandTarget = map[Command]ExecutionStatus{
	CommandStart:    StatusRunning,
	CommandPause:    StatusPaused,
	CommandResume:   StatusRunning,
	CommandCancel:   StatusCancelRequested,
	CommandComplete: StatusFilled,
	CommandFail:     StatusFailed,
}

// TransitionError reports a REFUSED state change (objective §8.10). It always
// names both states so the caller can map it to HTTP 409 with a message that
// says what was attempted and where the execution actually is.
type TransitionError struct {
	Command Command
	From    ExecutionStatus
	To      ExecutionStatus
}

// Error names the command and BOTH states — never a bare "invalid".
func (e *TransitionError) Error() string {
	return fmt.Sprintf("execution: refused %q: illegal transition %s -> %s", e.Command, e.From, e.To)
}

// ErrUnknownCommand is returned for a command outside the vocabulary.
var ErrUnknownCommand = errors.New("execution: unknown command")

// Execution is the lifecycle aggregate around one ExecutionRecord (objective
// §8.10): the ONLY place command intents mutate execution status.
//
// INVARIANT: Apply is idempotent at the target — a repeated command whose
// target is the current status is a no-op (transitioned=false, err=nil) and
// NEVER re-drives the execution or rewinds a timestamp (objective §23). Any
// other illegal transition is refused with a *TransitionError naming both
// states. Timestamps (StartedAt/CompletedAt/CancelledAt/UpdatedAt) only ever
// move forward: a clock that goes backwards cannot un-stamp history.
//
// An Execution is safe for concurrent use.
type Execution struct {
	mu        sync.Mutex
	rec       ExecutionRecord
	updatedAt int64 // monotonic change clock (the frozen record carries no UpdatedAt)
}

// New wraps a record as an execution aggregate. The record is copied.
func New(rec ExecutionRecord) *Execution {
	return &Execution{rec: rec}
}

// Record returns a copy of the current aggregate state.
func (e *Execution) Record() ExecutionRecord {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.rec
}

// Status returns the current execution status.
func (e *Execution) Status() ExecutionStatus {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.rec.Status
}

// Apply performs one command at nowMs and reports the updated record plus
// whether a real transition happened.
//
// INVARIANT: (updated, false, nil) means "already there" — the caller MUST NOT
// re-emit lifecycle events or re-drive work for it (objective §23). A refusal
// returns (*TransitionError) with both states and leaves the record untouched.
func (e *Execution) Apply(cmd Command, nowMs int64) (ExecutionRecord, bool, error) {
	target, ok := commandTarget[cmd]
	if !ok {
		return e.Record(), false, fmt.Errorf("%w: %q", ErrUnknownCommand, cmd)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	// Idempotent repeat: already at the command's target. Not a transition.
	if e.rec.Status == target {
		return e.rec, false, nil
	}
	if !CanTransition(e.rec.Status, target) {
		return e.rec, false, &TransitionError{Command: cmd, From: e.rec.Status, To: target}
	}
	e.rec.Status = target
	stamp(&e.updatedAt, nowMs)
	switch cmd {
	case CommandStart:
		stamp(&e.rec.StartedAt, nowMs)
	case CommandComplete, CommandFail:
		stamp(&e.rec.CompletedAt, nowMs)
	case CommandCancel:
		stamp(&e.rec.CancelledAt, nowMs)
	}
	return e.rec, true, nil
}

// UpdatedAt returns the aggregate's monotonic change clock: the largest nowMs
// any accepted Apply/Transition has ever seen. It only moves forward — an
// idempotent repeat or a backwards clock can never rewind it.
func (e *Execution) UpdatedAt() int64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.updatedAt
}

// Transition moves the aggregate to a status that no user command targets
// (PARTIALLY_FILLED, RISK_STOPPED, RECONCILING, ...) — the worker's own
// lifecycle bookkeeping. Same rules as Apply: already-there is a no-op, an
// illegal move is refused with both states named, stamps never rewind.
func (e *Execution) Transition(to ExecutionStatus, nowMs int64) (ExecutionRecord, bool, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.rec.Status == to {
		return e.rec, false, nil
	}
	if !CanTransition(e.rec.Status, to) {
		return e.rec, false, &TransitionError{Command: Command(""), From: e.rec.Status, To: to}
	}
	e.rec.Status = to
	stamp(&e.updatedAt, nowMs)
	switch to {
	case StatusRiskStopped, StatusStopped, StatusExpired:
		// Terminal landings that are not FILLED/FAILED still close the clock.
		stamp(&e.rec.CompletedAt, nowMs)
	}
	return e.rec, true, nil
}

// stamp advances a timestamp monotonically: zero fields are filled, non-zero
// fields only move forward (an idempotent repeat or a backwards clock can never
// rewind history).
func stamp(field *int64, nowMs int64) {
	if *field == 0 || nowMs > *field {
		*field = nowMs
	}
}

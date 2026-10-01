// Package jobs models scheduled background work: WHEN a job runs (a fixed
// interval schedule), how hard it may be retried, and how runs are recorded.
// Invariant: a Spec is refused outright unless every field is well-formed —
// there is no clamping or silent defaulting, because a half-valid schedule
// either fires at the wrong time or never fires at all, and both look healthy
// from the outside.
package jobs

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/errs"
)

// Refusal codes carried by this package's errors.
const (
	// CodeSpecInvalid names any malformed Spec field, naming the field.
	CodeSpecInvalid = "JOB_SPEC_INVALID"
	// CodeDuplicate names a Registry.Add of an already-registered name.
	CodeDuplicate = "JOB_DUPLICATE"
)

// Outcome is how one run ended. Invariant: only success and failure are
// modeled; there is no "unknown" outcome to hide behind.
type Outcome string

const (
	// OutcomeSuccess marks a run that completed its work.
	OutcomeSuccess Outcome = "success"
	// OutcomeFailure marks a run that did not, exhausted or not.
	OutcomeFailure Outcome = "failure"
)

// Spec declares one recurring job. Invariant: Schedule is ONLY ever the
// interval grammar `every <n><s|m|h>` with a positive whole number of seconds,
// minutes or hours ("every 30s", "every 5m", "every 2h"); Timeout is advisory
// to the runner and never negative; MaxAttempts is at least 1 (a job always
// gets its first attempt); Backoff is the pause between attempts and never
// negative.
type Spec struct {
	// Name is the unique job identity within a Registry.
	Name string
	// Schedule is the interval, `every <n><s|m|h>` only.
	Schedule string
	// Timeout bounds one attempt's runtime.
	Timeout time.Duration
	// MaxAttempts is the total attempt budget, first attempt included.
	MaxAttempts int
	// Backoff is the delay between attempts.
	Backoff time.Duration
}

// RunRecord is the immutable history entry of one attempt. Invariant: a
// record's Outcome and timing are facts — corrections are new records, never
// edits of old ones.
type RunRecord struct {
	// SpecName identifies the job spec the attempt belongs to.
	SpecName string
	// StartedAt is when the attempt began.
	StartedAt time.Time
	// FinishedAt is when the attempt ended; zero while running.
	FinishedAt time.Time
	// Attempt is the 1-based attempt number within the run budget.
	Attempt int
	// Outcome is success or failure.
	Outcome Outcome
	// Error is the failure cause, empty on success.
	Error string
}

// ParseInterval parses ONLY the `every <n><s|m|h>` grammar. Invariants: the
// number must be a positive whole number, the unit one of s, m, h; anything
// else — empty, a bare duration, a fractional or zero or negative count, or a
// unit like "d" — is refused rather than guessed at.
func ParseInterval(schedule string) (time.Duration, error) {
	invalid := func(reason string) (time.Duration, error) {
		return 0, errs.New(errs.CategoryValidation, CodeSpecInvalid,
			fmt.Sprintf("field Schedule %s: %q does not match `every <n><s|m|h>`", reason, schedule))
	}
	rest, ok := strings.CutPrefix(schedule, "every ")
	if !ok || rest == "" {
		return invalid("is not an interval")
	}
	unit := rest[len(rest)-1]
	digits := rest[:len(rest)-1]
	n, err := strconv.Atoi(digits)
	if err != nil || strings.HasPrefix(digits, "+") || strings.HasPrefix(digits, "-") {
		return invalid("has a non-whole or empty count")
	}
	if n <= 0 {
		return invalid("has a non-positive count")
	}
	switch unit {
	case 's':
		return time.Duration(n) * time.Second, nil
	case 'm':
		return time.Duration(n) * time.Minute, nil
	case 'h':
		return time.Duration(n) * time.Hour, nil
	default:
		return invalid("has a unit other than s, m or h")
	}
}

// Validate refuses a Spec that cannot run correctly. Every refusal names the
// offending field: an empty Name, an unparsable or non-positive Schedule
// interval, MaxAttempts below 1, or a negative Backoff. Invariant: validation
// never repairs — it either accepts the spec as written or refuses it.
func Validate(spec Spec) error {
	if spec.Name == "" {
		return errs.New(errs.CategoryValidation, CodeSpecInvalid, "field Name must not be empty")
	}
	interval, err := ParseInterval(spec.Schedule)
	if err != nil {
		return err
	}
	if interval <= 0 {
		return errs.New(errs.CategoryValidation, CodeSpecInvalid, "field Schedule must be a positive interval")
	}
	if spec.MaxAttempts < 1 {
		return errs.New(errs.CategoryValidation, CodeSpecInvalid,
			"field MaxAttempts must be at least 1 (the first attempt always runs)")
	}
	if spec.Backoff < 0 {
		return errs.New(errs.CategoryValidation, CodeSpecInvalid, "field Backoff must not be negative")
	}
	return nil
}

// NextRun computes the next fire time after lastRun: lastRun + the schedule
// interval. Invariant: the cadence is fixed-delay arithmetic on the last run,
// never "catch up" batching — a stalled scheduler advances one interval at a
// time so a long outage cannot stampede the job.
func NextRun(spec Spec, lastRun time.Time) (time.Time, error) {
	interval, err := ParseInterval(spec.Schedule)
	if err != nil {
		return time.Time{}, err
	}
	return lastRun.Add(interval), nil
}

// Registry is the set of job specs a process runs. Invariant: names are
// unique — a duplicate registration is a conflict, never a silent overwrite,
// because two specs under one name would fire twice and audit as one job.
type Registry struct {
	mu    sync.RWMutex
	specs map[string]Spec
}

// NewRegistry returns an empty registry (nothing scheduled).
func NewRegistry() *Registry {
	return &Registry{specs: map[string]Spec{}}
}

// Add registers a validated spec, refusing duplicate names with JOB_DUPLICATE
// and any invalid spec with JOB_SPEC_INVALID. The stored spec is validated at
// add time so a bad spec can never reach the scheduler.
func (r *Registry) Add(spec Spec) error {
	if err := Validate(spec); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.specs[spec.Name]; exists {
		return errs.New(errs.CategoryConflict, CodeDuplicate,
			fmt.Sprintf("job %q is already registered", spec.Name))
	}
	r.specs[spec.Name] = spec
	return nil
}

// Get returns a copy of the named spec. The second result is false when the
// name is unknown — a missing job is an empty answer here, not an error, so
// callers decide whether that is a refusal in their own category.
func (r *Registry) Get(name string) (Spec, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	spec, ok := r.specs[name]
	return spec, ok
}

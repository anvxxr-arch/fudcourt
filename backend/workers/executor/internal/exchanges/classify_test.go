package exchanges

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
)

// fakeRetryable declares retry semantics like a limiter/simulator would.
type fakeRetryable struct {
	retryable bool
	limited   bool
}

func (f fakeRetryable) Error() string     { return "fake" }
func (f fakeRetryable) Retryable() bool   { return f.retryable }
func (f fakeRetryable) RateLimited() bool { return f.limited }

// fakeTimeout is a net.Error whose Timeout() is true (e.g. a dial timeout).
type fakeTimeout struct{}

func (fakeTimeout) Error() string   { return "i/o timeout" }
func (fakeTimeout) Timeout() bool   { return true }
func (fakeTimeout) Temporary() bool { return true }

func TestClassifyMirrorsExchangeTS(t *testing.T) {
	// Parity rows of exchange.ts mapError (class → category, retryable):
	// RateLimitExceeded→rate_limited, DDoSProtection→exchange_overload,
	// ExchangeNotAvailable/RequestTimeout/NetworkError→network_retryable,
	// InsufficientFunds→insufficient_balance, AuthenticationError/
	// PermissionDenied→permission_error, InvalidOrder/ArgumentsRequired/
	// BadRequest→invalid_order, everything else→unknown.
	cases := []struct {
		name         string
		err          error
		wantCategory execution.ErrorCategory
		wantRetry    bool
		wantHealth   execution.CredentialHealth
	}{
		{"nil is no signal", nil, execution.ErrUnknown, false, execution.HealthUnknown},
		{"plain error falls through to unknown", errors.New("boom"), execution.ErrUnknown, false, execution.HealthUnknown},
		{"deadline exceeded is RequestTimeout", context.DeadlineExceeded, execution.ErrNetworkRetryable, true, execution.HealthUnknown},
		{"net timeout is RequestTimeout", fakeTimeout{}, execution.ErrNetworkRetryable, true, execution.HealthUnknown},
		{"declared retryable is network family", fakeRetryable{retryable: true}, execution.ErrNetworkRetryable, true, execution.HealthUnknown},
		{"declared rate limit is rate_limited", fakeRetryable{retryable: true, limited: true}, execution.ErrRateLimited, true, execution.HealthRateLimited},
		{"declared non-retryable is unknown", fakeRetryable{retryable: false}, execution.ErrUnknown, false, execution.HealthUnknown},
		{"wrapped venue error keeps classification", &VenueError{Venue: execution.ExchangeBinance, Code: "-1003", Class: ClassificationFor(execution.ErrRateLimited), Message: "too many requests"}, execution.ErrRateLimited, true, execution.HealthRateLimited},
		{"permission_error implies PERMISSION_ERROR", &VenueError{Venue: execution.ExchangeBinance, Code: "-2015", Class: ClassificationFor(execution.ErrPermissionError)}, execution.ErrPermissionError, false, execution.HealthPermissionError},
		{"fatal implies INVALID credential", &VenueError{Venue: execution.ExchangeBybit, Class: ClassificationFor(execution.ErrFatal)}, execution.ErrFatal, false, execution.HealthInvalid},
	}
	for _, c := range cases {
		got := Classify(c.err)
		if got.Category != c.wantCategory || got.Retryable != c.wantRetry || got.Health != c.wantHealth {
			t.Errorf("Classify(%s) = %+v, want category=%s retryable=%v health=%s",
				c.name, got, c.wantCategory, c.wantRetry, c.wantHealth)
		}
		if got.Retryable != got.Category.Retryable() {
			t.Errorf("Classify(%s).Retryable = %v disagrees with Category.Retryable()", c.name, got.Retryable)
		}
	}
}

func TestClassifyCodeTables(t *testing.T) {
	cases := []struct {
		venue execution.ExchangeID
		code  string
		want  execution.ErrorCategory
	}{
		// Binance parity rows (exchange.ts error map family).
		{execution.ExchangeBinance, "-1003", execution.ErrRateLimited},
		{execution.ExchangeBinance, "-1001", execution.ErrNetworkRetryable},
		{execution.ExchangeBinance, "-2010", execution.ErrInsufficientBalance},
		{execution.ExchangeBinance, "-2015", execution.ErrPermissionError},
		{execution.ExchangeBinance, "-2013", execution.ErrInvalidOrder},
		// Bybit v5.
		{execution.ExchangeBybit, "10004", execution.ErrPermissionError},
		{execution.ExchangeBybit, "10006", execution.ErrRateLimited},
		{execution.ExchangeBybit, "110004", execution.ErrInsufficientBalance},
		{execution.ExchangeBybit, "110001", execution.ErrInvalidOrder},
		// MEXC.
		{execution.ExchangeMEXC, "429", execution.ErrRateLimited},
		{execution.ExchangeMEXC, "401", execution.ErrPermissionError},
		{execution.ExchangeMEXC, "10007", execution.ErrInsufficientBalance},
		// Unknown codes and venues are honest unknowns, never guessed.
		{execution.ExchangeBinance, "-99999", execution.ErrUnknown},
		{execution.ExchangeBinance, "", execution.ErrUnknown},
		{execution.ExchangeID("kraken"), "13", execution.ErrUnknown},
	}
	for _, c := range cases {
		got := ClassifyCode(c.venue, c.code)
		if got.Category != c.want {
			t.Errorf("ClassifyCode(%s,%q) = %s, want %s", c.venue, c.code, got.Category, c.want)
		}
	}
}

func TestClassifyVenueFailurePrecedence(t *testing.T) {
	// Known code wins over the HTTP status.
	got := ClassifyVenueFailure(execution.ExchangeBinance, "-2015", 500)
	if got.Category != execution.ErrPermissionError {
		t.Errorf("code must win over status: got %s", got.Category)
	}
	// Unknown code falls through to the status family.
	got = ClassifyVenueFailure(execution.ExchangeBinance, "-99999", 429)
	if got.Category != execution.ErrRateLimited {
		t.Errorf("status fallback: got %s", got.Category)
	}
	// Neither → unknown.
	got = ClassifyVenueFailure(execution.ExchangeBybit, "", 0)
	if got.Category != execution.ErrUnknown {
		t.Errorf("no signal: got %s", got.Category)
	}
}

func TestHTTPStatusCategory(t *testing.T) {
	cases := []struct {
		status int
		want   execution.ErrorCategory
	}{
		{429, execution.ErrRateLimited},      // RateLimitExceeded
		{418, execution.ErrExchangeOverload}, // DDoSProtection
		{408, execution.ErrNetworkRetryable}, // RequestTimeout
		{500, execution.ErrNetworkRetryable}, // ExchangeNotAvailable
		{503, execution.ErrNetworkRetryable},
		{400, execution.ErrInvalidOrder},    // BadRequest
		{401, execution.ErrPermissionError}, // AuthenticationError
		{403, execution.ErrPermissionError}, // PermissionDenied
		{404, execution.ErrUnknown},
		{200, execution.ErrUnknown},
	}
	for _, c := range cases {
		if got := HTTPStatusCategory(c.status); got != c.want {
			t.Errorf("HTTPStatusCategory(%d) = %s, want %s", c.status, got, c.want)
		}
	}
}

func TestVenueErrorNeverLeaksSecrets(t *testing.T) {
	// The safe rendering may only carry venue, category, code, status and the
	// pre-sanitized message — a raw body or signature would be a leak (PRD §109).
	ve := NewVenueError(execution.ExchangeBinance, "-2015", 403, "key permission refused")
	got := ve.Error()
	for _, banned := range []string{"\n", "secret", "signature", "recvWindow"} {
		if strings.Contains(got, banned) {
			t.Errorf("VenueError.Error() leaked %q: %s", banned, got)
		}
	}
	want := "exchange binance: category=permission_error code=-2015 http=403: key permission refused"
	if got != want {
		t.Errorf("VenueError.Error() = %q, want %q", got, want)
	}
}

func TestCredentialHealthForValidationMirrorsTS(t *testing.T) {
	// exchange.ts validateCredentials failure mapping:
	// permission_error→PERMISSION_ERROR, rate_limited→RATE_LIMITED, else INVALID.
	cases := []struct {
		category execution.ErrorCategory
		want     execution.CredentialHealth
	}{
		{execution.ErrPermissionError, execution.HealthPermissionError},
		{execution.ErrRateLimited, execution.HealthRateLimited},
		{execution.ErrNetworkRetryable, execution.HealthInvalid},
		{execution.ErrUnknown, execution.HealthInvalid},
	}
	for _, c := range cases {
		if got := CredentialHealthForValidation(ClassificationFor(c.category)); got != c.want {
			t.Errorf("CredentialHealthForValidation(%s) = %s, want %s", c.category, got, c.want)
		}
	}
}

func TestWrapTransportRoundTrips(t *testing.T) {
	cause := errors.New("dial tcp: connection refused")
	ve := WrapTransport(execution.ExchangeMEXC, ClassificationFor(execution.ErrNetworkRetryable), "GET /api/v3/account", cause)
	if !errors.Is(ve, cause) {
		t.Error("WrapTransport must preserve errors.Is plumbing")
	}
	if Classify(ve).Category != execution.ErrNetworkRetryable {
		t.Errorf("wrapped classification lost: %+v", ve.Class)
	}
}

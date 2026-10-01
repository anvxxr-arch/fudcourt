package exchange

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/services/executor/internal/executor"
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
		wantCategory executor.ErrorCategory
		wantRetry    bool
		wantHealth   executor.CredentialHealth
	}{
		{"nil is no signal", nil, executor.ErrUnknown, false, executor.HealthUnknown},
		{"plain error falls through to unknown", errors.New("boom"), executor.ErrUnknown, false, executor.HealthUnknown},
		{"deadline exceeded is RequestTimeout", context.DeadlineExceeded, executor.ErrNetworkRetryable, true, executor.HealthUnknown},
		{"net timeout is RequestTimeout", fakeTimeout{}, executor.ErrNetworkRetryable, true, executor.HealthUnknown},
		{"declared retryable is network family", fakeRetryable{retryable: true}, executor.ErrNetworkRetryable, true, executor.HealthUnknown},
		{"declared rate limit is rate_limited", fakeRetryable{retryable: true, limited: true}, executor.ErrRateLimited, true, executor.HealthRateLimited},
		{"declared non-retryable is unknown", fakeRetryable{retryable: false}, executor.ErrUnknown, false, executor.HealthUnknown},
		{"wrapped venue error keeps classification", &VenueError{Venue: executor.ExchangeBinance, Code: "-1003", Class: ClassificationFor(executor.ErrRateLimited), Message: "too many requests"}, executor.ErrRateLimited, true, executor.HealthRateLimited},
		{"permission_error implies PERMISSION_ERROR", &VenueError{Venue: executor.ExchangeBinance, Code: "-2015", Class: ClassificationFor(executor.ErrPermissionError)}, executor.ErrPermissionError, false, executor.HealthPermissionError},
		{"fatal implies INVALID credential", &VenueError{Venue: executor.ExchangeBybit, Class: ClassificationFor(executor.ErrFatal)}, executor.ErrFatal, false, executor.HealthInvalid},
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
		venue executor.ExchangeID
		code  string
		want  executor.ErrorCategory
	}{
		// Binance parity rows (exchange.ts error map family).
		{executor.ExchangeBinance, "-1003", executor.ErrRateLimited},
		{executor.ExchangeBinance, "-1001", executor.ErrNetworkRetryable},
		{executor.ExchangeBinance, "-2010", executor.ErrInsufficientBalance},
		{executor.ExchangeBinance, "-2015", executor.ErrPermissionError},
		{executor.ExchangeBinance, "-2013", executor.ErrInvalidOrder},
		// Bybit v5.
		{executor.ExchangeBybit, "10004", executor.ErrPermissionError},
		{executor.ExchangeBybit, "10006", executor.ErrRateLimited},
		{executor.ExchangeBybit, "110004", executor.ErrInsufficientBalance},
		{executor.ExchangeBybit, "110001", executor.ErrInvalidOrder},
		// MEXC.
		{executor.ExchangeMEXC, "429", executor.ErrRateLimited},
		{executor.ExchangeMEXC, "401", executor.ErrPermissionError},
		{executor.ExchangeMEXC, "10007", executor.ErrInsufficientBalance},
		// Unknown codes and venues are honest unknowns, never guessed.
		{executor.ExchangeBinance, "-99999", executor.ErrUnknown},
		{executor.ExchangeBinance, "", executor.ErrUnknown},
		{executor.ExchangeID("kraken"), "13", executor.ErrUnknown},
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
	got := ClassifyVenueFailure(executor.ExchangeBinance, "-2015", 500)
	if got.Category != executor.ErrPermissionError {
		t.Errorf("code must win over status: got %s", got.Category)
	}
	// Unknown code falls through to the status family.
	got = ClassifyVenueFailure(executor.ExchangeBinance, "-99999", 429)
	if got.Category != executor.ErrRateLimited {
		t.Errorf("status fallback: got %s", got.Category)
	}
	// Neither → unknown.
	got = ClassifyVenueFailure(executor.ExchangeBybit, "", 0)
	if got.Category != executor.ErrUnknown {
		t.Errorf("no signal: got %s", got.Category)
	}
}

func TestHTTPStatusCategory(t *testing.T) {
	cases := []struct {
		status int
		want   executor.ErrorCategory
	}{
		{429, executor.ErrRateLimited},      // RateLimitExceeded
		{418, executor.ErrExchangeOverload}, // DDoSProtection
		{408, executor.ErrNetworkRetryable}, // RequestTimeout
		{500, executor.ErrNetworkRetryable}, // ExchangeNotAvailable
		{503, executor.ErrNetworkRetryable},
		{400, executor.ErrInvalidOrder},    // BadRequest
		{401, executor.ErrPermissionError}, // AuthenticationError
		{403, executor.ErrPermissionError}, // PermissionDenied
		{404, executor.ErrUnknown},
		{200, executor.ErrUnknown},
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
	ve := NewVenueError(executor.ExchangeBinance, "-2015", 403, "key permission refused")
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
		category executor.ErrorCategory
		want     executor.CredentialHealth
	}{
		{executor.ErrPermissionError, executor.HealthPermissionError},
		{executor.ErrRateLimited, executor.HealthRateLimited},
		{executor.ErrNetworkRetryable, executor.HealthInvalid},
		{executor.ErrUnknown, executor.HealthInvalid},
	}
	for _, c := range cases {
		if got := CredentialHealthForValidation(ClassificationFor(c.category)); got != c.want {
			t.Errorf("CredentialHealthForValidation(%s) = %s, want %s", c.category, got, c.want)
		}
	}
}

func TestWrapTransportRoundTrips(t *testing.T) {
	cause := errors.New("dial tcp: connection refused")
	ve := WrapTransport(executor.ExchangeMEXC, ClassificationFor(executor.ErrNetworkRetryable), "GET /api/v3/account", cause)
	if !errors.Is(ve, cause) {
		t.Error("WrapTransport must preserve errors.Is plumbing")
	}
	if Classify(ve).Category != executor.ErrNetworkRetryable {
		t.Errorf("wrapped classification lost: %+v", ve.Class)
	}
}

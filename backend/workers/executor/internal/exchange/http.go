package exchange

import (
	"context"
	"net/http"
	"time"
)

// HTTPClient is the injectable transport seam every live adapter uses
// (binance/, bybit/, mexc/): tests drive recorded fixture responses through a
// stub implementing this interface — no live network is ever required.
type HTTPClient interface {
	// Do executes one request. Implementations MUST return a response with a
	// non-nil Body (http.NoBody is fine) or an error.
	Do(req *http.Request) (*http.Response, error)
}

// HTTPClientFunc adapts a function to the HTTPClient interface.
type HTTPClientFunc func(req *http.Request) (*http.Response, error)

// Do implements HTTPClient.
func (f HTTPClientFunc) Do(req *http.Request) (*http.Response, error) { return f(req) }

// DefaultHTTPClient returns the stdlib transport with sane venue timeouts —
// adapters MUST bound every request so a hung venue cannot pin a worker.
func DefaultHTTPClient(timeout time.Duration) HTTPClient {
	return &http.Client{Timeout: timeout}
}

// Clock is the injectable time source (signing timestamps, token TTLs):
// tests pin it to a fixed instant so HMAC signing vectors are deterministic.
type Clock interface {
	// Now returns the current unix time in milliseconds (executor contract
	// timestamp convention).
	Now() int64
}

// ClockFunc adapts a function to the Clock interface.
type ClockFunc func() int64

// Now implements Clock.
func (f ClockFunc) Now() int64 { return f() }

// SystemClock is the production Clock backed by the wall clock.
type SystemClock struct{}

// Now implements Clock.
func (SystemClock) Now() int64 { return time.Now().UnixMilli() }

// FixedClock is a pinned Clock for deterministic tests (signing vectors).
type FixedClock struct{ Millis int64 }

// Now implements Clock.
func (c FixedClock) Now() int64 { return c.Millis }

// WithClock is a convenience context helper: adapters accept their Clock at
// construction, so context plumbing is not required — this exists for callers
// that already thread clocks through contexts.
type clockKey struct{}

// ContextWithClock returns ctx carrying c.
func ContextWithClock(ctx context.Context, c Clock) context.Context {
	return context.WithValue(ctx, clockKey{}, c)
}

// ClockFromContext returns the Clock in ctx, or SystemClock when absent.
func ClockFromContext(ctx context.Context) Clock {
	if c, ok := ctx.Value(clockKey{}).(Clock); ok {
		return c
	}
	return SystemClock{}
}

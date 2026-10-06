package httpx

import (
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"time"
)

// Outbound connection tuning shared by the acquisition families.
//
// Each family builds its own *http.Client (its own timeout, its own TTL cache),
// but before this they all left Transport nil -- so every one of them borrowed
// http.DefaultTransport, whose MaxIdleConnsPerHost is 2. A family that fans out
// to a single host (cryptorank's mode sweep, a market board pricing 16 symbols)
// therefore re-dials and re-handshakes for every request past the second,
// paying a fresh TCP + TLS round-trip each time.
//
// The pool is shared process-wide on purpose: one transport means one pool, and
// per-host limits still apply because net/http keys idle connections by host.
// *http.Transport is documented safe for concurrent use, which is what makes a
// single shared instance correct rather than merely convenient.
const (
	// maxIdleConnsPerHost is the number of idle (keep-alive) connections kept
	// for one upstream host. The stdlib default is 2, too low for the fanout
	// families; 16 covers the widest board we serve without holding sockets
	// open for hosts nobody is asking about.
	maxIdleConnsPerHost = 16
	// maxIdleConns bounds the pool across all hosts, so a burst of one-off
	// hosts cannot grow it without limit.
	maxIdleConns          = 100
	idleConnTimeout       = 90 * time.Second
	dialTimeout           = 10 * time.Second
	dialKeepAlive         = 30 * time.Second
	tlsHandshakeTimeout   = 10 * time.Second
	expectContinueTimeout = 1 * time.Second
)

// sharedTransport is created once, at package init. Building a transport per
// request (or per family) would defeat the very pool it exists to provide.
var sharedTransport = newTransport()

func newTransport() *http.Transport {
	return &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		// Bounded connect instead of the 30 s stdlib default: every upstream we
		// call is a fast CDN, so a connect that has not completed in 10 s is a
		// dead path, not a slow one -- fail it and let the family report.
		DialContext: (&net.Dialer{
			Timeout:   dialTimeout,
			KeepAlive: dialKeepAlive,
		}).DialContext,
		// ForceAttemptHTTP2 is LOAD-BEARING: net/http enables HTTP/2
		// automatically only on a zero-value Transport. The moment a Transport
		// sets its own DialContext, HTTP/2 is switched off unless this flag
		// re-enables it -- and every upstream here is HTTP/2-capable (the
		// zero-value default already negotiated it), so dropping it would
		// silently cost multiplexing and change the TLS ClientHello (ALPN).
		// Asserted in transport_test.go rather than left to memory.
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          maxIdleConns,
		MaxIdleConnsPerHost:   maxIdleConnsPerHost,
		IdleConnTimeout:       idleConnTimeout,
		TLSHandshakeTimeout:   tlsHandshakeTimeout,
		ExpectContinueTimeout: expectContinueTimeout,
		TLSClientConfig: &tls.Config{
			// An explicit floor, not an inherited default: Go's client already
			// refuses < 1.2, but a config that states the floor survives a
			// future default change and records the intent.
			MinVersion: tls.VersionTLS12,
		},
	}
}

// NewClient returns an upstream client with the shared, tuned transport and the
// given total timeout. Redirects are followed (max 10), matching both the bare
// clients it replaces and net/http's own default -- a redirect silently turned
// into a failure is the behaviour change cryptorank measured when it stopped
// following them.
func NewClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout:   timeout,
		Transport: sharedTransport,
		CheckRedirect: func(_ *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("stopped after 10 redirects")
			}
			return nil
		},
	}
}

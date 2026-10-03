package httpx

import (
	"crypto/tls"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// TestSharedTransportIsTuned pins the pool settings the hardening exists to
// provide. Field assertions alone would not prove the pool works, so
// TestSharedTransportReusesConnections exercises it live; this one makes a
// silent revert to the stdlib default visible.
func TestSharedTransportIsTuned(t *testing.T) {
	tr := sharedTransport
	if tr == nil {
		t.Fatal("sharedTransport is nil")
	}
	if tr.MaxIdleConnsPerHost != maxIdleConnsPerHost {
		t.Errorf("MaxIdleConnsPerHost = %d, want %d", tr.MaxIdleConnsPerHost, maxIdleConnsPerHost)
	}
	if tr.MaxIdleConnsPerHost <= 2 {
		t.Errorf("MaxIdleConnsPerHost = %d: not above the stdlib default of 2, so the pool does nothing", tr.MaxIdleConnsPerHost)
	}
	if !tr.ForceAttemptHTTP2 {
		t.Error("ForceAttemptHTTP2 is false: a custom DialContext silently disables HTTP/2")
	}
	if tr.DialContext == nil {
		t.Error("DialContext is nil: no bounded connect timeout")
	}
	if tr.TLSClientConfig == nil || tr.TLSClientConfig.MinVersion != tls.VersionTLS12 {
		t.Errorf("TLSClientConfig.MinVersion = %v, want TLS 1.2", tr.TLSClientConfig)
	}
	if tr.IdleConnTimeout != idleConnTimeout {
		t.Errorf("IdleConnTimeout = %v, want %v", tr.IdleConnTimeout, idleConnTimeout)
	}
	if tr.MaxIdleConns != maxIdleConns {
		t.Errorf("MaxIdleConns = %d, want %d", tr.MaxIdleConns, maxIdleConns)
	}
}

func TestNewClientWiring(t *testing.T) {
	c := NewClient(5 * time.Second)
	if c.Timeout != 5*time.Second {
		t.Errorf("Timeout = %v, want 5s", c.Timeout)
	}
	if c.Transport != http.RoundTripper(sharedTransport) {
		t.Error("client does not use the shared transport: the pool is defeated")
	}
	if c.CheckRedirect == nil {
		t.Fatal("CheckRedirect is nil: redirects would fall back to the stdlib default silently")
	}
	if err := c.CheckRedirect(nil, make([]*http.Request, 9)); err != nil {
		t.Errorf("refused a 9-deep redirect chain: %v", err)
	}
	if err := c.CheckRedirect(nil, make([]*http.Request, 10)); err == nil {
		t.Error("allowed a 10-deep redirect chain; the cap is gone")
	}
}

// TestSharedTransportReusesConnections is the live proof that the pool actually
// reuses a keep-alive connection instead of re-dialing: three sequential
// requests must arrive on ONE client port. A field assertion cannot show this.
func TestSharedTransportReusesConnections(t *testing.T) {
	var mu sync.Mutex
	ports := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		ports[r.RemoteAddr]++
		mu.Unlock()
		_, _ = io.WriteString(w, "ok")
	}))
	defer srv.Close()

	c := NewClient(5 * time.Second)
	for i := 0; i < 3; i++ {
		res, err := c.Get(srv.URL)
		if err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
		_, _ = io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
	}

	mu.Lock()
	defer mu.Unlock()
	if len(ports) != 1 {
		t.Errorf("saw %d distinct client connections (%v), want 1: the pool is not reusing", len(ports), ports)
	}
}

package cryptorank

// Live proofs against the real upstream. Skipped unless APICALLS_LIVE=1,
// because they spend requests on someone else's site.
//
//	APICALLS_LIVE=1 go test ./internal/cryptorank/ -run TestLive -v -timeout 180s
//
// TestLiveChromeProfileFetches proves the dependency stack works: tls-client +
// profiles.Chrome_131 over HTTP/2 returns 200 with the SSR payload (measured in
// /home/dwizzy/apicalls-probe as 200 / 738673 bytes / __NEXT_DATA__ 177442).
//
// TestLiveChallengeIsLoud drives the same URL with the same Chrome profile but
// HTTP/1.1 forced -- the measured 403 arm (uTLS HelloChrome_131 over H1 gets
// `cf-mitigated: challenge`) -- and asserts the failure is the distinct,
// alarmable error, never a silently-empty page. That is the arm that fires if
// the pinned profile ever goes stale, so it must stay loud.

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

const livePath = "/all-coins-list"

func liveGuard(t *testing.T) {
	t.Helper()
	if os.Getenv("APICALLS_LIVE") != "1" {
		t.Skip("set APICALLS_LIVE=1 to run live upstream proofs")
	}
}

func TestLiveChromeProfileFetches(t *testing.T) {
	liveGuard(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	f, err := New(Options{CacheDir: t.TempDir(), Timeout: 45 * time.Second})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	h, err := f.Fetch(ctx, "html", livePath, 60)
	if err != nil {
		t.Fatalf("live fetch failed (is the pinned profile stale?): %v", err)
	}
	t.Logf("status=%d bytes=%d cache=%s", *h.Status, h.HTMLBytes, h.Cache)
	if h.Cache != "MISS" || h.Route != "html" {
		t.Errorf("helper shape: cache=%q route=%q", h.Cache, h.Route)
	}
	coins, ok := h.PageProps["coins"].([]interface{})
	if !ok || len(coins) == 0 {
		t.Fatalf("pageProps.coins missing from a live payload (pageProps keys=%d)", len(h.PageProps))
	}
	t.Logf("pageProps.coins=%d rows", len(coins))
}

func TestLiveChallengeIsLoud(t *testing.T) {
	liveGuard(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Same Chrome 131 ClientHello, but HTTP/1.1 only: measured 403 with
	// `cf-mitigated: challenge` (spike variant C1). This is the failure mode a
	// stale profile produces, and it must be impossible to mistake for data.
	client, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(),
		tls_client.WithTimeoutSeconds(45),
		tls_client.WithClientProfile(profiles.Chrome_131),
		tls_client.WithForceHttp1(),
	)
	if err != nil {
		t.Fatal(err)
	}
	f, err := New(Options{CacheDir: t.TempDir(), Timeout: 45 * time.Second, Client: client})
	if err != nil {
		t.Fatal(err)
	}
	h, ferr := f.Fetch(ctx, "html", livePath, 60)
	if ferr == nil {
		t.Fatalf("HTTP/1.1-only client unexpectedly got data (status %d) -- re-measure the fingerprint story", *h.Status)
	}
	he, ok := IsHardError(ferr)
	if !ok {
		t.Fatalf("wall is not alarmable: %T %v", ferr, ferr)
	}
	if he.Kind != "cf-challenge" {
		t.Errorf("kind=%q want cf-challenge", he.Kind)
	}
	if !strings.Contains(he.Detail, "cf-mitigated: challenge") {
		t.Errorf("detail does not name the challenge: %q", he.Detail)
	}
	t.Logf("ALARM path: kind=%s status=%d detail=%q", he.Kind, he.Status, he.Detail)
}

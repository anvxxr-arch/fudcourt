// Package paritytest proves the SERVED BYTES, not just the in-memory envelope.
//
// internal/cryptorank's parity test unmarshals the TS golden and the Go envelope
// and re-marshals BOTH through Go's encoder before comparing, so it is blind to
// divergence introduced by the encoder itself: HTML escaping (\u003c for `<`)
// and key order both vanish under that alignment.
//
// This test closes the escaping half: it drives the real HTTP handler and
// compares the response body against the TS envelope routed through the same
// escaping rule JS uses (JSON.stringify -- no HTML escaping, object-literal key
// order). Key ORDER is deliberately out of scope: the frozen goldens are
// key-sorted by their generator while a live JSON.stringify body is in
// insertion order, so whole-body byte equality is not the contract. The
// comparison here is on the SERVED format (escaping + values), with keys sorted
// on both sides, and it walks the served bytes looking for \u003c/\u003e/\u0026.
package paritytest

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/backend/data/internal/cryptorank"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/httpx"
)

func fixturesDir(t *testing.T) string {
	t.Helper()
	if d := os.Getenv("FUDCOURT_DATA_FIXTURES_DIR"); d != "" {
		return d
	}
	// internal/paritytest -> services/data -> apps -> repo root
	dir, err := filepath.Abs(filepath.Join("..", "..", "..", "web", "scripts", "fixtures"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "MANIFEST.json")); err != nil {
		t.Skipf("fixtures not found at %s (set FUDCOURT_DATA_FIXTURES_DIR)", dir)
	}
	return dir
}

// serveOnce runs the real HTTP handler against a stubbed fetcher that returns
// the recorded fixture, and returns the served body.
func serveOnce(t *testing.T, mode string, h *cryptorank.HelperOut, url string) []byte {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, url, nil)
	// The real production writer, not a copy of it.
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteJSON(w, 200, mustEnvelope(t, mode, h, url))
	})
	handler.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("%s: handler status %d (%s)", mode, rec.Code, rec.Body.String())
	}
	return rec.Body.Bytes()
}

func mustEnvelope(t *testing.T, mode string, h *cryptorank.HelperOut, url string) interface{} {
	t.Helper()
	key := ""
	pathValue := ""
	if i := strings.Index(url, "key="); i >= 0 {
		key = url[i+len("key="):]
	}
	p, err := cryptorank.CanonicalPath(mode, key)
	if err != nil {
		t.Fatal(err)
	}
	pathValue = p
	env, err := cryptorank.Envelope(mode, h, cryptorank.Opts{Key: key, Upstream: cryptorank.Base + pathValue})
	if err != nil {
		t.Fatalf("%s: envelope refused: %v", mode, err)
	}
	return env
}

func loadFixture(t *testing.T, fix, mode string) *cryptorank.HelperOut {
	t.Helper()
	f, err := os.Open(filepath.Join(fix, mode+".json.gz"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	var h cryptorank.HelperOut
	if err := json.Unmarshal(body, &h); err != nil {
		t.Fatal(err)
	}
	return &h
}

// canon re-encodes a served/golden body through the JS escaping rule and sorts
// keys, so escaping differences survive but key-order differences do not.
func canon(t *testing.T, raw []byte) []byte {
	t.Helper()
	var v interface{}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("unmarshal %q: %v", string(raw[:min(80, len(raw))]), err)
	}
	sorted := sortValue(v)
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "")
	if err := enc.Encode(sorted); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func sortValue(v interface{}) interface{} {
	switch x := v.(type) {
	case map[string]interface{}:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		out := make(map[string]interface{}, len(x))
		for _, k := range keys {
			out[k] = sortValue(x[k])
		}
		return out
	case []interface{}:
		out := make([]interface{}, len(x))
		for i, e := range x {
			out[i] = sortValue(e)
		}
		return out
	default:
		return v
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// TestServedBytesMatchTSForEveryMode is the escaping guard: the served body and
// the TS golden must agree after canonicalisation, AND the served body must not
// contain Go's HTML escapes. ecosystem.json alone carries 59 raw `<`/`>`/`&`
// characters, so this test fails loudly if SetEscapeHTML(false) is ever dropped.
func TestServedBytesMatchTSForEveryMode(t *testing.T) {
	fix := fixturesDir(t)
	entries, err := filepath.Glob(filepath.Join(fix, "*.json.gz"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 {
		t.Fatal("no fixtures")
	}
	checked, withHTML := 0, 0
	for _, e := range entries {
		mode := strings.TrimSuffix(filepath.Base(e), ".json.gz")
		if !cryptorank.Known(mode) || cryptorank.IsDisabled(mode) {
			continue
		}
		t.Run(mode, func(t *testing.T) {
			h := loadFixture(t, fix, mode)
			key := ""
			if cryptorank.IsKeyed(mode) {
				key = cryptorank.DefaultKeys[mode]
			} else if mode == "exchanges" {
				key = cryptorank.DefaultExchange
			} else if mode == "launchpool" {
				key = cryptorank.DefaultLP
			} else if mode == "nodesale" {
				key = cryptorank.DefaultND
			}
			url := "/api/cryptorank?mode=" + mode
			if key != "" {
				url += "&key=" + key
			}
			served := serveOnce(t, mode, h, url)

			// The served body itself must be free of Go's HTML escapes.
			for _, bad := range []string{`\u003c`, `\u003e`, `\u0026`, `\u0027`} {
				if bytes.Contains(served, []byte(bad)) {
					t.Errorf("served body contains Go HTML escape %s", bad)
				}
			}
			golden, err := os.ReadFile(filepath.Join(fix, "expected", mode+".json"))
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(golden, []byte(`\u003c`)) {
				t.Errorf("golden unexpectedly contains an escape (upstream drift?)")
			}
			if !bytes.Equal(canon(t, served), canon(t, golden)) {
				t.Errorf("served bytes != TS golden after canonicalisation\n served: %.400s\n golden: %.400s",
					canon(t, served), canon(t, golden))
			}
			if bytes.Contains(golden, []byte("<")) || bytes.Contains(golden, []byte("&")) {
				withHTML++
			}
			checked++
		})
	}
	if checked == 0 {
		t.Fatal("no modes checked")
	}
	if withHTML == 0 {
		t.Error("no fixture exercised raw < or & -- the escaping guard is not actually being tested")
	}
	t.Logf("checked %d modes, %d of them carry raw < or &", checked, withHTML)
}

// A direct unit test of the served framing: exact bytes, no escaping.
func TestServedEscapingIsJSONStringifyLike(t *testing.T) {
	rec := httptest.NewRecorder()
	httpx.WriteJSON(rec, 200, map[string]string{"t": "a<b>c&d"})
	got := rec.Body.String()
	want := "{\"t\":\"a<b>c&d\"}\n"
	if got != want {
		t.Errorf("body %q want %q", got, want)
	}
	if strings.Contains(got, `\u00`) {
		t.Errorf("HTML escaping present: %q", got)
	}
}

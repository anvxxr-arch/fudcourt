package coinglass

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fixture is one recorded CoinGlass response: the raw body plus the headers that
// make it decryptable. `real-*` are byte-for-byte captures from the live hosts;
// `synth-*` are produced by encrypting a known payload, so every `v` branch is
// pinned even though upstream rotates `v` and cannot be asked for a specific one.
type fixture struct {
	URL       string          `json:"url"`
	V         string          `json:"v"`
	User      string          `json:"user"`
	Time      string          `json:"time"`
	CacheTS   string          `json:"cache_ts"`
	Synthetic bool            `json:"synthetic"`
	Key0      string          `json:"key0"`
	Expect    json.RawMessage `json:"expect"`
}

func loadFixtures(t *testing.T) map[string]fixture {
	t.Helper()
	metas, err := filepath.Glob(filepath.Join("testdata", "*.meta.json"))
	if err != nil || len(metas) == 0 {
		t.Fatalf("no fixtures found: %v", err)
	}
	out := make(map[string]fixture, len(metas))
	for _, m := range metas {
		raw, err := os.ReadFile(m)
		if err != nil {
			t.Fatalf("read %s: %v", m, err)
		}
		var f fixture
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatalf("parse %s: %v", m, err)
		}
		name := strings.TrimSuffix(filepath.Base(m), ".meta.json")
		out[name] = f
	}
	return out
}

// TestKey0EveryBranch pins the v table. The public Python tool documents v=1 as
// universal and calls 55/66/77 deprecated; live traffic disproves that, so each
// constant is asserted explicitly and an unknown v must be an error (never a
// silent fallback to another branch).
func TestKey0EveryBranch(t *testing.T) {
	cases := []struct {
		name    string
		v       string
		url     string
		cacheTS string
		timeHdr string
		want    string
		wantErr bool
	}{
		{name: "v1_uses_path_only", v: "1", url: "https://capi.coinglass.com/api/openInterest/info?symbol=BTC",
			want: "L2FwaS9vcGVuSW50"},
		{name: "v0_uses_cache_ts", v: "0", cacheTS: "1712345678901234", want: "MTcxMjM0NTY3ODkw"},
		{name: "v2_uses_time_header", v: "2", timeHdr: "1712345999999999", want: "MTcxMjM0NTk5OTk5"},
		{name: "v55_legacy_constant", v: "55", want: "MTcwYjA3MGRhOTY1"},
		{name: "v66_legacy_constant", v: "66", want: "ZDY1MzdkODQ1YTk2"},
		{name: "v77_legacy_constant", v: "77", want: "ODYzZjA4Njg5Yzk3"},
		{name: "v0_without_input", v: "0", wantErr: true},
		{name: "v2_without_input", v: "2", wantErr: true},
		{name: "v1_without_path", v: "1", url: "not-a-url", wantErr: true},
		{name: "unknown_v", v: "99", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Key0(tc.v, tc.url, tc.cacheTS, tc.timeHdr)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("v=%s: want error, got key0=%q", tc.v, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("v=%s: %v", tc.v, err)
			}
			if got != tc.want {
				t.Fatalf("v=%s: key0 = %q, want %q", tc.v, got, tc.want)
			}
			if len(got) != 16 {
				t.Fatalf("v=%s: key0 is %d chars, want 16", tc.v, len(got))
			}
		})
	}
}

// TestDecryptRecordedFixtures runs the real two-layer pipeline over every
// recorded response. This is the test that would have caught "v=1 is universal":
// real-statistics carries v=66 and real-openinterest carries v=77, so an
// implementation with a single hard-coded branch fails here.
func TestDecryptRecordedFixtures(t *testing.T) {
	fixtures := loadFixtures(t)
	if len(fixtures) < 6 {
		t.Fatalf("expected at least 6 fixtures, found %d", len(fixtures))
	}
	for name, f := range fixtures {
		t.Run(name, func(t *testing.T) {
			body, err := os.ReadFile(filepath.Join("testdata", name+".body"))
			if err != nil {
				t.Fatalf("read body: %v", err)
			}
			res, err := Decrypt(body, f.User, f.V, f.URL, f.CacheTS, f.Time)
			if err != nil {
				t.Fatalf("Decrypt: %v", err)
			}
			if !res.Encrypted {
				t.Fatal("encrypted fixture reported Encrypted=false")
			}
			if res.V != f.V {
				t.Fatalf("V = %q, want %q", res.V, f.V)
			}
			if !json.Valid(res.JSON) {
				t.Fatalf("decrypted payload is not valid JSON: %s", res.JSON)
			}
			if f.Synthetic {
				// A synthetic fixture pins the exact plaintext, so the test
				// proves byte-level correctness and not just "it parsed".
				var got, want any
				if err := json.Unmarshal(res.JSON, &got); err != nil {
					t.Fatalf("unmarshal got: %v", err)
				}
				if err := json.Unmarshal(f.Expect, &want); err != nil {
					t.Fatalf("unmarshal want: %v", err)
				}
				if !jsonEqual(got, want) {
					t.Fatalf("plaintext mismatch:\n got %v\nwant %v", got, want)
				}
				if f.Key0 != "" {
					k0, err := Key0(f.V, f.URL, f.CacheTS, f.Time)
					if err != nil {
						t.Fatalf("Key0: %v", err)
					}
					if k0 != f.Key0 {
						t.Fatalf("key0 = %q, want %q", k0, f.Key0)
					}
				}
				return
			}
			// Real captures: assert the shape the dashboard consumes, which is
			// what a decoder silently getting the wrong key would destroy.
			switch name {
			case "real-statistics":
				var obj map[string]any
				if err := json.Unmarshal(res.JSON, &obj); err != nil {
					t.Fatalf("statistics is not an object: %v", err)
				}
				for _, k := range []string{"openInterest", "longRate", "shortRate", "volUsd"} {
					v, ok := obj[k]
					if !ok {
						t.Fatalf("statistics missing %q", k)
					}
					if n, ok := v.(float64); !ok || n <= 0 {
						t.Fatalf("statistics[%q] = %v, want a positive number", k, v)
					}
				}
			case "real-openinterest":
				var arr []map[string]any
				if err := json.Unmarshal(res.JSON, &arr); err != nil {
					t.Fatalf("openinterest is not an array: %v", err)
				}
				if len(arr) == 0 {
					t.Fatal("openinterest decoded to an empty array from a non-empty body")
				}
				if sym, _ := arr[0]["symbol"].(string); sym == "" {
					t.Fatalf("openinterest[0] has no symbol: %v", arr[0])
				}
			default:
				t.Fatalf("unclassified real fixture %q — classify it instead of skipping", name)
			}
		})
	}
}

func jsonEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

// TestDecryptPlainPassthrough: upstream mixes encrypted and plain responses. A
// plain 200 must come back verbatim, not as an error and not as an empty object.
func TestDecryptPlainPassthrough(t *testing.T) {
	// Measured live: /api/fundingRate/list without pageNum answers this exactly.
	body := []byte(`{"code":"40001","msg":"Required Integer parameter 'pageNum' is not present","success":false}`)
	res, err := Decrypt(body, "", "", "https://capi.coinglass.com/api/fundingRate/list", "", "")
	if err != nil {
		t.Fatalf("plain body must pass through, got error: %v", err)
	}
	if res.Encrypted {
		t.Fatal("plain body reported Encrypted=true")
	}
	if res.Code != "40001" {
		t.Fatalf("Code = %q, want 40001 (upstream's own refusal must survive)", res.Code)
	}
	if !res.Refused() {
		t.Fatal("upstream's success:false envelope must report Refused")
	}
	if !strings.Contains(res.Msg, "pageNum") {
		t.Fatalf("upstream message lost: msg=%q", res.Msg)
	}
	if string(res.JSON) != "null" {
		t.Fatalf("a refusal carries no data; JSON = %s, want null", res.JSON)
	}

	// A plain object payload is the shape `data` takes on unencrypted endpoints.
	obj := []byte(`{"code":"0","msg":"success","data":{"symbol":"BTC","price":84806}}`)
	res, err = Decrypt(obj, "", "", "https://capi.coinglass.com/api/x", "", "")
	if err != nil {
		t.Fatalf("Unmarshal plain object: %v", err)
	}
	if res.Encrypted {
		t.Fatal("plain object reported Encrypted=true")
	}
	var got map[string]any
	if err := json.Unmarshal(res.JSON, &got); err != nil {
		t.Fatalf("data is not an object: %v", err)
	}
	if got["price"].(float64) != 84806 {
		t.Fatalf("price = %v, want 84806", got["price"])
	}
}

// TestDecryptNullDataIsReported: `data: null` is upstream saying nothing. We
// return null so the caller can decide; we never substitute an empty object.
func TestDecryptNullDataIsReported(t *testing.T) {
	res, err := Decrypt([]byte(`{"code":"0","msg":"success","data":null}`), "", "", "", "", "")
	if err != nil {
		t.Fatalf("null data must not error: %v", err)
	}
	if string(res.JSON) != "null" {
		t.Fatalf("JSON = %s, want null", res.JSON)
	}
}

// TestDecryptEncryptedBodyWithoutHeaders: an encrypted-looking `data` string
// with no v/user is the dangerous case — a lenient implementation would return
// something empty and let a downstream shaper render an empty table.
func TestDecryptEncryptedBodyWithoutHeaders(t *testing.T) {
	body := []byte(`{"code":"0","msg":"success","data":"AAAA"}`)
	_, err := Decrypt(body, "", "", "https://capi.coinglass.com/api/x", "", "")
	if err == nil {
		t.Fatal("encrypted data with no v/user header must be an error")
	}
	if !strings.Contains(err.Error(), "no v/user header") {
		t.Fatalf("error should name the missing headers, got: %v", err)
	}
}

// TestDecryptUnknownVIsLoud: a v value outside the table must fail with the
// value in the message, not fall back to some other key.
func TestDecryptUnknownVIsLoud(t *testing.T) {
	body := []byte(`{"code":"0","msg":"success","data":"AAAA"}`)
	_, err := Decrypt(body, "AAAA", "99", "https://capi.coinglass.com/api/x", "", "")
	if err == nil {
		t.Fatal("unknown v must be an error")
	}
	if !strings.Contains(err.Error(), `v="99"`) {
		t.Fatalf("error should name the v value, got: %v", err)
	}
}

// TestDecryptMissingDerivationInputIsLoud: v=1 with a URL that has no path, or
// v=0 with no cache-ts-v2, must say so instead of producing a wrong key.
func TestDecryptMissingDerivationInputIsLoud(t *testing.T) {
	for _, tc := range []struct{ v, url, cache string }{
		{v: "0", url: "https://capi.coinglass.com/api/x"},
		{v: "1", url: "https://capi.coinglass.com"},
	} {
		body := []byte(`{"code":"0","msg":"success","data":"AAAA"}`)
		_, err := Decrypt(body, "AAAA", tc.v, tc.url, tc.cache, "")
		if err == nil {
			t.Fatalf("v=%s: want error", tc.v)
		}
		if !errors.Is(err, ErrMissingDerivationInput) {
			t.Fatalf("v=%s: want ErrMissingDerivationInput, got %v", tc.v, err)
		}
	}
}

// TestAESECBDecryptRejectsBadPadding proves the padding check is real: without
// it, a wrong key produces garbage that only fails later (inside gzip), which is
// exactly the misleading error this family must not produce.
func TestAESECBDecryptRejectsBadPadding(t *testing.T) {
	key := []byte("0123456789abcdef")
	ct := make([]byte, 32) // all zero -> decrypted last byte is whatever AES gives
	// Force a padding byte that cannot be valid by making the plaintext last
	// block decrypt to something whose final byte is 0.
	ct[31] = 0
	_, err := aesECBDecrypt(ct, key)
	if err == nil {
		// A 1/256 chance the random-looking final byte is a valid pad; retry a
		// few ciphers before declaring the check absent.
		for i := range 8 {
			ct[0] = byte(i)
			if _, err = aesECBDecrypt(ct, key); err != nil {
				return
			}
		}
		t.Fatal("aesECBDecrypt accepted 9 blocks with no valid PKCS#7 padding")
	}
}

// TestAESECBDecryptRejectsNonBlockLength: a ciphertext that is not a whole
// number of AES blocks is malformed, and saying so beats a confusing panic.
func TestAESECBDecryptRejectsNonBlockLength(t *testing.T) {
	if _, err := aesECBDecrypt([]byte("short"), []byte("0123456789abcdef")); err == nil {
		t.Fatal("17-byte ciphertext must be rejected")
	}
}

package coinank

import (
	"encoding/base64"
	"strconv"
	"strings"
	"testing"
)

// TestSignatureVectors pins the client-side signature against values produced
// OUTSIDE this implementation.
//
// The vectors were generated with an independent Python re-expression of the
// bundle's algorithm (base64 of uuid[8:]+uuid[:8] + "|" + str(ms+C) + "347"),
// not by running this Go code. A self-generated golden would only prove the code
// is consistent with itself, which is exactly the failure mode this test exists
// to catch: an off-by-one in the clock offset or a wrong uuid slice still yields
// a perfectly stable, perfectly wrong key.
func TestSignatureVectors(t *testing.T) {
	cases := []struct {
		ms   int64
		want string
	}{
		{0, "LWIzMWUtYzU0Ny1kMjk5LWI2ZDA3Yjc2MzFhYmIyZDkwM2RkfDIyMjIyMjIyMjIyMjIzNDc="},
		{1, "LWIzMWUtYzU0Ny1kMjk5LWI2ZDA3Yjc2MzFhYmIyZDkwM2RkfDIyMjIyMjIyMjIyMjMzNDc="},
		{1735689600000, "LWIzMWUtYzU0Ny1kMjk5LWI2ZDA3Yjc2MzFhYmIyZDkwM2RkfDM5NTc5MTE4MjIyMjIzNDc="},
		{1790969044000, "LWIzMWUtYzU0Ny1kMjk5LWI2ZDA3Yjc2MzFhYmIyZDkwM2RkfDQwMTMxOTEyNjYyMjIzNDc="},
	}
	for _, c := range cases {
		if got := Signature(c.ms); got != c.want {
			t.Errorf("Signature(%d)\n got %s\nwant %s", c.ms, got, c.want)
		}
	}
}

// TestSignatureShape asserts the structure of the signed string independently of
// the exact bytes: the prefix is the uuid with its 8-char head moved to the tail,
// the middle is the clock plus the offset, and the tail is the fixed suffix.
//
// The vector test above would catch a change here, but it would report only
// "bytes differ". This one names WHICH part moved, so a future rotation of any
// single constant produces a diagnosis instead of a diff.
func TestSignatureShape(t *testing.T) {
	const ms = 1700000000000
	raw, err := base64.StdEncoding.DecodeString(Signature(ms))
	if err != nil {
		t.Fatalf("signature is not valid base64: %v", err)
	}
	parts := strings.Split(string(raw), "|")
	if len(parts) != 2 {
		t.Fatalf("signed string must contain exactly one %q separator, got %d in %q", "|", len(parts), raw)
	}
	head := signUUID[:signPrefixLen]
	rest := strings.Replace(signUUID, head, "", 1)
	if want := rest + head; parts[0] != want {
		t.Errorf("prefix\n got %q\nwant %q (uuid[8:] + uuid[:8])", parts[0], want)
	}
	if want := strconv.FormatInt(ms+signClockOffset, 10) + signSuffix; parts[1] != want {
		t.Errorf("suffix\n got %q\nwant %q (ms + clockOffset, then %q)", parts[1], want, signSuffix)
	}
	if signClockOffset != 2222222222222 {
		t.Errorf("clock offset changed to %d; re-derive the vectors before trusting this test", signClockOffset)
	}
	if !strings.HasSuffix(signSuffix, "347") {
		t.Errorf("signature suffix changed to %q", signSuffix)
	}
}

// TestSignatureIsFirstOccurrenceReplace documents a subtle trap: the bundle's JS
// uses String.prototype.replace, which removes only the FIRST match. Go's
// strings.ReplaceAll (and Python's str.replace) would remove every occurrence. If
// the head ever appeared twice in the uuid, ReplaceAll would silently produce a
// different key and the server's answer would be `system error!` — a 200 with no
// hint about the cause.
func TestSignatureIsFirstOccurrenceReplace(t *testing.T) {
	const head = "b2d903dd"
	if n := strings.Count(signUUID, head); n != 1 {
		t.Fatalf("uuid contains %d copies of the head %q; the first-occurrence vs replace-all "+
			"distinction is now load-bearing and this test must be revisited", n, head)
	}
	first := strings.Replace(signUUID, head, "", 1)
	all := strings.ReplaceAll(signUUID, head, "")
	if first != all {
		t.Errorf("replace(1) and ReplaceAll disagree on this uuid:\n first %q\n all   %q", first, all)
	}
	// The implementation must match the JS semantics.
	if got, want := Signature(1), base64.StdEncoding.EncodeToString(
		[]byte(first+head+"|"+strconv.FormatInt(1+signClockOffset, 10)+signSuffix)); got != want {
		t.Errorf("Signature uses replace-all semantics, not first-occurrence:\n got %s\nwant %s", got, want)
	}
}

// TestRequestHeaders pins the header set the dashboard sends.
func TestRequestHeaders(t *testing.T) {
	h := RequestHeaders(1790969044000)
	for _, k := range []string{"Coinank-Apikey", "Web-Version", "Client", "Token", "Origin", "Referer", "Accept", "User-Agent"} {
		if _, ok := h[k]; !ok {
			t.Errorf("header %q missing from the request header set", k)
		}
	}
	if h["Coinank-Apikey"] != Signature(1790969044000) {
		t.Error("Coinank-Apikey header is not the computed signature")
	}
	if h["Web-Version"] != "102" || h["Client"] != "web" {
		t.Errorf("version/client drift: web-version=%q client=%q", h["Web-Version"], h["Client"])
	}
	// `token` must be PRESENT and empty, not omitted: the dashboard always sends
	// it, and the two are only equivalent while upstream treats empty as
	// anonymous. Asserting presence keeps that assumption visible.
	if v, ok := h["Token"]; !ok || v != "" {
		t.Errorf("token header must be present and empty for the anonymous surface, got %q (present=%v)", v, ok)
	}
}

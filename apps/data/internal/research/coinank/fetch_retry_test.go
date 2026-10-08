package coinank

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// transientRefusalBody is the refusal that was measured to CLEAR ON ITS OWN:
// HTTP 200, success:false, code 403, and this exact message. It is distinct from
// refusalBody in fetch_test.go, which carries code "0" / "system error!" and is
// deterministic -- conflating the two is the bug these tests exist to prevent.
const transientRefusalBody = `{"success":false,"code":"403","extCode":null,` +
	`"msg":"please sub api to get data","data":null}`

// step is one canned response in a sequence.
type step struct {
	status int
	body   string
	err    error
}

// seqDoer replays a SEQUENCE of responses, which fakeDoer cannot: the whole
// point of the retry is that attempt 1 and attempt 2 see different answers.
type seqDoer struct {
	steps []step
	i     int
	reqs  []*http.Request
}

func (s *seqDoer) Do(req *http.Request) (*http.Response, error) {
	s.reqs = append(s.reqs, req)
	if s.i >= len(s.steps) {
		return nil, errors.New("seqDoer: exhausted")
	}
	st := s.steps[s.i]
	s.i++
	if st.err != nil {
		return nil, st.err
	}
	return &http.Response{
		StatusCode: st.status,
		Header:     http.Header{},
		Body:       io.NopCloser(strings.NewReader(st.body)),
	}, nil
}

// TestTransientRefusalIsRetriedAndRidesOutTheBlip is the fix's whole contract:
// the upstream's self-clearing refusal must not reach the caller when the very
// next attempt succeeds. Before this, attempt 1's refusal was the answer.
func TestTransientRefusalIsRetriedAndRidesOutTheBlip(t *testing.T) {
	d := &seqDoer{steps: []step{
		{status: 200, body: transientRefusalBody},
		{status: 200, body: fundingBody},
	}}
	f := newTestFetcher(t, d)

	res, _, err := f.FetchFresh(context.Background(), Base+"/api/fundingRate/current")
	if err != nil {
		t.Fatalf("a refusal that clears on attempt 2 must not surface: %v", err)
	}
	if !res.Envelope.Success {
		t.Fatalf("want the successful envelope, got success=false")
	}
	if len(d.reqs) != 2 {
		t.Fatalf("issued %d requests, want 2 (one refusal + one success)", len(d.reqs))
	}
}

// TestDeterministicRefusalIsNotRetried is the complementary half, and the one
// that keeps the retry from becoming a timeout-burner: `system error!` is a
// deterministic param/entitlement answer, so retrying it is pure waste.
func TestDeterministicRefusalIsNotRetried(t *testing.T) {
	d := &seqDoer{steps: []step{
		{status: 200, body: refusalBody},
		{status: 200, body: refusalBody},
		{status: 200, body: refusalBody},
	}}
	f := newTestFetcher(t, d)

	_, _, err := f.FetchFresh(context.Background(), Base+"/api/fundingRate/current")
	if err == nil {
		t.Fatal("a deterministic refusal must surface as an error")
	}
	if len(d.reqs) != 1 {
		t.Fatalf("issued %d requests, want 1: a deterministic refusal must not be retried", len(d.reqs))
	}
	if transientRefusal(err) {
		t.Errorf("refusalBody must not classify as transient: %v", err)
	}
}

// TestRetryResignsEachAttempt pins the clock coupling. The signature is derived
// from the millisecond clock, so a retry that replayed attempt 1's signed
// headers would present a stale clock -- a second, self-inflicted failure. The
// two attempts must therefore carry DIFFERENT coinank-apikey values.
func TestRetryResignsEachAttempt(t *testing.T) {
	d := &seqDoer{steps: []step{
		{status: 200, body: transientRefusalBody},
		{status: 200, body: fundingBody},
	}}
	f := newTestFetcher(t, d)
	// A clock that advances a full second per read guarantees the two attempts
	// cannot accidentally share a millisecond.
	tick := time.UnixMilli(1790969044000)
	f.now = func() time.Time { tick = tick.Add(time.Second); return tick }

	if _, _, err := f.FetchFresh(context.Background(), Base+"/api/fundingRate/current"); err != nil {
		t.Fatalf("FetchFresh: %v", err)
	}
	if len(d.reqs) != 2 {
		t.Fatalf("issued %d requests, want 2", len(d.reqs))
	}
	a := d.reqs[0].Header.Get("Coinank-Apikey")
	b := d.reqs[1].Header.Get("Coinank-Apikey")
	if a == "" || b == "" {
		t.Fatalf("signature header missing: %q / %q", a, b)
	}
	if a == b {
		t.Errorf("both attempts sent the same signature %q: the retry must re-sign", a)
	}
}

// TestRefusalIsNeverCached guards the second half of the fix. The cache write
// used to run BEFORE Decode, so a refused envelope was stored as if it were
// data. A refusal must leave nothing on disk for a later read to pick up.
func TestRefusalIsNeverCached(t *testing.T) {
	dir := t.TempDir()
	d := &seqDoer{steps: []step{{status: 200, body: refusalBody}}}
	f, err := New(Options{CacheDir: dir, Client: d})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, _, err := f.Fetch(context.Background(), Base+"/api/fundingRate/current"); err == nil {
		t.Fatal("want an error")
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(ents) != 0 {
		t.Errorf("a refused body was cached: %d file(s) in %s", len(ents), dir)
	}
}

// TestSuccessAfterRefusalCachesOnlyTheGoodBody is the same guard from the other
// side: once the retry wins, the body on disk must be the SUCCESSFUL one.
func TestSuccessAfterRefusalCachesOnlyTheGoodBody(t *testing.T) {
	dir := t.TempDir()
	d := &seqDoer{steps: []step{
		{status: 200, body: transientRefusalBody},
		{status: 200, body: fundingBody},
	}}
	f, err := New(Options{CacheDir: dir, Client: d})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	url := Base + "/api/fundingRate/current"
	if _, _, err := f.Fetch(context.Background(), url); err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(ents) != 1 {
		t.Fatalf("cached %d files, want 1", len(ents))
	}
	b, err := os.ReadFile(dir + "/" + ents[0].Name())
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	// The file is an Entry whose `body` is the upstream body as a JSON string,
	// so the payload is escaped on disk: decode rather than grep the raw bytes.
	var e Entry
	if err := json.Unmarshal(b, &e); err != nil {
		t.Fatalf("Unmarshal cache entry: %v", err)
	}
	if strings.Contains(e.Body, "please sub api") {
		t.Error("the refusal body reached the cache")
	}
	if !strings.Contains(e.Body, `"symbol":"BTC"`) {
		t.Errorf("the cached body is not the successful payload: %.200s", e.Body)
	}
}

// TestRetryGivesUpAfterMaxAttempts pins the bound: a refusal that never clears
// must fail rather than loop, and the number of attempts must be exactly
// maxAttempts.
func TestRetryGivesUpAfterMaxAttempts(t *testing.T) {
	steps := make([]step, 0, maxAttempts+2)
	for i := 0; i < maxAttempts+2; i++ {
		steps = append(steps, step{status: 200, body: transientRefusalBody})
	}
	d := &seqDoer{steps: steps}
	f := newTestFetcher(t, d)

	_, _, err := f.FetchFresh(context.Background(), Base+"/api/fundingRate/current")
	if err == nil {
		t.Fatal("a refusal that never clears must surface as an error")
	}
	if len(d.reqs) != maxAttempts {
		t.Fatalf("issued %d requests, want exactly maxAttempts=%d", len(d.reqs), maxAttempts)
	}
}

// TestServerErrorIsRetried covers the other transient class: a 5xx is worth a
// retry, a 400 is not.
func TestServerErrorIsRetried(t *testing.T) {
	d := &seqDoer{steps: []step{
		{status: 502, body: ""},
		{status: 200, body: fundingBody},
	}}
	f := newTestFetcher(t, d)
	if _, _, err := f.FetchFresh(context.Background(), Base+"/api/fundingRate/current"); err != nil {
		t.Fatalf("a 502 that clears must not surface: %v", err)
	}
	if len(d.reqs) != 2 {
		t.Fatalf("issued %d requests, want 2", len(d.reqs))
	}
}

func TestClientErrorIsNotRetried(t *testing.T) {
	d := &seqDoer{steps: []step{{status: 400, body: ""}}}
	f := newTestFetcher(t, d)
	if _, _, err := f.FetchFresh(context.Background(), Base+"/api/fundingRate/current"); err == nil {
		t.Fatal("want an error")
	}
	if len(d.reqs) != 1 {
		t.Fatalf("issued %d requests, want 1: a 400 is deterministic", len(d.reqs))
	}
}

// TestCancelledContextIsNotRetried: a cancelled request is not a blip, so the
// retry must not fire and must not sleep.
func TestCancelledContextIsNotRetried(t *testing.T) {
	d := &seqDoer{steps: []step{{err: errors.New("connection reset")}}}
	f := newTestFetcher(t, d)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := f.FetchFresh(ctx, Base+"/api/fundingRate/current"); err == nil {
		t.Fatal("want an error")
	}
	if len(d.reqs) != 1 {
		t.Fatalf("issued %d requests, want 1: a cancelled context must not be retried", len(d.reqs))
	}
}

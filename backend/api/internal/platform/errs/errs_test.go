package errs

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestStatusMapping(t *testing.T) {
	cases := map[Category]int{
		CategoryValidation:          400,
		CategoryAuthorization:       403,
		CategoryCredential:          500,
		CategoryExchange:            502,
		CategoryInsufficientBalance: 422,
		CategoryRiskLimit:           409,
		CategoryRateLimit:           429,
		CategoryTimeout:             504,
		CategoryNetwork:             502,
		CategoryConflict:            409,
		CategoryNotFound:            404,
		CategoryInternal:            500,
	}
	for cat, want := range cases {
		if got := Status(cat); got != want {
			t.Errorf("Status(%q) = %d, want %d", cat, got, want)
		}
	}
	if got := Status(Category("unmodelled_failure")); got != 500 {
		t.Errorf("Status(unknown) = %d, want 500", got)
	}
}

// The wire envelope must carry code/message/request_id and never the wrapped
// cause — that is where secret material lives.
func TestEnvelopeSerializationNeverCarriesTheCause(t *testing.T) {
	cause := errors.New("pq: password authentication failed for user ops, dsn=postgres://ops:supersecret@db")
	e := Wrap(CategoryCredential, "VAULT_UNAVAILABLE", "credential store unavailable", cause)
	env := Envelope{Error: EnvelopeBody{Code: e.Code, Message: e.Message, RequestID: "req-1"}}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)
	if strings.Contains(body, "supersecret") || strings.Contains(body, "password authentication") {
		t.Fatalf("envelope leaked the cause: %s", body)
	}
	if want := `{"error":{"code":"VAULT_UNAVAILABLE","message":"credential store unavailable","request_id":"req-1"}}`; body != want {
		t.Fatalf("envelope shape drifted:\n got %s\nwant %s", body, want)
	}
}

func TestFromClassifies(t *testing.T) {
	if From(nil) != nil {
		t.Fatal("From(nil) must be nil")
	}
	inner := New(CategoryNotFound, "EXECUTION_NOT_FOUND", "execution not found")
	if got := From(inner); got != inner {
		t.Fatal("From must pass canonical errors through unchanged")
	}
	got := From(errors.New("dial tcp 10.0.0.5:5432: connect: connection refused"))
	if got.Category != CategoryInternal || got.Code != "INTERNAL" {
		t.Fatalf("arbitrary error misclassified: %+v", got)
	}
	if got.Message != "internal error" {
		t.Fatalf("arbitrary error text reached the wire message: %q", got.Message)
	}
	if got.Unwrap() == nil {
		t.Fatal("cause must be preserved for logs")
	}
}

func TestErrorMessageIncludesCauseForLogs(t *testing.T) {
	e := Wrap(CategoryNetwork, "UPSTREAM_UNREACHABLE", "upstream unreachable", errors.New("dial tcp: i/o timeout"))
	if !strings.Contains(e.Error(), "i/o timeout") || !strings.Contains(e.Error(), "UPSTREAM_UNREACHABLE") {
		t.Fatalf("log text must name code and cause: %s", e.Error())
	}
}

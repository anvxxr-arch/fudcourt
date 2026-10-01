package idempotency

import "testing"

func TestClientOrderIDDeterministic(t *testing.T) {
	// Determinism: same inputs, same id — every call, every process (objective §23).
	for range 3 {
		if got := ClientOrderID("e1", 7); got != "fud_e1_7" {
			t.Fatalf("ClientOrderID(e1, 7) = %q, want fud_e1_7", got)
		}
	}
}

func TestClientOrderIDSeparation(t *testing.T) {
	// Executions and sequences must occupy distinct id slots (objective §23).
	ids := map[string][2]any{}
	for _, ex := range []string{"e1", "e2", "e_1", "ex"} {
		for _, seq := range []int{0, 1, 2, 10, 900} {
			id := ClientOrderID(ex, seq)
			if prev, dup := ids[id]; dup {
				t.Fatalf("id collision: %q for (%v,%v) and (%s,%d)", id, prev[0], prev[1], ex, seq)
			}
			ids[id] = [2]any{ex, seq}
		}
	}
}

func TestParseClientOrderIDRoundTrip(t *testing.T) {
	for _, tc := range []struct {
		execution string
		sequence  int
	}{
		{"e1", 0},
		{"e1", 7},
		{"exec_with_underscores", 123},
		{"e", 900},
		{"e", 910},
	} {
		id := ClientOrderID(tc.execution, tc.sequence)
		gotEx, gotSeq, err := ParseClientOrderID(id)
		if err != nil {
			t.Fatalf("Parse(%q) error: %v", id, err)
		}
		if gotEx != tc.execution || gotSeq != tc.sequence {
			t.Fatalf("Parse(%q) = (%q, %d), want (%q, %d)", id, gotEx, gotSeq, tc.execution, tc.sequence)
		}
	}
}

func TestParseClientOrderIDRefusalTable(t *testing.T) {
	for _, tc := range []struct {
		name string
		id   string
	}{
		{"empty", ""},
		{"foreign binance id", "123456789"},
		{"no prefix", "e1_7"},
		{"wrong prefix", "fuds_e1_7"},
		{"prefix only", "fud_"},
		{"missing sequence", "fud_e1_"},
		{"missing execution", "fud__7"},
		{"non-numeric sequence", "fud_e1_seven"},
		{"negative sequence", "fud_e1_-7"},
		{"leading zero sequence", "fud_e1_007"},
		{"whitespace sequence", "fud_e1_7 "},
		{"trailing garbage", "fud_e1_7x"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ex, seq, err := ParseClientOrderID(tc.id)
			if err == nil {
				t.Fatalf("Parse(%q) = (%q, %d), want refusal", tc.id, ex, seq)
			}
		})
	}
	// A whitespace execution id cannot round-trip and must be refused, never
	// mis-parsed into a plausible tuple.
	if _, _, err := ParseClientOrderID(ClientOrderID("e 1", 3)); err == nil {
		t.Fatal("execution id with whitespace must be refused")
	}
}

func TestFillDedupKeyScopedByAccount(t *testing.T) {
	// DR-021 §62: the ACCOUNT scopes the fill key.
	same := FillDedupKey("acct-a", "trade-1")
	if again := FillDedupKey("acct-a", "trade-1"); again != same {
		t.Fatalf("same account + trade must dedup: %q vs %q", same, again)
	}
	if FillDedupKey("acct-b", "trade-1") == same {
		t.Fatal("same trade id on another account must NOT dedup")
	}
	if FillDedupKey("acct-a", "trade-2") == same {
		t.Fatal("different trade ids on one account must NOT dedup")
	}
	// Injectivity: no pair of components may collide (length-prefixed account).
	if FillDedupKey("a", "b:c") == FillDedupKey("a:b", "c") {
		t.Fatal("component boundaries must keep the key injective")
	}
}

// RequestID is the fourth identifier PRD §66 requires before live mode
// (execution_id, request_id, client_order_id, event_id). It is NOT a client
// order id: it names the placement REQUEST, so a retried submit is a duplicate
// request even though it maps onto the same venue order. The two id spaces
// carry different prefixes precisely so they can never be cross-parsed.

func TestRequestIDDeterministic(t *testing.T) {
	if got := RequestID("e1", 0); got != "req_e1_0" {
		t.Fatalf("RequestID = %q; want req_e1_0", got)
	}
	if got := RequestID("e-1", 7); got != "req_e-1_7" {
		t.Fatalf("RequestID = %q; want req_e-1_7", got)
	}
}

func TestParseRequestIDRoundTrip(t *testing.T) {
	for _, seq := range []int{0, 1, 100} {
		id := RequestID("e1", seq)
		gotExec, gotSeq, err := ParseRequestID(id)
		if err != nil {
			t.Fatalf("ParseRequestID(%q) err = %v", id, err)
		}
		if gotExec != "e1" || gotSeq != seq {
			t.Fatalf("ParseRequestID(%q) = (%q, %d); want (e1, %d)", id, gotExec, gotSeq, seq)
		}
	}
}

func TestParseRequestIDRefusesForeignIDs(t *testing.T) {
	for _, id := range []string{
		"", "req_", "req_e1", "req_e1_", "fud_e1_0", "e1_0",
		"req__0", "req_e 1_0", "req_e1_-1", "req_e1_00",
	} {
		if _, _, err := ParseRequestID(id); err == nil {
			t.Fatalf("ParseRequestID(%q) accepted a foreign id; want refusal", id)
		}
	}
}

// Cross-parse: a client order id must never parse as a request id and vice
// versa. This is the invariant that prevents a restart from minting a "new"
// request id for a placement that already has a venue order.
func TestRequestIDAndClientOrderIDAreDistinct(t *testing.T) {
	coID := ClientOrderID("e1", 3)
	if _, _, err := ParseRequestID(coID); err == nil {
		t.Fatalf("client order id %q must not parse as a request id", coID)
	}
	reqID := RequestID("e1", 3)
	if _, _, err := ParseClientOrderID(reqID); err == nil {
		t.Fatalf("request id %q must not parse as a client order id", reqID)
	}
	if coID == reqID {
		t.Fatalf("client order id and request id must differ: %q", coID)
	}
}

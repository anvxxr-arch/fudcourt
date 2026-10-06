package api

// Offline, deterministic test harness for the executor HTTP surface. Every
// dependency the production server needs is substituted: a MemoryStore, a paper
// venue built by the test, and a session cookie minted from a known secret with
// the session package's own HMAC format. No Postgres, no Valkey, no network,
// no real clock.
//
// The harness exists so the whole `/api/executor/*` envelope can be exercised
// end to end (route table, auth gate, response shapes, state transitions, the
// preview "creates nothing" invariant) — which is the acceptance the objective
// demands before the TS handlers can be re-pointed.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges/paper"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/platform/credentials"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/platform/session"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/repository"
)

// testSecret is a valid (>= 32 char) session secret.
const testSecret = "test-session-secret-0123456789abcdef"

// testClock is a pinned unix-millis clock seeded at a fixed instant so every
// timestamp in a test is exact and the same run reproduces byte for byte.
type testClock struct{ ms int64 }

func (c *testClock) Now() int64 { return c.ms }

// venueFactory is the test VenueFactory: one paper venue per exchange id, all
// sharing a deterministic simulator. It unseals nothing (the test's paper venue
// needs no credentials), which is exactly what makes the surface testable
// offline.
type venueFactory struct {
	venue *paper.Paper
	// sealed records what Seal received, so a test can assert plaintext is
	// sealed (never stored raw) and never returned.
	sealed []PlainCredentials
}

// AdapterSealed returns the shared paper venue (the test never stores real
// credentials).
func (f *venueFactory) AdapterSealed(context.Context, execution.ExchangeID, execution.MarketType, string) (exchanges.Exchange, error) {
	return f.venue, nil
}

// AdapterPlain returns the shared paper venue for connect/test probes.
func (f *venueFactory) AdapterPlain(context.Context, execution.ExchangeID, execution.MarketType, PlainCredentials) (exchanges.Exchange, error) {
	return f.venue, nil
}

// Seal records the plaintext and returns a placeholder envelope: the paper
// venue never reads it, and the test asserts the plaintext never leaves the
// handler in a response.
func (f *venueFactory) Seal(creds PlainCredentials) (credentials.Envelope, error) {
	f.sealed = append(f.sealed, creds)
	return credentials.Envelope{APIKey: []byte("sealed"), IV: []byte("iv"), AuthTag: []byte("tag")}, nil
}

// harness bundles one server + its dependencies.
type harness struct {
	t      *testing.T
	store  *repository.MemoryStore
	venue  *paper.Paper
	venues *venueFactory
	clock  *testClock
	srv    *Server
}

// newHarness builds the offline server. instruments may be nil (the paper venue
// then reports no tradable set and the planner refuses a missing symbol).
func newHarness(t *testing.T, instruments map[string]exchanges.Instrument, mut ...func(*paper.PaperConfig)) *harness {
	t.Helper()
	clk := &testClock{ms: 1_760_000_000_000}
	cfg := paper.PaperConfig{
		MarketType:  execution.MarketLinearPerp,
		Clock:       exchanges.FixedClock{Millis: clk.ms},
		Balances:    []execution.Balance{{Asset: "USDT", Free: "1000000", Used: "0", Total: "1000000"}},
		Marks:       map[string]string{"BTC/USDT": "100000"},
		FillRate:    "1",
		Instruments: instruments,
	}
	for _, m := range mut {
		m(&cfg)
	}
	venue, err := paper.NewPaper(cfg)
	if err != nil {
		t.Fatalf("paper.NewPaper: %v", err)
	}
	factory := &venueFactory{venue: venue}
	store := repository.NewMemoryStore()
	srv, err := New(Config{
		Store:         store,
		Venues:        factory,
		SessionSecret: testSecret,
		Live:          false,
		Now:           clk.Now,
	})
	if err != nil {
		t.Fatalf("api.New: %v", err)
	}
	return &harness{t: t, store: store, venue: venue, venues: factory, clock: clk, srv: srv}
}

// btcPerp is the instrument fixture the plan path needs (grid + bounds from the
// venue, exactly as the planner consumes them).
func btcPerp() exchanges.Instrument {
	sp := func(v string) *string { return &v }
	return exchanges.Instrument{
		Symbol: "BTC/USDT", MarketType: execution.MarketLinearPerp, Exchange: execution.ExchangeBinance,
		BaseAsset: "BTC", QuoteAsset: "USDT", SettlementAsset: "USDT",
		TickSize: "0.01", StepSize: "0.0001", MinQuantity: sp("0.0001"), MinNotional: sp("5"),
		ContractMultiplier: "1", MaxLeverage: sp("125"), MaintenanceMarginRate: sp("0.004"),
	}
}

// instrumentSet is the venue instrument map keyed by canonical symbol.
func instrumentSet() map[string]exchanges.Instrument {
	in := btcPerp()
	return map[string]exchanges.Instrument{in.Symbol: in}
}

// cookieFor mints a signed session cookie exactly as the web tier does, so the
// auth gate under test verifies a real token rather than a stub.
func cookieFor(t *testing.T, userID string, tier session.Tier) *http.Cookie {
	t.Helper()
	claims := session.Claims{
		ID: userID, Username: "tester", Tier: tier, Roles: []string{},
		Exp: time.Now().Add(time.Hour).Unix(),
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	enc := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(testSecret))
	mac.Write([]byte(enc))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return &http.Cookie{Name: session.CookieName, Value: enc + "." + sig}
}

// do issues one request through the real router. A nil cookie sends none.
func (h *harness) do(method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	h.t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	h.srv.Router().ServeHTTP(w, r)
	return w
}

// team returns a team-tier cookie for the default user.
func (h *harness) team() *http.Cookie { return cookieFor(h.t, "user-1", session.TierTeam) }

// seedExecution inserts one execution owned by userID and returns its id.
func (h *harness) seedExecution(userID string, status execution.ExecutionStatus) string {
	rec := execution.ExecutionRecord{
		UserID: userID, AccountID: "acc-1", Exchange: execution.ExchangeBinance,
		Symbol: "BTC/USDT", MarketType: execution.MarketLinearPerp,
		Side: execution.SideBuy, Intent: execution.IntentOpen,
		Status: status, Mode: execution.ModePaper,
		SizingMode: execution.SizingRiskUSD, SizingValue: "20",
		EntryDefinition:   execution.EntryDefinition{Kind: "limit", Price: "100000"},
		ExecutionStrategy: execution.StrategyLimit,
		CreatedAt:         h.clock.ms,
	}
	return h.store.SeedExecutionRecord(rec)
}

// createRequest is a valid create/preview body for the fixture venue.
func createRequest() string {
	return `{
		"accountId": "acc-1",
		"symbol": "BTC/USDT",
		"marketType": "linear_perp",
		"side": "buy",
		"intent": "open",
		"mode": "paper",
		"entry": {"type": "limit", "price": 100000},
		"stopLoss": {"type": "stop", "price": 98000},
		"takeProfits": [{"price": 106000}],
		"sizing": {"mode": "risk_usd", "amount": 20},
		"leverage": {"mode": "manual", "leverage": 5},
		"execution": {"type": "limit", "price": 100000}
	}`
}

// seedAccount stores one owned credential for the fixture user.
func (h *harness) seedAccount(userID string) string {
	rec, err := h.store.CreateCredential(context.Background(), repository.CredentialInput{
		UserID: userID, Exchange: execution.ExchangeBinance, Label: "main",
		APIKeyMasked: "abc...xyz",
		Permissions:  execution.AccountPermissions{Read: true},
		At:           h.clock.ms,
	})
	if err != nil {
		h.t.Fatalf("seedAccount: %v", err)
	}
	return rec.ID
}

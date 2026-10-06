package api

// Route-table, auth-gate and envelope parity tests for the executor HTTP
// surface. Each test names the TS route file it pins
// (frontend/web/src/app/(frontend)/api/executor/**) and asserts the exact
// envelope the TS handler/runtime produces: status code, body keys and refusal
// text. Nothing here touches Postgres, Valkey or a network — the venue is the
// in-repo paper simulator and the clock is pinned.

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges/paper"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/platform/session"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/repository"
)

// decodeBody decodes a response body into a generic map for envelope checks.
func decodeBody(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("response is not a JSON object: %v (%s)", err, body)
	}
	return out
}

// TestRoutesRegistered pins the route table: every ported path answers with
// the methods the TS route files export (a wrong method is 405 with Allow).
func TestRoutesRegistered(t *testing.T) {
	h := newHarness(t, instrumentSet())
	cookie := h.team()
	cases := []struct {
		name    string
		method  string
		path    string
		wantNot int // status the route must NOT answer with for a registered path
	}{
		{"accounts GET", http.MethodGet, "/api/executor/accounts", http.StatusNotFound},
		{"accounts POST", http.MethodPost, "/api/executor/accounts", http.StatusNotFound},
		{"account by id GET", http.MethodGet, "/api/executor/accounts/acc-x", http.StatusMethodNotAllowed},
		{"account test POST", http.MethodPost, "/api/executor/accounts/acc-x/test", http.StatusMethodNotAllowed},
		{"settings GET", http.MethodGet, "/api/executor/settings", http.StatusNotFound},
		{"settings PUT", http.MethodPut, "/api/executor/settings", http.StatusNotFound},
		{"executions GET", http.MethodGet, "/api/executor/executions", http.StatusNotFound},
		{"executions POST", http.MethodPost, "/api/executor/executions", http.StatusNotFound},
		{"execution GET", http.MethodGet, "/api/executor/executions/e-1", http.StatusMethodNotAllowed},
		{"execution start POST", http.MethodPost, "/api/executor/executions/e-1/start", http.StatusMethodNotAllowed},
		{"execution pause POST", http.MethodPost, "/api/executor/executions/e-1/pause", http.StatusMethodNotAllowed},
		{"execution resume POST", http.MethodPost, "/api/executor/executions/e-1/resume", http.StatusMethodNotAllowed},
		{"execution cancel POST", http.MethodPost, "/api/executor/executions/e-1/cancel", http.StatusMethodNotAllowed},
		{"execution orders GET", http.MethodGet, "/api/executor/executions/e-1/orders", http.StatusMethodNotAllowed},
		{"execution fills GET", http.MethodGet, "/api/executor/executions/e-1/fills", http.StatusMethodNotAllowed},
		{"execution events GET", http.MethodGet, "/api/executor/executions/e-1/events", http.StatusMethodNotAllowed},
		{"preview POST", http.MethodPost, "/api/executor/preview", http.StatusNotFound},
		{"emergency POST", http.MethodPost, "/api/executor/emergency", http.StatusNotFound},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := h.do(c.method, c.path, "", cookie)
			if w.Code == c.wantNot {
				t.Fatalf("%s %s answered %d; the route is not registered", c.method, c.path, w.Code)
			}
			if w.Code != http.StatusUnauthorized && w.Code != http.StatusOK &&
				w.Code != http.StatusNotFound && w.Code != http.StatusBadRequest &&
				w.Code != http.StatusConflict && w.Code != http.StatusInternalServerError {
				t.Fatalf("%s %s answered unexpected %d (%s)", c.method, c.path, w.Code, w.Body.String())
			}
		})
	}
}

// TestMethodGuardIsAllowHeader pins the 405 shape: an unsupported method on a
// registered path is 405 with an Allow header, matching Next's behaviour for an
// unexported method.
func TestMethodGuardIsAllowHeader(t *testing.T) {
	h := newHarness(t, instrumentSet())
	w := h.do(http.MethodDelete, "/api/executor/settings", "", h.team())
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE /settings = %d, want 405", w.Code)
	}
	if allow := w.Header().Get("Allow"); allow != "GET, PUT" {
		t.Fatalf("Allow = %q, want %q", allow, "GET, PUT")
	}
	if got := decodeBody(t, w.Body.Bytes())["error"]; got != "method_not_allowed" {
		t.Fatalf("error = %v, want method_not_allowed", got)
	}
}

// TestAuthGateDenies ports requireExecutorUser: every path refuses a request
// with no session, a forged session and a below-tier session with the SAME 401
// `{ error: 'unauthorized', detail: 'requires team tier (no session)' }`.
func TestAuthGateDenies(t *testing.T) {
	h := newHarness(t, instrumentSet())
	paths := []struct{ method, path string }{
		{http.MethodGet, "/api/executor/accounts"},
		{http.MethodGet, "/api/executor/settings"},
		{http.MethodGet, "/api/executor/executions"},
		{http.MethodPost, "/api/executor/preview"},
		{http.MethodPost, "/api/executor/emergency"},
	}
	cookies := map[string]*http.Cookie{
		"none":   nil,
		"member": cookieFor(t, "user-1", session.TierMember),
		"forged": {Name: session.CookieName, Value: "forged.payload"},
	}
	for _, p := range paths {
		for label, cookie := range cookies {
			t.Run(label+" "+p.path, func(t *testing.T) {
				w := h.do(p.method, p.path, "", cookie)
				if w.Code != http.StatusUnauthorized {
					t.Fatalf("%s %s (%s) = %d, want 401", p.method, p.path, label, w.Code)
				}
				body := decodeBody(t, w.Body.Bytes())
				if body["error"] != "unauthorized" || body["detail"] != "requires team tier (no session)" {
					t.Fatalf("401 body = %v, want the TS refusal", body)
				}
			})
		}
	}
}

// TestAccountsListEnvelope pins accounts/route.ts GET: `{ accounts: [...] }`
// with the masked credential record shape.
func TestAccountsListEnvelope(t *testing.T) {
	h := newHarness(t, instrumentSet())
	h.seedAccount("user-1")
	h.seedAccount("user-2") // another user's account must never appear
	w := h.do(http.MethodGet, "/api/executor/accounts", "", h.team())
	if w.Code != http.StatusOK {
		t.Fatalf("GET /accounts = %d (%s)", w.Code, w.Body.String())
	}
	body := decodeBody(t, w.Body.Bytes())
	accounts, ok := body["accounts"].([]any)
	if !ok {
		t.Fatalf("accounts key missing/not an array: %v", body)
	}
	if len(accounts) != 1 {
		t.Fatalf("accounts length = %d, want 1 (ownership is enforced)", len(accounts))
	}
	rec := accounts[0].(map[string]any)
	for _, key := range []string{"id", "userId", "exchange", "label", "apiKeyMasked", "permissions", "health", "createdAt", "updatedAt", "lastUsedAt", "revokedAt"} {
		if _, present := rec[key]; !present {
			t.Fatalf("account record missing key %q (got %v)", key, rec)
		}
	}
	if rec["userId"] != "user-1" {
		t.Fatalf("userId = %v, want user-1", rec["userId"])
	}
}

// TestAccountDetailAndRevoke pins accounts/[id]/route.ts: GET is
// `{ account }`, a wrong-owner id is 404 `{ error: 'account not found' }`, and
// DELETE answers `{ ok: true }` then the account is revoked.
func TestAccountDetailAndRevoke(t *testing.T) {
	h := newHarness(t, instrumentSet())
	id := h.seedAccount("user-1")

	w := h.do(http.MethodGet, "/api/executor/accounts/"+id, "", h.team())
	if w.Code != http.StatusOK {
		t.Fatalf("GET /accounts/%s = %d (%s)", id, w.Code, w.Body.String())
	}
	if _, present := decodeBody(t, w.Body.Bytes())["account"]; !present {
		t.Fatalf("GET body missing `account`: %s", w.Body.String())
	}

	w = h.do(http.MethodGet, "/api/executor/accounts/other-users-id", "", h.team())
	if w.Code != http.StatusNotFound {
		t.Fatalf("wrong-owner GET = %d, want 404", w.Code)
	}
	if got := decodeBody(t, w.Body.Bytes())["error"]; got != "account not found" {
		t.Fatalf("error = %v, want 'account not found'", got)
	}

	w = h.do(http.MethodDelete, "/api/executor/accounts/"+id, "", h.team())
	if w.Code != http.StatusOK {
		t.Fatalf("DELETE /accounts/%s = %d (%s)", id, w.Code, w.Body.String())
	}
	if ok, _ := decodeBody(t, w.Body.Bytes())["ok"].(bool); !ok {
		t.Fatalf("DELETE body = %s, want { ok: true }", w.Body.String())
	}
	rec, err := h.store.GetCredential(context.Background(), "user-1", id)
	if err != nil || rec == nil || rec.RevokedAt == nil {
		t.Fatalf("credential not revoked: rec=%+v err=%v", rec, err)
	}
}

// TestConnectAccountRejectsBadShape pins accounts/route.ts POST validation:
// `{ error: 'validation', errors: [...] }` 400 with field-named errors, and no
// credential is created.
func TestConnectAccountRejectsBadShape(t *testing.T) {
	h := newHarness(t, instrumentSet())
	w := h.do(http.MethodPost, "/api/executor/accounts",
		`{"exchange":"okx","label":"","apiKey":"","apiSecret":""}`, h.team())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("POST /accounts = %d (%s)", w.Code, w.Body.String())
	}
	body := decodeBody(t, w.Body.Bytes())
	if body["error"] != "validation" {
		t.Fatalf("error = %v, want validation", body["error"])
	}
	errs, _ := body["errors"].([]any)
	if len(errs) != 4 {
		t.Fatalf("errors = %v, want 4 field errors", errs)
	}
	accounts, _ := h.store.ListCredentials(context.Background(), "user-1")
	if len(accounts) != 0 {
		t.Fatalf("a refused connect created %d credentials", len(accounts))
	}
}

// TestConnectAccountEnvelope pins accounts/route.ts POST success:
// `{ account, metadata }` with a masked key and the secrets sealed (never
// returned).
func TestConnectAccountEnvelope(t *testing.T) {
	h := newHarness(t, instrumentSet())
	w := h.do(http.MethodPost, "/api/executor/accounts",
		`{"exchange":"binance","label":"main","apiKey":"abcdefghijklmnop","apiSecret":"supersecretvalue"}`, h.team())
	if w.Code != http.StatusOK {
		t.Fatalf("POST /accounts = %d (%s)", w.Code, w.Body.String())
	}
	body := decodeBody(t, w.Body.Bytes())
	account, _ := body["account"].(map[string]any)
	if account == nil {
		t.Fatalf("body missing `account`: %s", w.Body.String())
	}
	if masked, _ := account["apiKeyMasked"].(string); masked == "" || strings.Contains(masked, "supersecretvalue") {
		t.Fatalf("apiKeyMasked = %q is not a masked display", masked)
	}
	if strings.Contains(w.Body.String(), "supersecretvalue") || strings.Contains(w.Body.String(), "abcdefghijklmnop") {
		t.Fatalf("response leaked plaintext credential material: %s", w.Body.String())
	}
	if _, present := body["metadata"]; !present {
		t.Fatalf("body missing `metadata`: %s", w.Body.String())
	}
	if len(h.venues.sealed) != 1 {
		t.Fatalf("Seal called %d times, want 1", len(h.venues.sealed))
	}
}

// TestSettingsGetDefault pins settings/route.ts GET: `{ profile }` with the
// server-side defaults filled in for a user with no stored row.
func TestSettingsGetDefault(t *testing.T) {
	h := newHarness(t, instrumentSet())
	w := h.do(http.MethodGet, "/api/executor/settings", "", h.team())
	if w.Code != http.StatusOK {
		t.Fatalf("GET /settings = %d (%s)", w.Code, w.Body.String())
	}
	profile, _ := decodeBody(t, w.Body.Bytes())["profile"].(map[string]any)
	if profile == nil {
		t.Fatalf("body missing `profile`: %s", w.Body.String())
	}
	if profile["defaultRiskMode"] != "risk_percent" || profile["defaultMarginMode"] != "isolated" {
		t.Fatalf("defaults not filled: %v", profile)
	}
	for _, key := range []string{"defaultRisk", "maxRiskPerTradePct", "maxOpenRiskPct", "maxDailyLossPct", "maxLeverage", "defaultExecutionUrgency"} {
		if _, present := profile[key]; !present {
			t.Fatalf("profile missing %q: %v", key, profile)
		}
	}
}

// TestSettingsPutValidation pins settings/route.ts PUT: a bad value is a 400
// with the field-named error and nothing is written; a good partial update is
// merged over the defaults and echoed back.
func TestSettingsPutValidation(t *testing.T) {
	h := newHarness(t, instrumentSet())
	w := h.do(http.MethodPut, "/api/executor/settings", `{"maxLeverage":-3,"defaultMarginMode":"weird"}`, h.team())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("PUT /settings = %d (%s)", w.Code, w.Body.String())
	}
	errs, _ := decodeBody(t, w.Body.Bytes())["errors"].([]any)
	if len(errs) != 2 {
		t.Fatalf("errors = %v, want 2", errs)
	}
	stored, _ := h.store.GetRiskProfile(context.Background(), "user-1")
	if stored.DefaultRiskMode != "" {
		t.Fatalf("a refused PUT wrote a profile: %+v", stored)
	}

	w = h.do(http.MethodPut, "/api/executor/settings", `{"maxLeverage":7}`, h.team())
	if w.Code != http.StatusOK {
		t.Fatalf("PUT /settings = %d (%s)", w.Code, w.Body.String())
	}
	profile, _ := decodeBody(t, w.Body.Bytes())["profile"].(map[string]any)
	if profile["maxLeverage"] != "7" {
		t.Fatalf("maxLeverage = %v, want 7", profile["maxLeverage"])
	}
	if profile["defaultMarginMode"] != "isolated" {
		t.Fatalf("untouched key not defaulted: %v", profile)
	}
}

// TestPreExecutionReadsEnvelope pins the three execution read routes
// (executions/[id]/{route,orders,fills,events}.ts): a wrong-owner id is 404 and
// the owner's reads carry the exact envelope keys.
func TestPreExecutionReadsEnvelope(t *testing.T) {
	h := newHarness(t, instrumentSet())
	id := h.seedExecution("user-1", execution.StatusReady)

	w := h.do(http.MethodGet, "/api/executor/executions/"+id, "", h.team())
	if w.Code != http.StatusOK {
		t.Fatalf("GET /executions/%s = %d (%s)", id, w.Code, w.Body.String())
	}
	body := decodeBody(t, w.Body.Bytes())
	if _, present := body["execution"]; !present {
		t.Fatalf("missing `execution`: %s", w.Body.String())
	}
	if plan, present := body["plan"]; !present || plan != nil {
		t.Fatalf("plan = %v, want an explicit null (no plan row)", plan)
	}
	exec := body["execution"].(map[string]any)
	if exec["userId"] != "user-1" || exec["status"] != "READY" {
		t.Fatalf("execution body wrong: %v", exec)
	}

	for path, key := range map[string]string{
		"orders": "childOrders",
		"fills":  "fills",
		"events": "events",
	} {
		w := h.do(http.MethodGet, "/api/executor/executions/"+id+"/"+path, "", h.team())
		if w.Code != http.StatusOK {
			t.Fatalf("GET /%s = %d (%s)", path, w.Code, w.Body.String())
		}
		if _, present := decodeBody(t, w.Body.Bytes())[key]; !present {
			t.Fatalf("GET /%s missing key %q: %s", path, key, w.Body.String())
		}
	}

	w = h.do(http.MethodGet, "/api/executor/executions/other-id", "", h.team())
	if w.Code != http.StatusNotFound {
		t.Fatalf("wrong-owner GET = %d, want 404", w.Code)
	}
	if got := decodeBody(t, w.Body.Bytes())["error"]; got != "execution not found" {
		t.Fatalf("error = %v, want 'execution not found'", got)
	}
}

// TestListExecutionsStatusFilter pins executions/route.ts GET `?status=`: an
// unknown status is 400 `{ error: 'status', detail }`; a known one filters.
func TestListExecutionsStatusFilter(t *testing.T) {
	h := newHarness(t, instrumentSet())
	h.seedExecution("user-1", execution.StatusReady)
	h.seedExecution("user-1", execution.StatusFilled)

	w := h.do(http.MethodGet, "/api/executor/executions?status=NOPE", "", h.team())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad status = %d, want 400", w.Code)
	}
	body := decodeBody(t, w.Body.Bytes())
	if body["error"] != "status" || body["detail"] != "unknown execution status 'NOPE'" {
		t.Fatalf("bad status body = %v", body)
	}

	w = h.do(http.MethodGet, "/api/executor/executions?status=FILLED", "", h.team())
	if w.Code != http.StatusOK {
		t.Fatalf("GET /executions = %d (%s)", w.Code, w.Body.String())
	}
	execs, _ := decodeBody(t, w.Body.Bytes())["executions"].([]any)
	if len(execs) != 1 {
		t.Fatalf("filtered length = %d, want 1", len(execs))
	}
	if execs[0].(map[string]any)["status"] != "FILLED" {
		t.Fatalf("filter returned the wrong row: %v", execs[0])
	}
}

// TestLifecycleTransitions pins executions/[id]/{start,pause,resume,cancel}
// .ts: the op → target-status map and the 409 `{ error: 'invalid transition' }`
// for an inapplicable step, plus the event append on success.
func TestLifecycleTransitions(t *testing.T) {
	h := newHarness(t, instrumentSet())
	id := h.seedExecution("user-1", execution.StatusReady)

	// pause on READY is not applicable → 409 with the exact detail.
	w := h.do(http.MethodPost, "/api/executor/executions/"+id+"/pause", "", h.team())
	if w.Code != http.StatusConflict {
		t.Fatalf("pause on READY = %d, want 409", w.Code)
	}
	body := decodeBody(t, w.Body.Bytes())
	if body["error"] != "invalid transition" || body["detail"] != "pause is not applicable in status READY" {
		t.Fatalf("pause refusal = %v", body)
	}

	// start READY → RUNNING is legal and appends EXECUTION_STARTED.
	w = h.do(http.MethodPost, "/api/executor/executions/"+id+"/start", "", h.team())
	if w.Code != http.StatusOK {
		t.Fatalf("start = %d (%s)", w.Code, w.Body.String())
	}
	exec, _ := decodeBody(t, w.Body.Bytes())["execution"].(map[string]any)
	if exec["status"] != "RUNNING" {
		t.Fatalf("after start status = %v, want RUNNING", exec["status"])
	}
	events, _ := h.store.ListEvents(context.Background(), id)
	if len(events) != 1 || events[0].Name != execution.EventExecutionStarted {
		t.Fatalf("events = %+v, want one EXECUTION_STARTED", events)
	}

	// pause RUNNING → PAUSED then resume PAUSED → RUNNING.
	for _, step := range []struct{ op, want string }{{"pause", "PAUSED"}, {"resume", "RUNNING"}} {
		w = h.do(http.MethodPost, "/api/executor/executions/"+id+"/"+step.op, "", h.team())
		if w.Code != http.StatusOK {
			t.Fatalf("%s = %d (%s)", step.op, w.Code, w.Body.String())
		}
		exec, _ = decodeBody(t, w.Body.Bytes())["execution"].(map[string]any)
		if exec["status"] != step.want {
			t.Fatalf("after %s status = %v, want %s", step.op, exec["status"], step.want)
		}
	}

	// cancel while RUNNING goes through CANCEL_REQUESTED (§57), never CANCELLED
	// directly.
	w = h.do(http.MethodPost, "/api/executor/executions/"+id+"/cancel", "", h.team())
	if w.Code != http.StatusOK {
		t.Fatalf("cancel = %d (%s)", w.Code, w.Body.String())
	}
	exec, _ = decodeBody(t, w.Body.Bytes())["execution"].(map[string]any)
	if exec["status"] != "CANCEL_REQUESTED" {
		t.Fatalf("after cancel status = %v, want CANCEL_REQUESTED", exec["status"])
	}
}

// TestCancelNeverClosesPosition pins the §75/§128.20 invariant at the route
// level: cancelling a never-started execution cancels outright and places no
// exit order of any kind (no child order is created).
func TestCancelNeverClosesPosition(t *testing.T) {
	h := newHarness(t, instrumentSet())
	id := h.seedExecution("user-1", execution.StatusReady)
	w := h.do(http.MethodPost, "/api/executor/executions/"+id+"/cancel", "", h.team())
	if w.Code != http.StatusOK {
		t.Fatalf("cancel = %d (%s)", w.Code, w.Body.String())
	}
	exec, _ := decodeBody(t, w.Body.Bytes())["execution"].(map[string]any)
	if exec["status"] != "CANCELLED" {
		t.Fatalf("cancel on READY = %v, want CANCELLED", exec["status"])
	}
	children, _ := h.store.ListChildOrders(context.Background(), id)
	if len(children) != 0 {
		t.Fatalf("cancel created %d child orders; it must never close a position", len(children))
	}
}

// TestPreviewCreatesNothing pins preview/route.ts §98: a preview returns
// `{ preview, liveEnabled }` and persists NOTHING — no execution row, no plan,
// no event, no child order.
func TestPreviewCreatesNothing(t *testing.T) {
	h := newHarness(t, instrumentSet())
	accID := h.seedAccount("user-1")
	reqBody := strings.Replace(createRequest(), `"accountId": "acc-1"`, `"accountId": "`+accID+`"`, 1)
	before, _ := h.store.ListExecutions(context.Background(), "user-1", nil, 100)

	w := h.do(http.MethodPost, "/api/executor/preview", reqBody, h.team())
	if w.Code != http.StatusOK {
		t.Fatalf("POST /preview = %d (%s)", w.Code, w.Body.String())
	}
	body := decodeBody(t, w.Body.Bytes())
	if _, present := body["preview"]; !present {
		t.Fatalf("missing `preview`: %s", w.Body.String())
	}
	if _, present := body["liveEnabled"]; !present {
		t.Fatalf("missing `liveEnabled`: %s", w.Body.String())
	}
	preview, _ := body["preview"].(map[string]any)
	if preview == nil {
		t.Fatalf("preview not an object: %v", body["preview"])
	}
	for _, key := range []string{"plan", "expectedLossAtStop", "expectedProfitAtTarget", "conflicts", "warnings", "mode"} {
		if _, present := preview[key]; !present {
			t.Fatalf("preview missing key %q: %v", key, preview)
		}
	}
	after, _ := h.store.ListExecutions(context.Background(), "user-1", nil, 100)
	if len(after) != len(before) {
		t.Fatalf("preview created %d executions (§98 forbids it)", len(after)-len(before))
	}
}

// TestPreviewRejectsBadShape pins the shared shape validation: a bad
// marketType/side/intent/mode is the 400 `{ error: 'validation', errors }`
// envelope, exactly as validateRequestShape produces.
func TestPreviewRejectsBadShape(t *testing.T) {
	h := newHarness(t, instrumentSet())
	w := h.do(http.MethodPost, "/api/executor/preview",
		`{"accountId":"","marketType":"futures","side":"up","intent":"hold","mode":"maybe"}`, h.team())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad-shape preview = %d (%s)", w.Code, w.Body.String())
	}
	body := decodeBody(t, w.Body.Bytes())
	if body["error"] != "validation" {
		t.Fatalf("error = %v, want validation", body["error"])
	}
	errs, _ := body["errors"].([]any)
	if len(errs) != 5 {
		t.Fatalf("errors = %v, want 5 (accountId, marketType, side, intent, mode)", errs)
	}
}

// TestCreateRefusesPreviewMode pins createExecution's preview-mode refusal: a
// `mode: 'preview'` create is a 400 `{ error: 'invalid mode', detail }` and
// nothing is written.
func TestCreateRefusesPreviewMode(t *testing.T) {
	h := newHarness(t, instrumentSet())
	h.seedAccount("user-1")
	body := strings.Replace(createRequest(), `"mode": "paper"`, `"mode": "preview"`, 1)
	w := h.do(http.MethodPost, "/api/executor/executions", body, h.team())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("preview-mode create = %d (%s)", w.Code, w.Body.String())
	}
	resp := decodeBody(t, w.Body.Bytes())
	if resp["error"] != "invalid mode" {
		t.Fatalf("error = %v, want invalid mode", resp["error"])
	}
	execs, _ := h.store.ListExecutions(context.Background(), "user-1", nil, 10)
	if len(execs) != 0 {
		t.Fatalf("a refused create wrote %d rows", len(execs))
	}
}

// TestCreateRefusesLiveWithoutKillSwitch pins the §108 kill switch: with
// FUDCOURT_EXECUTOR_LIVE unset (Live=false) a live create is 403
// `{ error: 'live trading disabled' }` and nothing is written.
func TestCreateRefusesLiveWithoutKillSwitch(t *testing.T) {
	h := newHarness(t, instrumentSet())
	h.seedAccount("user-1")
	body := strings.Replace(createRequest(), `"mode": "paper"`, `"mode": "live"`, 1)
	w := h.do(http.MethodPost, "/api/executor/executions", body, h.team())
	if w.Code != http.StatusForbidden {
		t.Fatalf("live create = %d (%s)", w.Code, w.Body.String())
	}
	if got := decodeBody(t, w.Body.Bytes())["error"]; got != "live trading disabled" {
		t.Fatalf("error = %v, want live trading disabled", got)
	}
	execs, _ := h.store.ListExecutions(context.Background(), "user-1", nil, 10)
	if len(execs) != 0 {
		t.Fatalf("a refused live create wrote %d rows", len(execs))
	}
}

// TestCreateHealthFromMemoryStore is a sanity guard that the seeded memory
// store reports the same shape the handlers consume (guards against a drift
// between the fixture store and the port contract).
func TestCreateHealthFromMemoryStore(t *testing.T) {
	var _ repository.ExecutorStore = repository.NewMemoryStore()
}

// TestCreateExecutionEnvelope pins executions/route.ts POST: the created
// execution is READY, its immutable plan is returned, the strategy state is
// persisted under the new id and the three creation events are appended in
// order (EXECUTION_CREATED, RISK_CALCULATED, PLAN_CREATED).
func TestCreateExecutionEnvelope(t *testing.T) {
	h := newHarness(t, instrumentSet())
	accID := h.seedAccount("user-1")
	body := strings.Replace(createRequest(), `"accountId": "acc-1"`, `"accountId": "`+accID+`"`, 1)

	w := h.do(http.MethodPost, "/api/executor/executions", body, h.team())
	if w.Code != http.StatusOK {
		t.Fatalf("POST /executions = %d (%s)", w.Code, w.Body.String())
	}
	resp := decodeBody(t, w.Body.Bytes())
	exec, _ := resp["execution"].(map[string]any)
	if exec == nil {
		t.Fatalf("missing `execution`: %s", w.Body.String())
	}
	if exec["status"] != "READY" || exec["mode"] != "paper" || exec["userId"] != "user-1" {
		t.Fatalf("created execution wrong: %v", exec)
	}
	if exec["executionStrategy"] != "limit" || exec["accountId"] != accID {
		t.Fatalf("created execution fields wrong: %v", exec)
	}
	plan, _ := resp["plan"].(map[string]any)
	if plan == nil {
		t.Fatalf("missing `plan`: %s", w.Body.String())
	}
	for _, key := range []string{"venueKey", "quantity", "notional", "risk", "instrument", "sizingMode", "marketSnapshot"} {
		if _, present := plan[key]; !present {
			t.Fatalf("plan missing key %q: %v", key, plan)
		}
	}
	id := exec["id"].(string)
	if plan["venueKey"] != "binance:linear_perp:BTC/USDT" {
		t.Fatalf("venueKey = %v", plan["venueKey"])
	}
	// Strategy state persisted (the seeded PRNG/child-id base embeds the id).
	rec, err := h.store.GetExecution(context.Background(), "user-1", id)
	if err != nil || rec == nil || rec.EngineState == nil {
		t.Fatalf("engine state not persisted: rec=%+v err=%v", rec, err)
	}
	events, _ := h.store.ListEvents(context.Background(), id)
	want := []execution.ExecutionEventName{
		execution.EventExecutionCreated, execution.EventRiskCalculated, execution.EventPlanCreated,
	}
	if len(events) != len(want) {
		t.Fatalf("events = %d, want %d (%+v)", len(events), len(want), events)
	}
	for i, name := range want {
		if events[i].Name != name {
			t.Fatalf("event[%d] = %s, want %s", i, events[i].Name, name)
		}
	}
	// The plan read back through GET /executions/{id} is the persisted snapshot.
	w = h.do(http.MethodGet, "/api/executor/executions/"+id, "", h.team())
	if w.Code != http.StatusOK {
		t.Fatalf("GET created = %d (%s)", w.Code, w.Body.String())
	}
	got, _ := decodeBody(t, w.Body.Bytes())["plan"].(map[string]any)
	if got == nil || got["venueKey"] != plan["venueKey"] {
		t.Fatalf("persisted plan mismatch: %v", got)
	}
}

// TestEmergencyStopEnvelope pins emergency/route.ts POST: `{ stopped,
// cancelledOrders }`, learned from managed rows only, and it never closes a
// position (no exit order is placed).
func TestEmergencyStopEnvelope(t *testing.T) {
	h := newHarness(t, instrumentSet())
	id := h.seedExecution("user-1", execution.StatusRunning)
	h.seedExecution("user-2", execution.StatusRunning) // another user is untouched

	w := h.do(http.MethodPost, "/api/executor/emergency", "", h.team())
	if w.Code != http.StatusOK {
		t.Fatalf("POST /emergency = %d (%s)", w.Code, w.Body.String())
	}
	body := decodeBody(t, w.Body.Bytes())
	stopped, _ := body["stopped"].(float64)
	if stopped != 1 {
		t.Fatalf("stopped = %v, want 1 (ownership is enforced)", body["stopped"])
	}
	if _, present := body["cancelledOrders"]; !present {
		t.Fatalf("missing cancelledOrders: %s", w.Body.String())
	}
	rec, _ := h.store.GetExecution(context.Background(), "user-1", id)
	if rec == nil || rec.Status != execution.StatusStopped {
		t.Fatalf("execution not stopped: %+v", rec)
	}
	children, _ := h.store.ListChildOrders(context.Background(), id)
	if len(children) != 0 {
		t.Fatalf("emergency stop created orders; it must never close a position")
	}
}

// TestEmergencyStopBadAccountID pins the emergency validation:
// `accountId` present but not a string is the validation envelope.
func TestEmergencyStopBadAccountID(t *testing.T) {
	h := newHarness(t, instrumentSet())
	w := h.do(http.MethodPost, "/api/executor/emergency", `{"accountId": 42}`, h.team())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad accountId = %d (%s)", w.Code, w.Body.String())
	}
	if got := decodeBody(t, w.Body.Bytes())["error"]; got != "validation" {
		t.Fatalf("error = %v, want validation", got)
	}
}

// TestPlannerRefusalIsValidationEnvelope pins the planner-refusal path shared
// by preview/route.ts and executions/route.ts: a request that passes SHAPE
// validation but fails PLANNING (risk sizing with no stop, PRD §38) answers the
// 400 `{ error: 'validation', errors: [...] }` envelope carrying the
// field-named planner message — never a single concatenated string.
func TestPlannerRefusalIsValidationEnvelope(t *testing.T) {
	h := newHarness(t, instrumentSet())
	accID := h.seedAccount("user-1")
	// risk_percent sizing with NO stopLoss → the planner refuses (§38).
	body := `{
		"accountId": "` + accID + `", "symbol": "BTC/USDT", "marketType": "linear_perp",
		"side": "buy", "intent": "open", "mode": "paper",
		"entry": {"type": "limit", "price": 100000},
		"takeProfits": [{"price": 106000}],
		"sizing": {"mode": "risk_usd", "value": 20},
		"leverage": {"mode": "manual", "leverage": 5},
		"execution": {"type": "limit", "price": 100000}
	}`
	for _, path := range []string{"/api/executor/preview", "/api/executor/executions"} {
		w := h.do(http.MethodPost, path, body, h.team())
		if w.Code != http.StatusBadRequest {
			t.Fatalf("POST %s = %d (%s)", path, w.Code, w.Body.String())
		}
		resp := decodeBody(t, w.Body.Bytes())
		if resp["error"] != "validation" {
			t.Fatalf("POST %s error = %v, want validation", path, resp["error"])
		}
		errs, ok := resp["errors"].([]any)
		if !ok || len(errs) == 0 {
			t.Fatalf("POST %s errors = %v, want a non-empty field-named list", path, resp["errors"])
		}
		if !strings.Contains(errs[0].(string), "stopLoss") {
			t.Fatalf("POST %s error[0] = %v, want it to name stopLoss", path, errs[0])
		}
	}
	execs, _ := h.store.ListExecutions(context.Background(), "user-1", nil, 10)
	if len(execs) != 0 {
		t.Fatalf("a refused plan wrote %d rows", len(execs))
	}
}

// TestInvalidJSONBodyEnvelope pins the bare `{ error: 'invalid JSON body' }`
// 400 that every TS route handler returns from its req.json() catch block (and
// which carries NO `detail` key).
func TestInvalidJSONBodyEnvelope(t *testing.T) {
	h := newHarness(t, instrumentSet())
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/api/executor/preview"},
		{http.MethodPost, "/api/executor/executions"},
		{http.MethodPost, "/api/executor/accounts"},
		{http.MethodPut, "/api/executor/settings"},
	} {
		for _, body := range []string{"", "{not json"} {
			w := h.do(tc.method, tc.path, body, h.team())
			if w.Code != http.StatusBadRequest {
				t.Fatalf("%s %s (body=%q) = %d, want 400", tc.method, tc.path, body, w.Code)
			}
			resp := decodeBody(t, w.Body.Bytes())
			if resp["error"] != "invalid JSON body" {
				t.Fatalf("%s %s (body=%q) error = %v, want 'invalid JSON body'", tc.method, tc.path, body, resp["error"])
			}
			if _, present := resp["detail"]; present {
				t.Fatalf("invalid-JSON body carries a `detail` key the TS literal does not: %v", resp)
			}
		}
	}
}

// TestConnectRefusesWithdrawalKey pins §43: a key whose restrictions report
// withdraw:true is refused with the 400 `{ error: 'withdrawal permission not
// supported' }` body, and no credential is created.
func TestConnectRefusesWithdrawalKey(t *testing.T) {
	h := newHarness(t, instrumentSet(), func(c *paper.PaperConfig) { c.WithdrawPermission = true })
	w := h.do(http.MethodPost, "/api/executor/accounts",
		`{"exchange":"bybit","label":"main","apiKey":"abcdefghijkl","apiSecret":"secretmaterial"}`, h.team())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("withdraw-capable connect = %d (%s)", w.Code, w.Body.String())
	}
	resp := decodeBody(t, w.Body.Bytes())
	if resp["error"] != "withdrawal permission not supported" {
		t.Fatalf("error = %v, want withdrawal permission not supported", resp["error"])
	}
	accounts, _ := h.store.ListCredentials(context.Background(), "user-1")
	if len(accounts) != 0 {
		t.Fatalf("a refused key created %d credentials", len(accounts))
	}
}

// TestTestAccountProbeFailureEnvelope pins accounts/[id]/test/route.ts: a probe
// failure answers the 502 `{ error: 'credential check failed', detail, category }`
// envelope and the credential health is refreshed from the failure category.
func TestTestAccountProbeFailureEnvelope(t *testing.T) {
	h := newHarness(t, instrumentSet(), func(c *paper.PaperConfig) { c.TimeoutCalls = 10 })
	id := h.seedAccount("user-1")
	w := h.do(http.MethodPost, "/api/executor/accounts/"+id+"/test", "", h.team())
	if w.Code != http.StatusBadGateway {
		t.Fatalf("test = %d (%s), want 502", w.Code, w.Body.String())
	}
	resp := decodeBody(t, w.Body.Bytes())
	if resp["error"] != "credential check failed" {
		t.Fatalf("error = %v, want 'credential check failed'", resp["error"])
	}
	for _, key := range []string{"detail", "category"} {
		if _, present := resp[key]; !present {
			t.Fatalf("502 body missing %q: %v", key, resp)
		}
	}
	rec, _ := h.store.GetCredential(context.Background(), "user-1", id)
	if rec == nil || rec.Health != execution.HealthUnknown {
		t.Fatalf("health = %+v, want UNKNOWN for a network_retryable failure", rec)
	}
}

// TestTestAccountMissingIs404 pins that testing a revoked/absent account is the
// plain 404, never a 502 (the account does not exist for this caller).
func TestTestAccountMissingIs404(t *testing.T) {
	h := newHarness(t, instrumentSet())
	w := h.do(http.MethodPost, "/api/executor/accounts/nope/test", "", h.team())
	if w.Code != http.StatusNotFound {
		t.Fatalf("test missing = %d, want 404", w.Code)
	}
	if got := decodeBody(t, w.Body.Bytes())["error"]; got != "account not found" {
		t.Fatalf("error = %v, want 'account not found'", got)
	}
}

// TestPreviewMissingAccountAndSymbol pins the buildPlanContext refusals:
// an unknown account is the 404 and a symbol the venue does not list is the 400
// `{ error: 'symbol not supported', detail }`.
func TestPreviewMissingAccountAndSymbol(t *testing.T) {
	h := newHarness(t, instrumentSet())
	w := h.do(http.MethodPost, "/api/executor/preview", createRequest(), h.team())
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown account = %d (%s), want 404", w.Code, w.Body.String())
	}
	if got := decodeBody(t, w.Body.Bytes())["error"]; got != "account not found" {
		t.Fatalf("error = %v, want 'account not found'", got)
	}

	accID := h.seedAccount("user-1")
	body := strings.Replace(createRequest(), `"accountId": "acc-1"`, `"accountId": "`+accID+`"`, 1)
	body = strings.Replace(body, `"symbol": "BTC/USDT"`, `"symbol": "DOGE/USDT"`, 1)
	w = h.do(http.MethodPost, "/api/executor/preview", body, h.team())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown symbol = %d (%s), want 400", w.Code, w.Body.String())
	}
	resp := decodeBody(t, w.Body.Bytes())
	if resp["error"] != "symbol not supported" {
		t.Fatalf("error = %v, want 'symbol not supported'", resp["error"])
	}
	if detail, _ := resp["detail"].(string); !strings.Contains(detail, "DOGE/USDT is not a linear_perp market on binance") {
		t.Fatalf("detail = %q, want the TS sentence", resp["detail"])
	}
}

// TestPreviewUnhealthyCredentialIs409 pins buildPlanContext's health gate:
// a REVOKED/INVALID account is the 409 `{ error: 'credential not healthy' }`.
func TestPreviewUnhealthyCredentialIs409(t *testing.T) {
	h := newHarness(t, instrumentSet())
	accID := h.seedAccount("user-1")
	if err := h.store.UpdateCredentialHealth(context.Background(), "user-1", accID, execution.HealthInvalid, h.clock.ms); err != nil {
		t.Fatalf("UpdateCredentialHealth: %v", err)
	}
	body := strings.Replace(createRequest(), `"accountId": "acc-1"`, `"accountId": "`+accID+`"`, 1)
	w := h.do(http.MethodPost, "/api/executor/preview", body, h.team())
	if w.Code != http.StatusConflict {
		t.Fatalf("unhealthy account = %d (%s), want 409", w.Code, w.Body.String())
	}
	resp := decodeBody(t, w.Body.Bytes())
	if resp["error"] != "credential not healthy" || resp["detail"] != "account health is INVALID" {
		t.Fatalf("409 body = %v", resp)
	}
}

// TestEventsPayloadShape pins executions/[id]/events/route.ts: each event is the
// wire ExecutionEventRecord with a store-assigned id
// (`evt_<executionId>_<seq>`) and a non-null payload object.
func TestEventsPayloadShape(t *testing.T) {
	h := newHarness(t, instrumentSet())
	id := h.seedExecution("user-1", execution.StatusReady)
	if _, err := h.store.AppendEvent(context.Background(), execution.ExecutionEventRecord{
		ExecutionID: id, Name: execution.EventExecutionCreated,
		Payload: map[string]any{"mode": "paper"}, CreatedAt: h.clock.ms,
	}); err != nil {
		t.Fatalf("AppendEvent: %v", err)
	}
	w := h.do(http.MethodGet, "/api/executor/executions/"+id+"/events", "", h.team())
	if w.Code != http.StatusOK {
		t.Fatalf("GET events = %d (%s)", w.Code, w.Body.String())
	}
	events, _ := decodeBody(t, w.Body.Bytes())["events"].([]any)
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
	ev := events[0].(map[string]any)
	if ev["id"] != "evt_"+id+"_1" || ev["name"] != "EXECUTION_CREATED" {
		t.Fatalf("event = %v, want the store-assigned id and the name", ev)
	}
	if payload, ok := ev["payload"].(map[string]any); !ok || payload["mode"] != "paper" {
		t.Fatalf("payload = %v, want the event payload object", ev["payload"])
	}
}

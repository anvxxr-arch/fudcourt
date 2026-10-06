package notify

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/core/execution"
)

// ---------------------------------------------------------------------------
// policy: the notifiable set may only ever be a SUBSET of the immutable
// event vocabulary. A name here that is not in enums.go would be a notification
// for an event no producer can emit — a silent lie.
// ---------------------------------------------------------------------------

func TestNotifiableIsSubsetOfEventVocabulary(t *testing.T) {
	known := make(map[execution.ExecutionEventName]bool, len(execution.ExecutionEventNames))
	for _, n := range execution.ExecutionEventNames {
		known[n] = true
	}
	for name := range notifiable {
		if !known[name] {
			t.Errorf("notifiable event %q is not in execution.ExecutionEventNames — a notification for an event the executor cannot emit", name)
		}
	}
}

func TestPRD120MappedEventsAreAllNotifiable(t *testing.T) {
	// PRD §120's list, as mapped onto the vocabulary (see policy.go).
	for _, name := range []execution.ExecutionEventName{
		execution.EventExecutionStarted,
		execution.EventExecutionCompleted,
		execution.EventExecutionPaused,
		execution.EventExecutionFailed,
		execution.EventExecutionRiskStopped,
	} {
		if !Notifiable(name) {
			t.Errorf("PRD §120 event %q is not notifiable", name)
		}
	}
}

func TestGapsAreRecorded(t *testing.T) {
	// The four PRD §120 events with no vocabulary counterpart must stay
	// recorded: an empty Gaps would mean the shortfall was silently dropped.
	if len(Gaps) != 4 {
		t.Fatalf("Gaps has %d entries, want 4 (credential invalid, exchange disconnected, SL triggered, TP filled)", len(Gaps))
	}
	for _, g := range Gaps {
		if !strings.Contains(g, "PRD §120") {
			t.Errorf("gap %q does not cite PRD §120", g)
		}
	}
}

func TestFormatNonNotifiableIsDropped(t *testing.T) {
	ev := execution.ExecutionEventRecord{Name: execution.EventOrderSubmitted, Payload: map[string]any{"orderId": "1"}}
	if text, ok := Format(ev); ok || text != "" {
		t.Fatalf("Format(non-notifiable) = (%q, %v), want (\"\", false)", text, ok)
	}
}

func TestFormatIsStableAndDropsAbsentFields(t *testing.T) {
	ev := execution.ExecutionEventRecord{
		ID:          "evt_exec_7",
		ExecutionID: "exec-7",
		Name:        execution.EventExecutionFailed,
		Payload: map[string]any{
			"reason":  "venue timeout",
			"message": "deadline exceeded",
			"empty":   nil,   // absent, never rendered as "null"
			"blank":   "   ", // whitespace-only is absent too
		},
		CreatedAt: 1_760_000_000_000,
	}
	text, ok := Format(ev)
	if !ok {
		t.Fatal("Format(notifiable) = false")
	}
	for _, want := range []string{"FUDCourt", "EXECUTION_FAILED", "execution exec-7", "message=deadline exceeded", "reason=venue timeout", "at 2025-10-09T08:53:20Z"} {
		if !strings.Contains(text, want) {
			t.Errorf("formatted message missing %q\n--- got ---\n%s", want, text)
		}
	}
	for _, unwanted := range []string{"null", "empty=", "blank=", "evt_exec_7"} {
		if strings.Contains(text, unwanted) {
			t.Errorf("formatted message should not contain %q\n--- got ---\n%s", unwanted, text)
		}
	}
	// Determinism: identical input, identical bytes (payload keys are sorted).
	again, _ := Format(ev)
	if again != text {
		t.Errorf("Format is not deterministic:\n%q\n%q", text, again)
	}
	// Sorted: "message" precedes "reason".
	if strings.Index(text, "message=") > strings.Index(text, "reason=") {
		t.Error("payload keys are not sorted")
	}
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

func TestNewRefusesIncompleteConfig(t *testing.T) {
	if _, err := New(Config{Token: "", ChatID: "1"}); !errors.Is(err, ErrNotConfigured) {
		t.Errorf("empty token: err = %v, want ErrNotConfigured", err)
	}
	if _, err := New(Config{Token: "t", ChatID: ""}); !errors.Is(err, ErrNotConfigured) {
		t.Errorf("empty chat id: err = %v, want ErrNotConfigured", err)
	}
}

func TestFromEnvDisabledVersusHalfConfigured(t *testing.T) {
	tg, on, err := FromEnv(func(string) string { return "" })
	if tg != nil || on || err != nil {
		t.Fatalf("both keys empty: tg=%v on=%v err=%v, want nil/false/nil (a disabled channel is not an error)", tg, on, err)
	}
	env := map[string]string{EnvBotToken: "tok"}
	_, on, err = FromEnv(func(k string) string { return env[k] })
	if on || err == nil {
		t.Fatalf("half-configured: on=%v err=%v, want false + error", on, err)
	}
	env[EnvChatID] = "-100123"
	tg, on, err = FromEnv(func(k string) string { return env[k] })
	if !on || err != nil || tg == nil {
		t.Fatalf("fully configured: tg=%v on=%v err=%v, want a channel", tg, on, err)
	}
	if tg.ChatID() != "-100123" {
		t.Errorf("ChatID() = %q, want -100123", tg.ChatID())
	}
}

func TestSendPostsToBotAPIPath(t *testing.T) {
	var gotPath string
	var gotBody sendMessageBody
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":3297,"chat":{"id":722947356}}}`))
	}))
	defer srv.Close()

	tg, err := New(Config{Token: "TESTTOKEN", ChatID: "722947356", Endpoint: srv.URL, HTTPClient: srv.Client()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	res, err := tg.Send(context.Background(), "hello")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if res.MessageID != 3297 || res.ChatID != 722947356 {
		t.Errorf("Result = %+v, want {3297 722947356}", res)
	}
	if gotPath != "/botTESTTOKEN/sendMessage" {
		t.Errorf("path = %q, want /botTESTTOKEN/sendMessage", gotPath)
	}
	if gotBody.ChatID != "722947356" || gotBody.Text != "hello" {
		t.Errorf("body = %+v, want chat_id 722947356 / text hello", gotBody)
	}
}

func TestSendReportsTelegramRefusal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ok":false,"description":"Bad Request: chat not found"}`))
	}))
	defer srv.Close()
	tg, _ := New(Config{Token: "T", ChatID: "1", Endpoint: srv.URL, HTTPClient: srv.Client()})
	_, err := tg.Send(context.Background(), "x")
	if err == nil || !strings.Contains(err.Error(), "chat not found") {
		t.Fatalf("err = %v, want a refusal carrying the Telegram description", err)
	}
}

func TestSendTruncatesToTelegramLimit(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var b sendMessageBody
		_ = json.Unmarshal(raw, &b)
		got = b.Text
		_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":1,"chat":{"id":1}}}`))
	}))
	defer srv.Close()
	tg, _ := New(Config{Token: "T", ChatID: "1", Endpoint: srv.URL, HTTPClient: srv.Client()})
	if _, err := tg.Send(context.Background(), strings.Repeat("é", 5000)); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if len(got) > maxTextLen {
		t.Errorf("body is %d bytes, want <= %d", len(got), maxTextLen)
	}
	if !strings.HasSuffix(got, "…[truncated]") {
		t.Error("a truncated message must say so")
	}
}

func TestTransportErrorNeverLeaksTheToken(t *testing.T) {
	const secret = "SUPERSECRETTOKEN"
	tg, _ := New(Config{Token: secret, ChatID: "1", Endpoint: "http://127.0.0.1:1"})
	_, err := tg.Send(context.Background(), "x")
	if err == nil {
		t.Fatal("want a transport error")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("transport error leaked the token: %v", err)
	}
}

// ---------------------------------------------------------------------------
// observer
// ---------------------------------------------------------------------------

type recorder struct {
	mu   sync.Mutex
	got  []string
	done chan string
}

func newRecorder() *recorder { return &recorder{done: make(chan string, 8)} }

func (r *recorder) Send(_ context.Context, text string) (Result, error) {
	r.mu.Lock()
	r.got = append(r.got, text)
	r.mu.Unlock()
	select {
	case r.done <- text:
	default:
	}
	return Result{MessageID: 1, ChatID: 2}, nil
}

func TestObserverDeliversNotifiableAndIgnoresTheRest(t *testing.T) {
	rec := newRecorder()
	obs := Observer(rec, slog.New(slog.NewTextHandler(io.Discard, nil)), time.Second)

	// A non-notifiable event must produce nothing at all.
	obs(execution.ExecutionEventRecord{Name: execution.EventOrderSubmitted, ExecutionID: "e1"})
	// A notifiable one must arrive.
	obs(execution.ExecutionEventRecord{
		Name:        execution.EventExecutionCompleted,
		ExecutionID: "e2",
		Payload:     map[string]any{"status": "completed"},
		CreatedAt:   1_760_000_000_000,
	})

	select {
	case text := <-rec.done:
		if !strings.Contains(text, "EXECUTION_COMPLETED") || !strings.Contains(text, "execution e2") {
			t.Fatalf("delivered the wrong message: %q", text)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("notifiable event was never delivered")
	}

	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.got) != 1 {
		t.Fatalf("delivered %d messages, want exactly 1 (ORDER_SUBMITTED must be silent)", len(rec.got))
	}
}

func TestObserverNeverBlocksOnASlowChannel(t *testing.T) {
	slow := &blockingSender{release: make(chan struct{})}
	obs := Observer(slow, slog.New(slog.NewTextHandler(io.Discard, nil)), 50*time.Millisecond)

	start := time.Now()
	obs(execution.ExecutionEventRecord{Name: execution.EventExecutionFailed, ExecutionID: "e3"})
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Fatalf("observer blocked for %s — delivery must never delay the append", elapsed)
	}
	close(slow.release)
}

type blockingSender struct{ release chan struct{} }

func (b *blockingSender) Send(ctx context.Context, _ string) (Result, error) {
	select {
	case <-b.release:
		return Result{}, nil
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
}

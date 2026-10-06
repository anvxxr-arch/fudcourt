package telegram

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// newStub returns a server that answers any /bot<token>/<method> path with the
// supplied handler, plus a client bound to it.
func newStub(t *testing.T, handler func(method string, body map[string]any) (int, string)) (*Client, *[]string) {
	t.Helper()
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) < 2 || !strings.HasPrefix(parts[0], "bot") {
			http.Error(w, "bad path", http.StatusNotFound)
			return
		}
		method := parts[1]
		seen = append(seen, method)
		var body map[string]any
		raw, _ := io.ReadAll(r.Body)
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
		code, resp := handler(method, body)
		w.WriteHeader(code)
		_, _ = w.Write([]byte(resp))
	}))
	t.Cleanup(srv.Close)
	return NewWithEndpoint("T0KEN", srv.URL, srv.Client()), &seen
}

func TestGetMe(t *testing.T) {
	c, _ := newStub(t, func(method string, _ map[string]any) (int, string) {
		if method != "getMe" {
			t.Errorf("method = %q", method)
		}
		return 200, `{"ok":true,"result":{"id":7865832527,"is_bot":true,"username":"fudbase_bot","first_name":"FUDZIE"}}`
	})
	me, err := c.GetMe(context.Background())
	if err != nil {
		t.Fatalf("GetMe: %v", err)
	}
	if me.Username != "fudbase_bot" || me.ID != 7865832527 || !me.IsBot {
		t.Errorf("me = %+v", me)
	}
}

func TestSendMessageSendsChatAndText(t *testing.T) {
	var gotChat float64
	var gotText string
	c, _ := newStub(t, func(_ string, body map[string]any) (int, string) {
		gotChat, _ = body["chat_id"].(float64)
		gotText, _ = body["text"].(string)
		return 200, `{"ok":true,"result":{"message_id":5,"chat":{"id":-1004344241972}}}`
	})
	msg, err := c.SendMessage(context.Background(), -1004344241972, "hello", SendOptions{ParseMode: "HTML"})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if gotChat != -1004344241972 || gotText != "hello" {
		t.Errorf("wire body: chat=%v text=%q", gotChat, gotText)
	}
	if msg.MessageID != 5 {
		t.Errorf("message id = %d", msg.MessageID)
	}
}

func TestAPIRefusalBecomesError(t *testing.T) {
	c, _ := newStub(t, func(string, map[string]any) (int, string) {
		return 401, `{"ok":false,"error_code":401,"description":"Unauthorized"}`
	})
	if _, err := c.GetMe(context.Background()); err == nil {
		t.Fatal("expected an error on ok:false")
	} else {
		var apiErr *APIError
		if !asAPIError(err, &apiErr) || apiErr.Code != 401 {
			t.Errorf("err = %v, want *APIError with Code 401", err)
		}
	}
}

func TestTransportErrorRedactsToken(t *testing.T) {
	// Point at a closed port so the request fails at transport.
	c := NewWithEndpoint("SECRET-TOKEN", "http://127.0.0.1:1", &http.Client{})
	_, err := c.GetMe(context.Background())
	if err == nil {
		t.Fatal("expected a transport error")
	}
	if strings.Contains(err.Error(), "SECRET-TOKEN") {
		t.Errorf("token leaked into error: %v", err)
	}
}

func TestGetUpdatesPassesFilterAndDrop(t *testing.T) {
	var body map[string]any
	c, _ := newStub(t, func(_ string, b map[string]any) (int, string) {
		body = b
		return 200, `{"ok":true,"result":[{"update_id":10,"message":{"message_id":1,"chat":{"id":1,"type":"private"},"text":"/ping"}}]}`
	})
	ups, err := c.GetUpdates(context.Background(), UpdateOptions{
		Offset: 3, Timeout: 0, AllowedUpdates: []string{"message", "callback_query"}, DropPending: true,
	})
	if err != nil {
		t.Fatalf("GetUpdates: %v", err)
	}
	if len(ups) != 1 || ups[0].UpdateID != 10 {
		t.Fatalf("updates = %+v", ups)
	}
	if ups[0].EffectiveMessage().Text != "/ping" {
		t.Errorf("message text = %q", ups[0].EffectiveMessage().Text)
	}
	if body["offset"].(float64) != 3 || body["drop_pending_updates"] != true {
		t.Errorf("wire body = %v", body)
	}
	if allowed, ok := body["allowed_updates"].([]any); !ok || len(allowed) != 2 {
		t.Errorf("allowed_updates not sent: %v", body["allowed_updates"])
	}
}

// asAPIError is errors.As without importing errors at every call site.
func asAPIError(err error, target **APIError) bool {
	for err != nil {
		if e, ok := err.(*APIError); ok {
			*target = e
			return true
		}
		type unwrapper interface{ Unwrap() error }
		u, ok := err.(unwrapper)
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

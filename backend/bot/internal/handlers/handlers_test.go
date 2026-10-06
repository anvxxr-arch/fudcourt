package handlers

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/backend/bot/internal/config"
	"github.com/anvxxr-arch/fudcourt/backend/bot/internal/telegram"
)

// recorder is a Sender that keeps the messages a handler produced.
type recorder struct{ sent []string }

func (r *recorder) SendMessage(_ context.Context, _ int64, text string, _ telegram.SendOptions) (telegram.Message, error) {
	r.sent = append(r.sent, text)
	return telegram.Message{MessageID: 1}, nil
}

func (r *recorder) AnswerCallbackQuery(context.Context, string, string) error { return nil }

func (r *recorder) last() string {
	if len(r.sent) == 0 {
		return ""
	}
	return r.sent[len(r.sent)-1]
}

// update builds a private-chat text update from userID with the given text.
func update(userID int64, text string) telegram.Update {
	u := &telegram.User{ID: userID, FirstName: "Dwi"}
	return telegram.Update{
		UpdateID: 1,
		Message: &telegram.Message{
			MessageID: 7,
			From:      u,
			Chat:      telegram.Chat{ID: userID, Type: "private"},
			Text:      text,
		},
	}
}

func newCtx(cfg config.Config, rec *recorder, userID int64, args ...string) *Ctx {
	return &Ctx{
		Ctx:    context.Background(),
		Update: update(userID, "/x"),
		Args:   args,
		Bot:    rec,
		Config: cfg,
	}
}

func TestParseCommand(t *testing.T) {
	cases := []struct {
		in   string
		name string
		args []string
		ok   bool
	}{
		{"/start", "start", nil, true},
		{"/start@fudbase_bot", "start", nil, true},
		{"/balance now extra", "balance", []string{"now", "extra"}, true},
		{"  /PING  ", "ping", nil, true},
		{"hello", "", nil, false},
		{"/", "", nil, false},
		{"", "", nil, false},
		{"no slash /help", "", nil, false},
	}
	for _, tc := range cases {
		name, args, ok := ParseCommand(tc.in)
		if ok != tc.ok || name != tc.name {
			t.Errorf("ParseCommand(%q) = (%q, %v, %v), want (%q, _, %v)", tc.in, name, args, ok, tc.name, tc.ok)
			continue
		}
		if len(args) != len(tc.args) {
			t.Errorf("ParseCommand(%q) args = %v, want %v", tc.in, args, tc.args)
		}
	}
}

func TestRegistryMenuHidesAdminAndHidden(t *testing.T) {
	reg := New(config.Config{AdminIDs: map[int64]bool{1: true}}, time.Now())

	public := map[string]bool{}
	for _, h := range reg.Public() {
		public[h.Name] = true
	}
	for _, want := range []string{"start", "help", "ping", "id", "version", "status", "wallets", "balance"} {
		if !public[want] {
			t.Errorf("public menu is missing /%s", want)
		}
	}
	for _, banned := range []string{"admin", "whoami", "stats"} {
		if public[banned] {
			t.Errorf("admin command /%s leaked into the public menu", banned)
		}
	}

	menu := reg.Menu()
	if len(menu) != len(reg.Public()) {
		t.Errorf("Menu() = %d entries, Public() = %d", len(menu), len(reg.Public()))
	}
	for _, c := range menu {
		if strings.HasPrefix(c.Command, "/") {
			t.Errorf("menu command must not carry a slash: %q", c.Command)
		}
	}
}

func TestDispatchAdminGate(t *testing.T) {
	reg := New(config.Config{AdminIDs: map[int64]bool{1: true}}, time.Now())

	// Non-admin is refused on an admin command.
	rec := &recorder{}
	c := newCtx(config.Config{AdminIDs: map[int64]bool{1: true}}, rec, 2)
	if err := reg.Dispatch(c, "whoami"); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if !strings.Contains(rec.last(), "Admin only") {
		t.Errorf("expected an admin refusal, got %q", rec.last())
	}

	// Admin is allowed and gets the identity card.
	rec2 := &recorder{}
	c2 := newCtx(config.Config{AdminIDs: map[int64]bool{1: true}}, rec2, 1)
	if err := reg.Dispatch(c2, "whoami"); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if !strings.Contains(rec2.last(), "admin: yes") {
		t.Errorf("expected the whoami card, got %q", rec2.last())
	}
}

func TestDispatchUnknownCommand(t *testing.T) {
	reg := New(config.Config{}, time.Now())
	rec := &recorder{}
	err := reg.Dispatch(newCtx(config.Config{}, rec, 1), "nope")
	if !errors.Is(err, ErrUnknownCommand) {
		t.Fatalf("err = %v, want ErrUnknownCommand", err)
	}
}

func TestHelpCardListsCommands(t *testing.T) {
	reg := New(config.Config{}, time.Now())
	rec := &recorder{}
	if err := reg.Dispatch(newCtx(config.Config{}, rec, 1), "help"); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	out := rec.last()
	if !strings.Contains(out, "/ping") || !strings.Contains(out, "/status") {
		t.Errorf("help card missing commands:\n%s", out)
	}
}

func TestPingReportsUptime(t *testing.T) {
	reg := New(config.Config{}, time.Now().Add(-5*time.Second))
	rec := &recorder{}
	if err := reg.Dispatch(newCtx(config.Config{}, rec, 1), "ping"); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if !strings.Contains(rec.last(), "pong") {
		t.Errorf("ping reply = %q", rec.last())
	}
}

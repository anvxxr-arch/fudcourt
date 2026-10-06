// Package handlers holds the bot's command handlers and the registry that maps
// a slash command to one of them.
//
// The shape mirrors the frontend's registry idea (fudbase/handlers) but in Go:
// a handler declares itself once with a name, a description and an admin flag,
// and the registry is the single source for dispatch, the /help menu and
// Telegram's own setMyCommands menu. Adding a command is one Register call — no
// central switch to edit, and the offline test can enumerate the set.
package handlers

import (
	"context"
	"html"
	"net/http"
	"strings"

	"github.com/anvxxr-arch/fudcourt/apps/bot/internal/config"
	"github.com/anvxxr-arch/fudcourt/apps/bot/internal/telegram"
)

// Sender is the outbound surface a handler needs. *telegram.Client satisfies it;
// tests substitute a recorder.
type Sender interface {
	SendMessage(ctx context.Context, chatID int64, text string, opts telegram.SendOptions) (telegram.Message, error)
	AnswerCallbackQuery(ctx context.Context, id, text string) error
}

// HTTPDoer is the probe surface /status and /balance use. *http.Client satisfies
// it; tests inject a stub.
type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

// Ctx carries everything one handler invocation needs.
type Ctx struct {
	Ctx    context.Context
	Update telegram.Update
	// Args are the whitespace-separated words after the command.
	Args   []string
	Bot    Sender
	Config config.Config
	HTTP   HTTPDoer
}

// Reply sends an HTML message back into the chat the update came from, threaded
// to the originating message (and forum topic). HTML is used so handlers can
// bold labels; every interpolation must go through Esc.
func (c *Ctx) Reply(text string) error {
	msg := c.Update.EffectiveMessage()
	if msg == nil {
		return nil
	}
	_, err := c.Bot.SendMessage(c.Ctx, msg.Chat.ID, text, telegram.SendOptions{
		ParseMode:             "HTML",
		DisableWebPagePreview: true,
		ReplyToMessageID:      msg.MessageID,
		MessageThreadID:       msg.MessageThreadID,
	})
	return err
}

// User returns the invoking user, or nil.
func (c *Ctx) User() *telegram.User { return c.Update.EffectiveUser() }

// IsAdmin reports whether the invoking user is on the allowlist.
func (c *Ctx) IsAdmin() bool {
	u := c.User()
	return u != nil && c.Config.IsAdmin(u.ID)
}

// Esc escapes a string for the HTML parse mode.
func Esc(s string) string { return html.EscapeString(s) }

// Handler is one command.
type Handler struct {
	// Name is the command without the leading slash ("start").
	Name string
	// Description is the one-line /help entry.
	Description string
	// AdminOnly gates the handler behind the allowlist.
	AdminOnly bool
	// Hidden keeps the command out of the public menu (admin commands are
	// listed under /admin instead).
	Hidden bool
	// Run executes the command.
	Run func(c *Ctx) error
}

// Registry maps command names to handlers.
type Registry struct {
	byName map[string]*Handler
	order  []string // first-seen handler names, for stable menus
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{byName: map[string]*Handler{}}
}

// Add registers a handler under its name plus any aliases. Aliases share the
// same *Handler, so a menu deduplicates by Name.
func (r *Registry) Add(h Handler, aliases ...string) {
	hp := &h
	if _, seen := r.byName[h.Name]; !seen {
		r.order = append(r.order, h.Name)
	}
	r.byName[h.Name] = hp
	for _, a := range aliases {
		r.byName[a] = hp
	}
}

// Lookup finds a handler by command name.
func (r *Registry) Lookup(name string) (*Handler, bool) {
	h, ok := r.byName[strings.ToLower(name)]
	return h, ok
}

// All returns every distinct handler in registration order.
func (r *Registry) All() []*Handler {
	out := make([]*Handler, 0, len(r.order))
	for _, name := range r.order {
		out = append(out, r.byName[name])
	}
	return out
}

// Public returns the handlers shown in /help (not hidden, not admin-only).
func (r *Registry) Public() []*Handler {
	var out []*Handler
	for _, h := range r.All() {
		if !h.Hidden && !h.AdminOnly {
			out = append(out, h)
		}
	}
	return out
}

// Admin returns the admin-only handlers listed under /admin.
func (r *Registry) Admin() []*Handler {
	var out []*Handler
	for _, h := range r.All() {
		if h.AdminOnly {
			out = append(out, h)
		}
	}
	return out
}

// Menu renders Telegram's setMyCommands payload for the public commands.
func (r *Registry) Menu() []telegram.BotCommand {
	var out []telegram.BotCommand
	for _, h := range r.Public() {
		out = append(out, telegram.BotCommand{Command: h.Name, Description: h.Description})
	}
	return out
}

// ParseCommand splits a message body into a command name and its arguments.
// "/start@fudbase_bot now" -> ("start", ["now"], true). A non-command returns
// ok=false. The "@bot" suffix Telegram appends in groups is stripped.
func ParseCommand(text string) (name string, args []string, ok bool) {
	fields := strings.Fields(strings.TrimSpace(text))
	if len(fields) == 0 || !strings.HasPrefix(fields[0], "/") {
		return "", nil, false
	}
	head := strings.TrimPrefix(fields[0], "/")
	if at := strings.IndexByte(head, '@'); at >= 0 {
		head = head[:at]
	}
	if head == "" {
		return "", nil, false
	}
	return strings.ToLower(head), fields[1:], true
}

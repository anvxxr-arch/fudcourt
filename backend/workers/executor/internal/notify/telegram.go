// Package notify delivers FUDCourt execution notifications to an outbound
// channel (PRD §120).
//
// The first channel is Telegram, reached through the FUDCourt notification bot
// (@fudbase_bot). Two environment keys configure it —
// FUDCOURT_TELEGRAM_BOT_TOKEN and FUDCOURT_TELEGRAM_CHAT_ID — and the channel is
// DISABLED when either one is absent. This is the one place the executor's
// fail-closed rule (objective §40) deliberately does not apply: a missing
// notification channel must never stop trading, so an unconfigured channel is
// silent, not fatal. A channel that is present but BROKEN is still loud — see
// Observer, which logs every delivery failure.
//
// Honesty rule (house style): the notifiable set is drawn ONLY from the 23
// canonical ExecutionEventName values. Four of PRD §120's events have no
// counterpart in that immutable vocabulary yet — "credential invalid",
// "exchange disconnected", "SL triggered" and "TP filled" — and they are NOT
// fabricated here. See Gaps: the shortfall is recorded, not papered over.
package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	// EnvBotToken is the @fudbase_bot token from @BotFather.
	EnvBotToken = "FUDCOURT_TELEGRAM_BOT_TOKEN"
	// EnvChatID is the destination chat (a numeric id, or @channelusername).
	EnvChatID = "FUDCOURT_TELEGRAM_CHAT_ID"

	// DefaultEndpoint is the Telegram Bot API root; overridable for tests.
	DefaultEndpoint = "https://api.telegram.org"

	// maxTextLen is Telegram's own sendMessage cap. A longer message is
	// truncated HERE, visibly, rather than rejected by the venue.
	maxTextLen = 4096
)

// ErrNotConfigured marks an unset channel — the silent, non-fatal case.
var ErrNotConfigured = errors.New("notify: channel not configured")

// Config wires one Telegram channel.
type Config struct {
	// Token is the bot token (EnvBotToken). Required.
	Token string
	// ChatID is the destination chat (EnvChatID). Required.
	ChatID string
	// Endpoint is the Bot API root; empty selects DefaultEndpoint.
	Endpoint string
	// HTTPClient is the injected transport; nil selects a 10s-timeout client.
	HTTPClient *http.Client
}

// Result is one accepted delivery. Telegram assigns MessageID; ChatID is
// echoed back so a caller can prove WHICH chat a message landed in.
type Result struct {
	MessageID int64
	ChatID    int64
}

// Sender is the outbound channel contract. Telegram implements it; tests
// substitute a recorder.
type Sender interface {
	Send(ctx context.Context, text string) (Result, error)
}

// Telegram is the Bot API implementation of Sender.
type Telegram struct {
	token    string
	chatID   string
	endpoint string
	http     *http.Client
}

// compile-time proof that Telegram is a Sender.
var _ Sender = (*Telegram)(nil)

// New validates the config and returns the channel. A missing token or chat id
// is refused with ErrNotConfigured so a caller can tell "not set up" apart from
// "set up wrong".
func New(cfg Config) (*Telegram, error) {
	token := strings.TrimSpace(cfg.Token)
	if token == "" {
		return nil, fmt.Errorf("%w: %s is empty", ErrNotConfigured, EnvBotToken)
	}
	chatID := strings.TrimSpace(cfg.ChatID)
	if chatID == "" {
		return nil, fmt.Errorf("%w: %s is empty", ErrNotConfigured, EnvChatID)
	}
	endpoint := strings.TrimSpace(cfg.Endpoint)
	if endpoint == "" {
		endpoint = DefaultEndpoint
	}
	endpoint = strings.TrimRight(endpoint, "/")
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &Telegram{token: token, chatID: chatID, endpoint: endpoint, http: client}, nil
}

// FromEnv builds the channel from the process environment. The second return
// value reports whether the channel is configured at all: (nil, false, nil)
// means "not set up", which the caller treats as a disabled channel, while a
// non-nil error means "set up wrong" (one key present, the other missing) and
// is worth logging.
func FromEnv(getenv func(string) string) (*Telegram, bool, error) {
	token := strings.TrimSpace(getenv(EnvBotToken))
	chatID := strings.TrimSpace(getenv(EnvChatID))
	if token == "" && chatID == "" {
		return nil, false, nil
	}
	tg, err := New(Config{Token: token, ChatID: chatID})
	if err != nil {
		return nil, false, err
	}
	return tg, true, nil
}

// ChatID returns the configured destination, so a caller can log WHERE
// notifications go without ever logging the token.
func (t *Telegram) ChatID() string { return t.chatID }

// sendMessageBody is the wire body. chat_id travels as a STRING so both a
// numeric id and an @channelusername are accepted by the same field.
type sendMessageBody struct {
	ChatID          string `json:"chat_id"`
	Text            string `json:"text"`
	DisableWebPage  bool   `json:"disable_web_page_preview"`
	LinkPreviewOpts struct {
		IsDisabled bool `json:"is_disabled"`
	} `json:"link_preview_options"`
}

// sendMessageResponse is the subset of the Bot API reply this package reads.
type sendMessageResponse struct {
	OK          bool   `json:"ok"`
	Description string `json:"description"`
	Result      struct {
		MessageID int64 `json:"message_id"`
		Chat      struct {
			ID int64 `json:"id"`
		} `json:"chat"`
	} `json:"result"`
}

// Send posts one plain-text message. Plain text — no parse_mode — is
// deliberate: notification payloads carry operator- and venue-supplied strings,
// and plain text cannot be reinterpreted as markup.
func (t *Telegram) Send(ctx context.Context, text string) (Result, error) {
	body := sendMessageBody{ChatID: t.chatID, Text: truncate(text, maxTextLen), DisableWebPage: true}
	body.LinkPreviewOpts.IsDisabled = true
	encoded, err := json.Marshal(body)
	if err != nil {
		return Result{}, fmt.Errorf("notify: encode message: %w", err)
	}
	url := fmt.Sprintf("%s/bot%s/sendMessage", t.endpoint, t.token)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(encoded))
	if err != nil {
		return Result{}, fmt.Errorf("notify: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := t.http.Do(req)
	if err != nil {
		// The token is IN the URL; never let a transport error echo it.
		return Result{}, fmt.Errorf("notify: transport: %w", redact(err, t.token))
	}
	defer func() { _, _ = io.Copy(io.Discard, resp.Body) }()
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Result{}, fmt.Errorf("notify: read response: %w", err)
	}
	var decoded sendMessageResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return Result{}, fmt.Errorf("notify: decode response (http %d): %w", resp.StatusCode, err)
	}
	if !decoded.OK {
		return Result{}, fmt.Errorf("notify: telegram refused the message (http %d): %s",
			resp.StatusCode, strings.TrimSpace(decoded.Description))
	}
	return Result{MessageID: decoded.Result.MessageID, ChatID: decoded.Result.Chat.ID}, nil
}

// truncate clamps a message to n bytes on a rune boundary, appending a visible
// marker so a clipped notification never reads as a complete one.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	const marker = "…[truncated]"
	cut := n - len(marker)
	if cut < 0 {
		cut = 0
	}
	for cut > 0 && !utf8Start(s[cut]) {
		cut--
	}
	return s[:cut] + marker
}

// utf8Start reports whether b begins a UTF-8 sequence (not a continuation byte).
func utf8Start(b byte) bool { return b&0xC0 != 0x80 }

// redact keeps a secret out of an error string.
func redact(err error, secret string) error {
	if err == nil || secret == "" {
		return err
	}
	msg := strings.ReplaceAll(err.Error(), secret, "***")
	return errors.New(msg)
}

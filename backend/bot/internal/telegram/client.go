package telegram

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

// DefaultEndpoint is the Telegram Bot API root; overridable for tests.
const DefaultEndpoint = "https://api.telegram.org"

// maxResponseBytes bounds a Bot API response body. getUpdates batches are small
// JSON documents; 4 MiB is far above any legitimate reply and stops a hostile
// or misbehaving endpoint from streaming into memory.
const maxResponseBytes = 4 << 20

// Client is a thin Bot API client bound to one bot token.
type Client struct {
	token    string
	endpoint string
	http     *http.Client
}

// New builds a client against the real Bot API with a sane default transport.
func New(token string) *Client {
	return NewWithEndpoint(token, DefaultEndpoint, &http.Client{Timeout: 30 * time.Second})
}

// NewWithEndpoint lets tests point the client at a stub server. An empty
// endpoint falls back to DefaultEndpoint.
func NewWithEndpoint(token, endpoint string, hc *http.Client) *Client {
	if endpoint == "" {
		endpoint = DefaultEndpoint
	}
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	return &Client{
		token:    token,
		endpoint: strings.TrimRight(endpoint, "/"),
		http:     hc,
	}
}

// Token returns the configured token. Handlers must never log it.
func (c *Client) Token() string { return c.token }

// call posts one method and decodes the envelope's `result` into out. A Bot API
// error (ok:false) becomes a Go error carrying the description — never the
// token, which travels in the URL.
func (c *Client) call(ctx context.Context, method string, params any, out any) error {
	var body io.Reader
	if params != nil {
		encoded, err := json.Marshal(params)
		if err != nil {
			return fmt.Errorf("telegram: encode %s params: %w", method, err)
		}
		body = bytes.NewReader(encoded)
	}
	url := fmt.Sprintf("%s/bot%s/%s", c.endpoint, c.token, method)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, body)
	if err != nil {
		return fmt.Errorf("telegram: build %s request: %w", method, err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("telegram: %s transport: %w", method, redact(err, c.token))
	}
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return fmt.Errorf("telegram: read %s response: %w", method, err)
	}

	var env struct {
		OK          bool            `json:"ok"`
		Description string          `json:"description"`
		ErrorCode   int             `json:"error_code"`
		Result      json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("telegram: decode %s response (http %d): %w", method, resp.StatusCode, err)
	}
	if !env.OK {
		desc := strings.TrimSpace(env.Description)
		if desc == "" {
			desc = http.StatusText(resp.StatusCode)
		}
		return &APIError{Method: method, Code: env.ErrorCode, Status: resp.StatusCode, Description: desc}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(env.Result, out); err != nil {
		return fmt.Errorf("telegram: decode %s result: %w", method, err)
	}
	return nil
}

// APIError is a Bot API refusal (ok:false). Callers may inspect Code — 409 from
// getUpdates means another process is polling the same bot.
type APIError struct {
	Method      string
	Code        int
	Status      int
	Description string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("telegram: %s refused (code %d, http %d): %s", e.Method, e.Code, e.Status, e.Description)
}

// GetMe returns the bot's own account — the startup identity check.
func (c *Client) GetMe(ctx context.Context) (User, error) {
	var u User
	err := c.call(ctx, "getMe", nil, &u)
	return u, err
}

// getUpdatesParams is the long-poll request body. drop_pending_updates is only
// meaningful on the first call; sending it later would discard real work.
type getUpdatesParams struct {
	Offset             int64    `json:"offset,omitempty"`
	Timeout            int      `json:"timeout,omitempty"`
	AllowedUpdates     []string `json:"allowed_updates,omitempty"`
	DropPendingUpdates bool     `json:"drop_pending_updates,omitempty"`
}

// UpdateOptions configures one getUpdates call.
type UpdateOptions struct {
	// Offset confirms every update with a smaller id; 0 asks for all unconfirmed.
	Offset int64
	// Timeout is the server-side long-poll hold, in seconds.
	Timeout int
	// AllowedUpdates overrides the bot's own getUpdates filter. It MUST be set:
	// this bot's profile carries allowed_updates=["callback_query"] from an
	// earlier setWebhook, and a getUpdates with no filter inherits it — which
	// silently drops every message.
	AllowedUpdates []string
	// DropPending discards everything queued before this call (startup drain).
	DropPending bool
}

// GetUpdates long-polls for new updates. The request context must outlive
// opts.Timeout, so the caller sizes ctx accordingly.
func (c *Client) GetUpdates(ctx context.Context, opts UpdateOptions) ([]Update, error) {
	params := getUpdatesParams{
		Offset:             opts.Offset,
		Timeout:            opts.Timeout,
		AllowedUpdates:     opts.AllowedUpdates,
		DropPendingUpdates: opts.DropPending,
	}
	var updates []Update
	if err := c.call(ctx, "getUpdates", params, &updates); err != nil {
		return nil, err
	}
	return updates, nil
}

// SendOptions controls one outbound message.
type SendOptions struct {
	// ParseMode is "" (plain), "HTML" or "MarkdownV2". Plain text is the safe
	// default: it cannot be reinterpreted as markup.
	ParseMode string
	// DisableWebPagePreview suppresses link cards.
	DisableWebPagePreview bool
	// ReplyToMessageID threads the reply, when non-zero.
	ReplyToMessageID int64
	// MessageThreadID targets a forum topic, when non-zero.
	MessageThreadID int64
}

// sendMessageBody is the wire body. chat_id is a number here (the handlers only
// ever reply into the chat an update arrived from).
type sendMessageBody struct {
	ChatID                int64  `json:"chat_id"`
	Text                  string `json:"text"`
	ParseMode             string `json:"parse_mode,omitempty"`
	ReplyToMessageID      int64  `json:"reply_to_message_id,omitempty"`
	MessageThreadID       int64  `json:"message_thread_id,omitempty"`
	DisableWebPagePreview bool   `json:"disable_web_page_preview,omitempty"`
}

// SendMessage posts one message and returns the created Message.
func (c *Client) SendMessage(ctx context.Context, chatID int64, text string, opts SendOptions) (Message, error) {
	body := sendMessageBody{
		ChatID:                chatID,
		Text:                  text,
		ParseMode:             opts.ParseMode,
		ReplyToMessageID:      opts.ReplyToMessageID,
		MessageThreadID:       opts.MessageThreadID,
		DisableWebPagePreview: opts.DisableWebPagePreview,
	}
	var m Message
	err := c.call(ctx, "sendMessage", body, &m)
	return m, err
}

// AnswerCallbackQuery acknowledges a button press so the client's spinner stops.
func (c *Client) AnswerCallbackQuery(ctx context.Context, id, text string) error {
	params := map[string]any{"callback_query_id": id}
	if text != "" {
		params["text"] = text
	}
	return c.call(ctx, "answerCallbackQuery", params, nil)
}

// BotCommand is one entry of the slash-command menu.
type BotCommand struct {
	Command     string `json:"command"`
	Description string `json:"description"`
}

// SetMyCommands publishes the command menu shown by Telegram clients.
func (c *Client) SetMyCommands(ctx context.Context, commands []BotCommand) error {
	return c.call(ctx, "setMyCommands", map[string]any{"commands": commands}, nil)
}

// redact keeps the bot token out of an error string.
func redact(err error, secret string) error {
	if err == nil || secret == "" {
		return err
	}
	return errors.New(strings.ReplaceAll(err.Error(), secret, "***"))
}

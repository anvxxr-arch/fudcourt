// Command bot is the FUDCourt Telegram bot (@fudbase_bot) — the RECEIVING half
// of the notification channel the executor's notify package sends through.
//
// It long-polls getUpdates (no public ingress: FUDCourt is loopback-only by
// DR-002, and a webhook would need one) and dispatches slash commands through
// the handlers registry. Startup is fail-visible like apps/api: a missing
// bot token, or a token Telegram rejects, exits non-zero before the loop
// starts. A transient poll error backs off and retries instead of crashing.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/bot/internal/config"
	"github.com/anvxxr-arch/fudcourt/apps/bot/internal/handlers"
	"github.com/anvxxr-arch/fudcourt/apps/bot/internal/telegram"
)

const (
	// pollTimeout is the server-side long-poll hold, in seconds (Telegram caps
	// this at 50).
	pollTimeout = 30
	// requestSlack is added to the poll timeout so the HTTP request outlives the
	// server-side hold rather than racing it.
	requestSlack = 10 * time.Second
	// minBackoff / maxBackoff bound the retry delay after a poll error.
	minBackoff = 1 * time.Second
	maxBackoff = 30 * time.Second
	// probeTimeout bounds one /status or /balance probe.
	probeTimeout = 8 * time.Second
)

// allowedUpdates MUST be sent explicitly. The bot's own getUpdates profile
// carries allowed_updates=["callback_query"] (set by an earlier setWebhook), and
// an unfiltered getUpdates inherits it — which would drop every message.
var allowedUpdates = []string{"message", "callback_query"}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{})))
	started := time.Now()

	cfg, err := config.FromEnv(os.Getenv)
	if err != nil {
		slog.Error("configuration error", "service", "bot", "error", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// The Telegram client's HTTP timeout must NOT undercut the getUpdates
	// long-poll: pollLoop holds each request for pollTimeout+requestSlack, and a
	// fixed client timeout shorter than that fires first — every poll then fails
	// with "Client.Timeout exceeded" even though the request context allows more.
	// Every call site already carries its own deadline in ctx (getMe and
	// setMyCommands 15s, each poll pollTimeout+requestSlack), so the client is
	// left without its own timeout and the context governs.
	client := telegram.NewWithEndpoint(cfg.BotToken, cfg.APIBase, &http.Client{})

	// Identity check: proves the token before the loop opens (fail-visible).
	meCtx, cancelMe := context.WithTimeout(ctx, 15*time.Second)
	me, err := client.GetMe(meCtx)
	cancelMe()
	if err != nil {
		slog.Error("getMe failed — bot token rejected", "service", "bot", "error", err)
		os.Exit(1)
	}
	slog.Info("bot online",
		"service", "bot",
		"username", me.Username,
		"bot_id", me.ID,
		"admins", len(cfg.AdminIDs),
		"wallets", len(cfg.Wallets),
	)

	reg := handlers.New(cfg, started)

	// Publish the command menu (best-effort: a menu failure must not stop the
	// bot from answering commands).
	menuCtx, cancelMenu := context.WithTimeout(ctx, 15*time.Second)
	if err := client.SetMyCommands(menuCtx, reg.Menu()); err != nil {
		slog.Warn("setMyCommands failed (non-fatal)", "service", "bot", "error", err)
	}
	cancelMenu()

	// Startup drain: discard anything queued while the bot was down, so a
	// restart does not replay hours of old messages.
	drainCtx, cancelDrain := context.WithTimeout(ctx, 15*time.Second)
	if _, err := client.GetUpdates(drainCtx, telegram.UpdateOptions{
		Timeout:        0,
		AllowedUpdates: allowedUpdates,
		DropPending:    true,
	}); err != nil {
		slog.Warn("startup drain failed (non-fatal)", "service", "bot", "error", err)
	}
	cancelDrain()

	httpClient := &http.Client{Timeout: probeTimeout}
	pollLoop(ctx, client, reg, cfg, httpClient)
	slog.Info("bot stopped", "service", "bot")
}

// pollLoop runs getUpdates until ctx is cancelled.
func pollLoop(ctx context.Context, client *telegram.Client, reg *handlers.Registry, cfg config.Config, hc *http.Client) {
	var offset int64
	backoff := minBackoff

	for {
		if ctx.Err() != nil {
			return
		}
		reqCtx, cancel := context.WithTimeout(ctx, time.Duration(pollTimeout)*time.Second+requestSlack)
		updates, err := client.GetUpdates(reqCtx, telegram.UpdateOptions{
			Offset:         offset,
			Timeout:        pollTimeout,
			AllowedUpdates: allowedUpdates,
		})
		cancel()

		if err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Error("getUpdates failed", "service", "bot", "error", err, "retry_in", backoff.String())
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			if backoff *= 2; backoff > maxBackoff {
				backoff = maxBackoff
			}
			continue
		}
		backoff = minBackoff

		for i := range updates {
			u := updates[i]
			if u.UpdateID >= offset {
				offset = u.UpdateID + 1
			}
			dispatch(ctx, client, reg, cfg, hc, u)
		}
	}
}

// dispatch routes one update. A callback press is acknowledged (stops the client
// spinner) and, when its data names a command, handled like one; a text message
// is parsed for a slash command.
func dispatch(ctx context.Context, client *telegram.Client, reg *handlers.Registry, cfg config.Config, hc *http.Client, u telegram.Update) {
	if u.CallbackQuery != nil {
		if err := client.AnswerCallbackQuery(ctx, u.CallbackQuery.ID, ""); err != nil {
			slog.Warn("answerCallbackQuery failed", "service", "bot", "error", err)
		}
	}

	msg := u.EffectiveMessage()
	if msg == nil || msg.Text == "" {
		return
	}
	name, args, ok := handlers.ParseCommand(msg.Text)
	if !ok {
		return
	}

	c := &handlers.Ctx{Ctx: ctx, Update: u, Args: args, Bot: client, Config: cfg, HTTP: hc}
	err := reg.Dispatch(c, name)
	switch {
	case err == nil:
		slog.Info("command handled", "service", "bot", "command", name)
	case errors.Is(err, handlers.ErrUnknownCommand):
		if rerr := c.Reply("Unknown command. Try /help."); rerr != nil {
			slog.Warn("reply failed", "service", "bot", "error", rerr)
		}
	default:
		slog.Error("handler failed", "service", "bot", "command", name, "error", err)
	}
}

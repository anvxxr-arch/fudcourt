// Command notifycheck verifies the FUDCourt notification channel end to end
// (PRD §120): it builds the Telegram channel from the process environment and
// sends one message, then prints the Bot API's verdict.
//
// It exists because a channel that has never carried a message is not a channel
// that works, and because the production path (an execution event reaching
// internal/notify) is hard to trigger on demand. This exercises the SAME code —
// notify.FromEnv, notify.Format and Telegram.Send — that the executor runs.
//
// Usage, from backend/workers/executor, with the executor's environment in
// scope (the production unit gets it from frontend/web/.env.local via
// EnvironmentFile):
//
//	go run ./cmd/notifycheck                       # fixed connectivity probe
//	go run ./cmd/notifycheck "deploy finished"     # a custom message
//	go run ./cmd/notifycheck -event EXECUTION_FAILED   # render+send a sample event
//	go run ./cmd/notifycheck -list                 # show the notifiable set
//
// Exit codes: 0 the Bot API accepted the message (or -list printed); 1 it did
// not, or the channel is not configured — the reason is printed either way, and
// the bot token is never printed.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/notify"
)

const probeText = "✅ FUDCourt notification channel probe — this is a manual check (cmd/notifycheck)."

func main() {
	var (
		eventName = flag.String("event", "", "send a sample of this event name instead of a probe message")
		list      = flag.Bool("list", false, "print the notifiable event set and exit")
		timeout   = flag.Duration("timeout", 15*time.Second, "delivery timeout")
	)
	flag.Parse()

	if *list {
		names := notify.NotifiableEvents()
		fmt.Printf("notifiable events (%d of %d in the vocabulary):\n", len(names), len(execution.ExecutionEventNames))
		for _, n := range names {
			fmt.Printf("  %s\n", n)
		}
		if len(notify.Gaps) > 0 {
			fmt.Printf("\nPRD §120 events with no vocabulary counterpart (%d, NOT notified):\n", len(notify.Gaps))
			for _, g := range notify.Gaps {
				fmt.Printf("  - %s\n", g)
			}
		}
		return
	}

	tg, on, err := notify.FromEnv(os.Getenv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "notifycheck: %v\n", err)
		fmt.Fprintf(os.Stderr, "notifycheck: set %s and %s (the executor reads them from frontend/web/.env.local)\n",
			notify.EnvBotToken, notify.EnvChatID)
		os.Exit(1)
	}
	if !on {
		fmt.Fprintf(os.Stderr, "notifycheck: channel not configured — set %s and %s\n",
			notify.EnvBotToken, notify.EnvChatID)
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	if *eventName != "" {
		name := execution.ExecutionEventName(strings.ToUpper(strings.TrimSpace(*eventName)))
		known := false
		for _, n := range execution.ExecutionEventNames {
			if n == name {
				known = true
				break
			}
		}
		if !known {
			fmt.Fprintf(os.Stderr, "notifycheck: %q is not an ExecutionEventName (try -list)\n", *eventName)
			os.Exit(1)
		}
		ev := execution.ExecutionEventRecord{
			ID:          "evt_notifycheck_0",
			ExecutionID: "exec-notifycheck",
			Name:        name,
			Payload: map[string]any{
				"source": "cmd/notifycheck",
				"note":   "sample event; no execution was run",
			},
			CreatedAt: time.Now().UnixMilli(),
		}
		if text, ok := notify.Format(ev); ok {
			fmt.Printf("--- formatted message ---\n%s\n-------------------------\n", text)
		}
		delivered, err := tg.SendEvent(ctx, ev)
		if !delivered {
			fmt.Fprintf(os.Stderr, "notifycheck: %s is NOT notifiable (nothing sent)\n", name)
			os.Exit(1)
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "notifycheck: delivery failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("ok: delivered %s to chat %s\n", name, tg.ChatID())
		return
	}

	text := probeText
	if args := flag.Args(); len(args) > 0 {
		text = strings.Join(args, " ")
	}
	res, err := tg.Send(ctx, text)
	if err != nil {
		fmt.Fprintf(os.Stderr, "notifycheck: delivery failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("ok: message_id=%d chat_id=%d\n", res.MessageID, res.ChatID)
}

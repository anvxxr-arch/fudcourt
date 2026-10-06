package notify

import (
	"context"
	"log/slog"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/execution"
)

// DefaultTimeout bounds one delivery attempt. A channel that is slow must not
// accumulate goroutines faster than it drains them.
const DefaultTimeout = 10 * time.Second

// Observer adapts a Sender into the repository's append-event observer.
//
// Two properties are deliberate and load-bearing:
//
//  1. It NEVER blocks the append. Delivery happens on its own goroutine, so an
//     unreachable Telegram cannot add latency to — or fail — the durable event
//     write. The audit trail is the truth; the notification is a courtesy.
//  2. It is SILENT for a non-notifiable event (Format returns false) and LOUD
//     for a failed delivery of a notifiable one (a warning per failure). A
//     channel that is switched off is quiet; a channel that is switched on and
//     broken is not.
func Observer(s Sender, logger *slog.Logger, timeout time.Duration) func(execution.ExecutionEventRecord) {
	if logger == nil {
		logger = slog.Default()
	}
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	return func(ev execution.ExecutionEventRecord) {
		if s == nil {
			return
		}
		text, ok := Format(ev)
		if !ok {
			return
		}
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			defer cancel()
			res, err := s.Send(ctx, text)
			if err != nil {
				logger.Warn("notify: delivery failed",
					"event", string(ev.Name),
					"execution", ev.ExecutionID,
					"error", err)
				return
			}
			logger.Info("notify: delivered",
				"event", string(ev.Name),
				"execution", ev.ExecutionID,
				"message_id", res.MessageID,
				"chat_id", res.ChatID)
		}()
	}
}

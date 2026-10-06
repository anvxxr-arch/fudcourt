package handlers

import (
	"fmt"
	"runtime"
	"strings"
	"time"
)

// registerCore wires the always-available commands.
func registerCore(r *Registry, started time.Time) {
	r.Add(Handler{
		Name:        "start",
		Description: "Welcome card and command list",
		Run:         helpCard(r),
	})
	r.Add(Handler{
		Name:        "help",
		Description: "List the commands",
		Run:         helpCard(r),
	})
	r.Add(Handler{
		Name:        "ping",
		Description: "Liveness check",
		Run:         cmdPing(started),
	})
	r.Add(Handler{
		Name:        "id",
		Description: "Show this chat and your user id",
		Run:         cmdID,
	})
	r.Add(Handler{
		Name:        "version",
		Description: "Bot and runtime version",
		Run:         cmdVersion,
	})
}

// helpCard renders the public command list.
func helpCard(r *Registry) func(c *Ctx) error {
	return func(c *Ctx) error {
		name := "there"
		if u := c.User(); u != nil {
			name = Esc(u.FullName())
		}
		var b strings.Builder
		fmt.Fprintf(&b, "🦊 <b>FUDZIE</b> online — hey <b>%s</b>.\n\n<b>Commands</b>", name)
		for _, h := range r.Public() {
			fmt.Fprintf(&b, "\n/%s — %s", h.Name, Esc(h.Description))
		}
		if len(r.Admin()) > 0 {
			b.WriteString("\n\n<i>Admin commands are listed in /admin.</i>")
		}
		return c.Reply(b.String())
	}
}

func cmdPing(started time.Time) func(c *Ctx) error {
	return func(c *Ctx) error {
		return c.Reply(fmt.Sprintf("🏓 pong — up %ds", int(time.Since(started).Seconds())))
	}
}

func cmdID(c *Ctx) error {
	msg := c.Update.EffectiveMessage()
	if msg == nil {
		return nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "<b>IDs</b>\nchat: <code>%d</code>\ntype: <code>%s</code>",
		msg.Chat.ID, Esc(msg.Chat.Type))
	if msg.Chat.IsForum {
		fmt.Fprintf(&b, "\ntopic: <code>%d</code>", msg.MessageThreadID)
	}
	if u := c.User(); u != nil {
		fmt.Fprintf(&b, "\nuser: <code>%d</code>", u.ID)
	}
	return c.Reply(b.String())
}

func cmdVersion(c *Ctx) error {
	me := "?"
	// The bot's own identity is the getMe the dispatcher already proved at
	// startup; here we only report the runtime, not re-hit the API.
	if u := c.User(); u != nil {
		me = Esc(u.FullName())
	}
	return c.Reply(fmt.Sprintf(
		"<b>FUDZIE</b> (@fudbase_bot)\ncaller: <b>%s</b>\ngo: <code>%s</code>\narch: <code>%s/%s</code>",
		me, runtime.Version(), runtime.GOOS, runtime.GOARCH,
	))
}

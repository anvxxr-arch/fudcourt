package handlers

import (
	"fmt"
	"strings"
	"time"
)

// registerAdmin wires the admin-only commands. The gate itself lives in
// Registry.Dispatch, so a handler body never has to re-check.
func registerAdmin(r *Registry, started time.Time) {
	r.Add(Handler{
		Name:        "admin",
		Description: "List the admin commands",
		AdminOnly:   true,
		Run:         adminCard(r),
	})
	r.Add(Handler{
		Name:        "whoami",
		Description: "Your user and chat identity",
		AdminOnly:   true,
		Run:         cmdWhoami,
	})
	r.Add(Handler{
		Name:        "stats",
		Description: "Runtime and configuration stats",
		AdminOnly:   true,
		Run:         cmdStats(r, started),
	})
}

func adminCard(r *Registry) func(c *Ctx) error {
	return func(c *Ctx) error {
		var b strings.Builder
		b.WriteString("🔐 <b>Admin commands</b>")
		for _, h := range r.Admin() {
			fmt.Fprintf(&b, "\n/%s — %s", h.Name, Esc(h.Description))
		}
		return c.Reply(b.String())
	}
}

func cmdWhoami(c *Ctx) error {
	u := c.User()
	msg := c.Update.EffectiveMessage()
	var b strings.Builder
	b.WriteString("<b>You</b>")
	if u != nil {
		username := "—"
		if u.Username != "" {
			username = "@" + Esc(u.Username)
		}
		fmt.Fprintf(&b, "\nid: <code>%d</code>\nname: %s\nusername: %s",
			u.ID, Esc(u.FullName()), username)
	}
	if msg != nil {
		fmt.Fprintf(&b, "\nchat: <code>%d</code> (%s)", msg.Chat.ID, Esc(msg.Chat.Type))
	}
	fmt.Fprintf(&b, "\nadmin: %s", yesno(c.IsAdmin()))
	return c.Reply(b.String())
}

func cmdStats(r *Registry, started time.Time) func(c *Ctx) error {
	return func(c *Ctx) error {
		var b strings.Builder
		fmt.Fprintf(&b, "<b>Stats</b>\nuptime: <code>%ds</code>", int(time.Since(started).Seconds()))
		fmt.Fprintf(&b, "\ncommands: <code>%d</code>", len(r.All()))
		fmt.Fprintf(&b, "\nadmins: <code>%d</code>", len(c.Config.AdminIDs))
		fmt.Fprintf(&b, "\nwallets: <code>%d</code>", len(c.Config.Wallets))
		fmt.Fprintf(&b, "\ndata url: <code>%s</code>", Esc(c.Config.DataURL))
		return c.Reply(b.String())
	}
}

func yesno(v bool) string {
	if v {
		return "yes"
	}
	return "no"
}

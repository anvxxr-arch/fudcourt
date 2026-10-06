package handlers

import (
	"errors"
	"time"

	"github.com/anvxxr-arch/fudcourt/backend/bot/internal/config"
)

// ErrUnknownCommand is returned by Dispatch for a command with no handler.
var ErrUnknownCommand = errors.New("handlers: unknown command")

// New builds the registry with every command wired. started is the process
// start time, used by /ping and /stats for uptime.
func New(cfg config.Config, started time.Time) *Registry {
	r := NewRegistry()
	registerCore(r, started)
	registerAdmin(r, started)
	registerFud(r)
	return r
}

// Dispatch runs the handler for name against c. It is the ONE place the
// admin gate is enforced, so no handler body re-checks the allowlist (and none
// can forget to). An unknown command returns ErrUnknownCommand for the caller
// to render however it likes.
func (r *Registry) Dispatch(c *Ctx, name string) error {
	h, ok := r.Lookup(name)
	if !ok {
		return ErrUnknownCommand
	}
	if h.AdminOnly && !c.IsAdmin() {
		return c.Reply("⛔ <b>Admin only.</b> Your id is not on the allowlist.")
	}
	return h.Run(c)
}

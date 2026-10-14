package main

import (
	"net"
	"net/http"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/httpx"
)

// handleInternalDiscordConfig serves the effective Discord wiring — the env
// defaults overlaid with the admin-editable `settings` rows (settings.go) — to
// the co-located Discord bot over the loopback hop.
//
// The bot is a zero-dependency Bun program: it carries no Postgres driver, so it
// cannot read the `settings` table the admin panel writes. It polls this
// endpoint instead, which resolves the SAME config the panel edits, so an admin
// change reaches the bot without editing .env or restarting it.
//
// No session is required, by design: the api listener is loopback-only (DR-002)
// and the payload carries no secret — the guild id and role ids are public
// inside the guild. A non-loopback peer is refused as if the route did not exist.
func (s *server) handleInternalDiscordConfig(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet) {
		return
	}
	if !isLoopbackPeer(r.RemoteAddr) {
		httpx.WriteError(w, r, errNotFound)
		return
	}
	e := s.discord.effective(r.Context())
	httpx.WriteJSON(w, http.StatusOK, discordConfig{
		GuildID:    e.GuildID,
		RoleAdmin:  e.RoleAdmin,
		RoleTeam:   e.RoleTeam,
		RoleMagang: e.RoleMagang,
		Prefix:     e.Prefix,
	})
}

// isLoopbackPeer reports whether a request's RemoteAddr (host:port, or a bare
// host) is a loopback peer. An unparseable address is NOT loopback: the check
// fails closed, so a malformed peer can never read the config.
func isLoopbackPeer(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

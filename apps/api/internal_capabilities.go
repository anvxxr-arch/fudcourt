package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/access/identity"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/errs"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/httpx"
)

// internalCapabilitiesRequest is what the bot asks about: the member a command is about to act for.
// Role ids only — the bot never sends a permission bitfield, because a Discord permission is not what
// this answers.
type internalCapabilitiesRequest struct {
	UserID string   `json:"userId"`
	Roles  []string `json:"roles"`
}

// internalCapabilitiesBody is the answer: the resolved set, which rule produced it, and whether any
// role holds anything at all.
//
// `mappingEmpty` is the piece that lets the bot stay BACKWARD COMPATIBLE through the change: while no
// role holds a grant, a Discord command keeps its existing gate (an admin role, or Discord's own
// Moderate Members permission) instead of suddenly refusing everyone the panel has not mapped yet.
// The moment an operator maps one role, the mapping governs Discord commands too — the same seeding
// rule the admin baseline uses on the dashboard side.
type internalCapabilitiesBody struct {
	Capabilities []string `json:"capabilities"`
	Source       string   `json:"source"`
	MappingEmpty bool     `json:"mappingEmpty"`
	Unknown      []string `json:"unknown"`
}

// handleInternalCapabilities answers §9's other half: what may THIS MEMBER do.
//
// The dashboard asks the same question with a signed cookie and the bot asks it with a member's role
// ids; both reach resolveForCapabilities, so a slash command cannot disagree with the panel about who
// may ban someone. Loopback-only, like every internal route (DR-002): a non-loopback peer is refused
// as if the route did not exist. No session is required, by design — the payload carries no secret
// (role ids are public inside the guild) and the listener is unreachable from the network.
//
// It never answers 503: with no store configured the core still answers (everyone is subject to a
// mapping that does not exist, so the bot falls back to its own gate rather than the api refusing to
// speak during a database outage).
func (s *server) handleInternalCapabilities(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	if !isLoopbackPeer(r.RemoteAddr) {
		httpx.WriteError(w, r, errNotFound)
		return
	}
	var req internalCapabilitiesRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "body must be a JSON object")
		return
	}
	req.UserID = strings.TrimSpace(req.UserID)
	if !isSnowflake(req.UserID) {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation,
			"userId must be a Discord id (digits only)")
		return
	}
	// The bot has no signed session: the tier is derived from the role ids it just sent, with the
	// same role-id env the login flow uses. Everything after that is the shared resolver.
	tier, _ := identity.TierFromRoleIDs(req.Roles, roleEnv(s.discord.effective(r.Context())))
	got := s.resolveForCapabilities(r.Context(), req.UserID, req.Roles, tier)
	unknown := got.unknown
	if unknown == nil {
		unknown = []string{}
	}
	httpx.WriteJSON(w, http.StatusOK, internalCapabilitiesBody{
		Capabilities: grantedInOrder(got.set),
		Source:       got.source,
		MappingEmpty: got.mappingEmpty,
		Unknown:      unknown,
	})
}

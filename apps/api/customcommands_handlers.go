package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/errs"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/httpx"
)

// nameRe is the trigger grammar: lowercase letters/digits, then letters/digits/
// underscore/hyphen, 1..32 chars. Kept deliberately narrow so a trigger can never
// contain the prefix itself, whitespace, or anything the message parser would
// have to guess at.
var nameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

const (
	maxCustomCommands = 100
	maxAliases        = 10
	maxResponses      = 20
	maxResponseText   = 2000
)

// handleInternalCustomCommands is the bot's read of its custom-command set.
// Loopback-only, like every other internal read: the bot has no Postgres driver,
// so this hop is how an operator change reaches it live.
func (s *server) handleInternalCustomCommands(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet) {
		return
	}
	if !isLoopbackPeer(r.RemoteAddr) {
		httpx.WriteError(w, r, errNotFound)
		return
	}
	if s.customCommands == nil {
		writeRefusal(w, r, http.StatusServiceUnavailable, "custom_commands_unavailable", errs.CategoryInternal,
			"custom command store is not configured (FUDCOURT_PG_URL unset)")
		return
	}
	guildID := s.discord.effective(r.Context()).GuildID
	cmds, err := s.customCommands.list(r.Context(), guildID)
	if err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "custom command query failed")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"commands": cmds})
}

// handleAdminCustomCommands is the dashboard's custom-command editor. The whole
// set is replaced in one transaction (the dashboard edits the list as a unit).
func (s *server) handleAdminCustomCommands(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet, http.MethodPost) {
		return
	}
	if !s.requireAdmin(w, r) {
		return
	}
	if s.customCommands == nil {
		writeRefusal(w, r, http.StatusServiceUnavailable, "custom_commands_unavailable", errs.CategoryInternal,
			"custom command store is not configured (FUDCOURT_PG_URL unset)")
		return
	}
	guildID := s.discord.effective(r.Context()).GuildID
	if r.Method == http.MethodGet {
		cmds, err := s.customCommands.list(r.Context(), guildID)
		if err != nil {
			writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "custom command query failed")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"commands": cmds})
		return
	}
	var req struct {
		Commands []customCommand `json:"commands"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&req); err != nil {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "body must be a JSON object")
		return
	}
	if msg := validateCustomCommands(req.Commands); msg != "" {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, msg)
		return
	}
	before, _ := s.customCommands.list(r.Context(), guildID)
	if err := s.customCommands.replace(r.Context(), guildID, req.Commands); err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "custom command write failed")
		return
	}
	s.recordAudit(r.Context(), auditInput{
		ActorID: s.auditActor(r).ID, ActorName: s.auditActor(r).Name,
		Action: "custom_commands.replace", ResourceType: "custom_command", ResourceID: "custom_commands",
		Before: marshalOrNil(before), After: marshalOrNil(req.Commands), Source: "dashboard",
	})
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "commands": req.Commands})
}

// validateCustomCommands enforces the declarative contract: a narrow trigger
// grammar, unique triggers/aliases across the whole set, bounded counts, and
// responses that are only ever text or a JSON embed object. It normalises in
// place (trims, lowercases) so what is stored is exactly what was validated.
func validateCustomCommands(cmds []customCommand) string {
	if len(cmds) > maxCustomCommands {
		return fmt.Sprintf("at most %d custom commands", maxCustomCommands)
	}
	// The trigger namespace is global across names AND aliases: two commands must
	// not answer the same word, and an alias must not shadow another command.
	taken := map[string]string{}
	for i := range cmds {
		c := &cmds[i]
		c.Name = strings.ToLower(strings.TrimSpace(c.Name))
		if !nameRe.MatchString(c.Name) {
			return fmt.Sprintf("command %d: name must be 1-32 chars of [a-z0-9_-] starting alphanumeric", i)
		}
		if prev, ok := taken[c.Name]; ok {
			return fmt.Sprintf("command %d: trigger %q already used by %s", i, c.Name, prev)
		}
		taken[c.Name] = c.Name

		c.Aliases = normaliseTriggers(c.Aliases)
		if len(c.Aliases) > maxAliases {
			return fmt.Sprintf("command %d: at most %d aliases", i, maxAliases)
		}
		for _, a := range c.Aliases {
			if !nameRe.MatchString(a) {
				return fmt.Sprintf("command %d: alias %q must be 1-32 chars of [a-z0-9_-]", i, a)
			}
			if prev, ok := taken[a]; ok {
				return fmt.Sprintf("command %d: trigger %q already used by %s", i, a, prev)
			}
			taken[a] = c.Name
		}

		if len(c.Responses) == 0 {
			return fmt.Sprintf("command %d: at least one response is required", i)
		}
		if len(c.Responses) > maxResponses {
			return fmt.Sprintf("command %d: at most %d responses", i, maxResponses)
		}
		for j := range c.Responses {
			rp := &c.Responses[j]
			if len(rp.Text) > maxResponseText {
				return fmt.Sprintf("command %d response %d: text must be %d characters or fewer", i, j, maxResponseText)
			}
			if len(rp.Embed) > 0 {
				var probe map[string]any
				if err := json.Unmarshal(rp.Embed, &probe); err != nil {
					return fmt.Sprintf("command %d response %d: embed must be a JSON object", i, j)
				}
			}
			if rp.Text == "" && len(rp.Embed) == 0 {
				return fmt.Sprintf("command %d response %d: response must have text or an embed", i, j)
			}
		}

		for _, id := range c.AllowedRoles {
			if !isSnowflake(id) {
				return fmt.Sprintf("command %d: allowedRoles must contain only Discord ids", i)
			}
		}
		for _, id := range c.AllowedChannels {
			if !isSnowflake(id) {
				return fmt.Sprintf("command %d: allowedChannels must contain only Discord ids", i)
			}
		}
		if c.CooldownSeconds < 0 || c.CooldownSeconds > 86400 {
			return fmt.Sprintf("command %d: cooldownSeconds must be between 0 and 86400", i)
		}
	}
	return ""
}

// normaliseTriggers lowercases, trims and de-duplicates an alias list while
// preserving order, so a stray duplicate never becomes a validation error.
func normaliseTriggers(in []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, raw := range in {
		t := strings.ToLower(strings.TrimSpace(raw))
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}

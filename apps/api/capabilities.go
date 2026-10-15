package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/access/capability"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/access/identity"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/errs"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/httpx"
	"github.com/jackc/pgx/v5/pgxpool"
)

// roleCapabilities is one role's grants as the panel reads them. `Unknown` names grants that are
// STORED but mean nothing, because the vocabulary lives in code: the panel shows them, so a row left
// behind by a renamed capability is visible instead of looking like a working grant.
type roleCapabilities struct {
	RoleID       string   `json:"roleId"`
	Capabilities []string `json:"capabilities"`
	Unknown      []string `json:"unknown"`
}

// permissionsBody is the GET/PUT success envelope: the vocabulary to render, the mapping to edit,
// and the caller's own resolved effect so the panel can grey out what this identity may not change
// without a second round trip.
type permissionsBody struct {
	Capabilities []string           `json:"capabilities"`
	Namespaces   []string           `json:"namespaces"`
	Roles        []roleCapabilities `json:"roles"`
	Actor        actorCapabilities  `json:"actor"`
	Detail       string             `json:"detail,omitempty"`
}

// actorCapabilities answers "what may the caller do", and — just as usefully — WHY, because the three
// ways an identity can hold capabilities are not interchangeable to an operator reading the panel.
type actorCapabilities struct {
	Capabilities []string `json:"capabilities"`
	// Source is "owner" (the guild owner's implicit full access), "admin_tier" (the configured admin
	// role, which holds everything so the first mapping is writable) or "roles" (the union of this
	// session's role grants). "none" means no valid session.
	Source string `json:"source"`
}

// permissionsWrite is the PUT body: ONE role's grants, replaced as a unit. Absent means "this role
// holds nothing", which is a revoke — the body is a declaration of the role's capability set, not a
// patch, so two admins editing different capabilities of one role cannot interleave into a merge
// nobody asked for.
type permissionsWrite struct {
	RoleID       string   `json:"roleId"`
	Capabilities []string `json:"capabilities"`
}

// capabilityStore is the persistence boundary for the role→capability mapping. The interface keeps
// the handlers testable with an in-memory fake and no database, exactly like every other store here.
type capabilityStore interface {
	// listGrants answers every grant in the guild, grouped by role id. Roles with no grants are
	// absent, not empty.
	listGrants(ctx context.Context, guildID string) (map[string][]string, error)
	// replaceRole rewrites ONE role's grants: the delete and the insert are one transaction, so a
	// failure half-way cannot leave a role holding part of the old set and part of the new.
	replaceRole(ctx context.Context, guildID, roleID string, grants []string, actor string) error
}

type pgCapabilityStore struct{ pool *pgxpool.Pool }

func newPGCapabilityStore(pool *pgxpool.Pool) *pgCapabilityStore {
	return &pgCapabilityStore{pool: pool}
}

func (s *pgCapabilityStore) listGrants(ctx context.Context, guildID string) (map[string][]string, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT role_id, capability FROM discord_role_capabilities WHERE guild_id = $1 ORDER BY role_id, capability`,
		guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var roleID, cap string
		if err := rows.Scan(&roleID, &cap); err != nil {
			return nil, err
		}
		out[roleID] = append(out[roleID], cap)
	}
	return out, rows.Err()
}

func (s *pgCapabilityStore) replaceRole(ctx context.Context, guildID, roleID string, grants []string, actor string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	// A rollback after a successful commit is a no-op, so this is the whole error path.
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`DELETE FROM discord_role_capabilities WHERE guild_id = $1 AND role_id = $2`, guildID, roleID); err != nil {
		return err
	}
	for _, g := range grants {
		if _, err := tx.Exec(ctx,
			`INSERT INTO discord_role_capabilities (guild_id, role_id, capability, granted_by) VALUES ($1, $2, $3, $4)`,
			guildID, roleID, g, actor); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

// identityCapabilities is what one request resolves to, plus WHERE it came from: "the panel says you
// may not do this" is only useful if it can also say why, and the three sources are not the same
// thing to an operator.
type identityCapabilities struct {
	set     map[string]bool
	source  string
	unknown []string
}

// resolveCapabilities answers what the caller may do. The ORDER is the design:
//
//  1. no valid session: nothing.
//  2. the guild owner holds everything — §22's implicit access, and the reason a bad mapping cannot
//     lock the owner out of their own bot. This path never reads the database, so an outage still
//     leaves the owner a way in.
//  3. an admin, while the mapping is still completely EMPTY, holds everything. This is a SEEDING
//     rule, not a bypass: the table starts empty, so without it nobody could ever create the first
//     row and the permissions panel would be dead on arrival. The moment ANY role holds ANY grant,
//     the admin tier is subject to the mapping like everyone else — otherwise the mapping would be
//     decoration for exactly the identities it exists to constrain, and `requireCapability` could
//     never refuse an admin at all.
//  4. everybody else holds the union of the grants their ROLE IDS carry, resolved by
//     internal/access/capability. Role NAMES play no part (§22): renaming a role changes nothing, and
//     a role merely NAMED "Moderator" holds nothing.
//
// A store that is nil (no database configured) means there is no mapping to be subject to, so an
// admin keeps the seeding rule; an UNREADABLE mapping fails closed for paths 3 and 4 — no
// capabilities rather than all of them. Only the owner is exempt from that, by design.
func (s *server) resolveCapabilities(ctx context.Context, r *http.Request) identityCapabilities {
	claims, err := s.sessionClaims(r)
	if err != nil {
		return identityCapabilities{set: map[string]bool{}, source: "none"}
	}
	if ownerID, ok := s.discord.guildOwnerID(ctx); ok && ownerID != "" && ownerID == claims.ID {
		return identityCapabilities{set: capability.All(), source: "owner"}
	}
	admin := claims.Tier.AtLeast(identity.TierAdmin)
	if s.capabilities == nil {
		if admin {
			return identityCapabilities{set: capability.All(), source: "admin_baseline"}
		}
		return identityCapabilities{set: map[string]bool{}, source: "roles"}
	}
	byRole, err := s.capabilities.listGrants(ctx, s.discord.effective(ctx).GuildID)
	if err != nil {
		byRole = map[string][]string{}
	} else if admin && len(byRole) == 0 {
		return identityCapabilities{set: capability.All(), source: "admin_baseline"}
	}
	grants := []string{}
	for _, roleID := range claims.Roles {
		grants = append(grants, byRole[roleID]...)
	}
	set, unknown := capability.Resolve(grants, false)
	return identityCapabilities{set: set, source: "roles", unknown: unknown}
}

// requireCapability refuses a request whose session does not hold cap, and names what is missing —
// including the source, because "you are not an admin" and "your role lost settings.manage" send an
// operator to two different places.
func (s *server) requireCapability(w http.ResponseWriter, r *http.Request, cap string) bool {
	got := s.resolveCapabilities(r.Context(), r)
	if capability.Has(got.set, cap) {
		return true
	}
	writeRefusal(w, r, http.StatusForbidden, "forbidden", errs.CategoryAuthorization,
		"this action needs the "+cap+" capability; your access comes from "+got.source)
	return false
}

// grantedInOrder returns the capabilities of a resolved set in List order — the order the panel
// renders, so a caller never has to sort a set to draw it.
func grantedInOrder(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for _, c := range capability.List {
		if set[c] {
			out = append(out, c)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// handleAdminPermissions serves GET|PUT /api/admin/permissions: the role→capability mapping.
//
// Both methods sit behind requireAdmin — the coarse gate the whole admin plane already uses — and the
// PUT additionally requires the permissions.manage CAPABILITY, so the first route enforced by the
// engine is the one that edits the engine. Reading the mapping is not a capability: it is not a
// secret from an admin (the ids are in the panel's own role list), and gating the read would mean an
// admin who cannot see the page can never be told what to grant.
func (s *server) handleAdminPermissions(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet, http.MethodPut) {
		return
	}
	if !s.requireAdmin(w, r) {
		return
	}
	if s.capabilities == nil {
		writeRefusal(w, r, http.StatusServiceUnavailable, "capabilities_unavailable", errs.CategoryInternal,
			"capability store is not configured (FUDCOURT_PG_URL unset)")
		return
	}
	guildID := s.discord.effective(r.Context()).GuildID
	if r.Method == http.MethodGet {
		s.adminPermissionsGet(w, r, guildID)
		return
	}
	s.adminPermissionsPut(w, r, guildID)
}

func (s *server) adminPermissionsGet(w http.ResponseWriter, r *http.Request, guildID string) {
	byRole, err := s.capabilities.listGrants(r.Context(), guildID)
	if err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal,
			"capability mapping query failed")
		return
	}
	roleIDs := make([]string, 0, len(byRole))
	for roleID := range byRole {
		roleIDs = append(roleIDs, roleID)
	}
	sort.Strings(roleIDs)
	roles := make([]roleCapabilities, 0, len(roleIDs))
	for _, roleID := range roleIDs {
		grants := byRole[roleID]
		// Report drift per role: a grant the vocabulary does not know is stored, harmless, and
		// invisible unless we say so.
		_, unknown := capability.Resolve(grants, false)
		roles = append(roles, roleCapabilities{RoleID: roleID, Capabilities: grants, Unknown: unknown})
	}
	actor := s.resolveCapabilities(r.Context(), r)
	httpx.WriteJSON(w, http.StatusOK, permissionsBody{
		// A copy: the package's list is an authority, not a buffer for a handler to hand out.
		Capabilities: append([]string(nil), capability.List...),
		Namespaces:   capability.Namespaces(),
		Roles:        roles,
		Actor:        actorCapabilities{Capabilities: grantedInOrder(actor.set), Source: actor.source},
	})
}

func (s *server) adminPermissionsPut(w http.ResponseWriter, r *http.Request, guildID string) {
	if !s.requireCapability(w, r, capability.PermissionsManage) {
		return
	}
	var req permissionsWrite
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "body must be a JSON object")
		return
	}
	req.RoleID = strings.TrimSpace(req.RoleID)
	if !isSnowflake(req.RoleID) {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation,
			"roleId must be a Discord role id (digits only)")
		return
	}
	// Validate every grant BEFORE anything is written: a mapping is a declaration, and a declaration
	// that half-applies is worse than one that is refused. Duplicates collapse, order is kept.
	grants := make([]string, 0, len(req.Capabilities))
	seen := make(map[string]bool, len(req.Capabilities))
	for _, g := range req.Capabilities {
		g = strings.TrimSpace(g)
		if seen[g] {
			continue
		}
		if !capability.Acceptable(g) {
			writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation,
				"capability "+g+" is not one this bot checks; GET lists them (a namespace wildcard such as moderation.* is accepted)")
			return
		}
		seen[g] = true
		grants = append(grants, g)
	}

	byRole, err := s.capabilities.listGrants(r.Context(), guildID)
	if err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal,
			"capability mapping query failed")
		return
	}
	before := byRole[req.RoleID] // nil when the role held nothing: a create, not a change
	actor := s.auditActor(r)
	if err := s.capabilities.replaceRole(r.Context(), guildID, req.RoleID, grants, actor.ID); err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal,
			"capability mapping write failed")
		return
	}
	s.recordAudit(r.Context(), auditInput{
		ActorID: actor.ID, ActorName: actor.Name,
		Action: "permissions.changed", ResourceType: "role_capabilities", ResourceID: req.RoleID,
		Before: marshalOrNil(before), After: marshalOrNil(grants), Source: "dashboard",
	})
	// The echo says what the grants MEAN, not just what was sent: the panel can then show the effect
	// without resolving wildcards itself.
	set, unknown := capability.Resolve(grants, false)
	if unknown == nil {
		// Arrays are never null on this wire (the session cookie's roles make the same promise).
		unknown = []string{}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":           true,
		"roleId":       req.RoleID,
		"capabilities": grants,
		"resolved":     grantedInOrder(set),
		"unknown":      unknown,
	})
}

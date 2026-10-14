package main

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Community features (db/schema/pg-schema.sql: `welcome_configs`,
// `autorole_rules`, `role_panels`, `role_panel_options`, `role_assignments`).
//
// Welcome/goodbye, autoroles and role panels are all OPERATIONAL config: they
// live in Postgres, the dashboard edits them, and the bot reads them over the
// same loopback hop every other config uses. The bot carries no Postgres driver,
// so `GET /api/internal/community/config` is the one read it needs.
//
// `role_assignments` is different: it is an append-only record of every grant/
// revoke the bot attempted, INCLUDING failures (a role above the bot's highest
// role, a Discord 403). Persisting failed assignments is what makes "why didn't
// this member get the role?" answerable.

// welcomeConfig is the single row per guild. joinEmbed/leaveEmbed are the
// optional rich embeds (jsonb); when present the bot posts the embed instead of
// / alongside the plain text for that direction.
type welcomeConfig struct {
	JoinEnabled    bool            `json:"joinEnabled"`
	JoinChannelID  string          `json:"joinChannelId"`
	JoinMessage    string          `json:"joinMessage"`
	JoinEmbed      json.RawMessage `json:"joinEmbed,omitempty"`
	JoinDM         bool            `json:"joinDm"`
	JoinDMMessage  string          `json:"joinDmMessage"`
	LeaveEnabled   bool            `json:"leaveEnabled"`
	LeaveChannelID string          `json:"leaveChannelId"`
	LeaveMessage   string          `json:"leaveMessage"`
	LeaveEmbed     json.RawMessage `json:"leaveEmbed,omitempty"`
}

// autoroleRule is one join-time role grant. kind is on_join | after_duration |
// after_verification; appliesTo is all | human | bot.
type autoroleRule struct {
	ID           string `json:"id"`
	RoleID       string `json:"roleId"`
	Kind         string `json:"kind"`
	DelaySeconds int    `json:"delaySeconds"`
	AppliesTo    string `json:"appliesTo"`
	Enabled      bool   `json:"enabled"`
	Priority     int    `json:"priority"`
}

// rolePanelOption is one selectable role on a panel. exclusiveGroup names a
// mutually-exclusive set (picking one removes the others in the same group).
type rolePanelOption struct {
	RoleID         string `json:"roleId"`
	Label          string `json:"label"`
	Emoji          string `json:"emoji"`
	Style          string `json:"style"`
	Position       int    `json:"position"`
	ExclusiveGroup string `json:"exclusiveGroup"`
}

// rolePanel is a reaction/button/select role menu. kind is reaction | button |
// select; mode is toggle | single | multiple | exclusive.
type rolePanel struct {
	ID          string            `json:"id"`
	ChannelID   string            `json:"channelId"`
	MessageID   string            `json:"messageId"`
	Title       string            `json:"title"`
	Description string            `json:"description"`
	Kind        string            `json:"kind"`
	Mode        string            `json:"mode"`
	Enabled     bool              `json:"enabled"`
	Options     []rolePanelOption `json:"options"`
}

// roleAssignment is one attempted grant/revoke. status is ok | failed; error
// carries the refusal reason when failed.
type roleAssignment struct {
	ID        int64  `json:"id"`
	UserID    string `json:"userId"`
	RoleID    string `json:"roleId"`
	Action    string `json:"action"`
	Source    string `json:"source"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
	CreatedAt string `json:"createdAt"`
}

type roleAssignmentInput struct {
	UserID string `json:"userId"`
	RoleID string `json:"roleId"`
	Action string `json:"action"`
	Source string `json:"source"`
	Status string `json:"status"`
	Error  string `json:"error"`
}

// communityStore is the persistence boundary; an in-memory fake satisfies it in
// tests, so the handlers never need a live database.
type communityStore interface {
	welcome(ctx context.Context, guildID string) (*welcomeConfig, error)
	saveWelcome(ctx context.Context, guildID string, in welcomeConfig) error
	listAutoroles(ctx context.Context, guildID string) ([]autoroleRule, error)
	replaceAutoroles(ctx context.Context, guildID string, rules []autoroleRule) error
	listPanels(ctx context.Context, guildID string) ([]rolePanel, error)
	replacePanels(ctx context.Context, guildID string, panels []rolePanel) error
	recordAssignment(ctx context.Context, guildID string, in roleAssignmentInput) (roleAssignment, error)
	listAssignments(ctx context.Context, guildID string, limit int) ([]roleAssignment, error)
}

type pgCommunityStore struct{ pool *pgxpool.Pool }

func newPGCommunityStore(pool *pgxpool.Pool) *pgCommunityStore { return &pgCommunityStore{pool: pool} }

func (s *pgCommunityStore) welcome(ctx context.Context, guildID string) (*welcomeConfig, error) {
	var w welcomeConfig
	var joinEmbed, leaveEmbed []byte
	err := s.pool.QueryRow(ctx,
		`SELECT join_enabled, join_channel_id, join_message, join_dm, join_dm_message,
		        leave_enabled, leave_channel_id, leave_message, join_embed, leave_embed
		   FROM welcome_configs WHERE guild_id = $1`, guildID,
	).Scan(&w.JoinEnabled, &w.JoinChannelID, &w.JoinMessage, &w.JoinDM, &w.JoinDMMessage,
		&w.LeaveEnabled, &w.LeaveChannelID, &w.LeaveMessage, &joinEmbed, &leaveEmbed)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(joinEmbed) > 0 {
		w.JoinEmbed = json.RawMessage(joinEmbed)
	}
	if len(leaveEmbed) > 0 {
		w.LeaveEmbed = json.RawMessage(leaveEmbed)
	}
	return &w, nil
}

func (s *pgCommunityStore) saveWelcome(ctx context.Context, guildID string, in welcomeConfig) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO welcome_configs (guild_id, join_enabled, join_channel_id, join_message, join_dm, join_dm_message,
		                              leave_enabled, leave_channel_id, leave_message, join_embed, leave_embed, updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS'))
		 ON CONFLICT (guild_id) DO UPDATE SET
		   join_enabled=EXCLUDED.join_enabled, join_channel_id=EXCLUDED.join_channel_id, join_message=EXCLUDED.join_message,
		   join_dm=EXCLUDED.join_dm, join_dm_message=EXCLUDED.join_dm_message,
		   leave_enabled=EXCLUDED.leave_enabled, leave_channel_id=EXCLUDED.leave_channel_id, leave_message=EXCLUDED.leave_message,
		   join_embed=EXCLUDED.join_embed, leave_embed=EXCLUDED.leave_embed, updated_at=EXCLUDED.updated_at`,
		guildID, in.JoinEnabled, in.JoinChannelID, in.JoinMessage, in.JoinDM, in.JoinDMMessage,
		in.LeaveEnabled, in.LeaveChannelID, in.LeaveMessage, nullableJSON(in.JoinEmbed), nullableJSON(in.LeaveEmbed))
	return err
}

func (s *pgCommunityStore) listAutoroles(ctx context.Context, guildID string) ([]autoroleRule, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, role_id, kind, delay_seconds, applies_to, enabled, priority
		   FROM autorole_rules WHERE guild_id = $1 ORDER BY priority DESC, id`, guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []autoroleRule{}
	for rows.Next() {
		var r autoroleRule
		if err := rows.Scan(&r.ID, &r.RoleID, &r.Kind, &r.DelaySeconds, &r.AppliesTo, &r.Enabled, &r.Priority); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *pgCommunityStore) replaceAutoroles(ctx context.Context, guildID string, rules []autoroleRule) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM autorole_rules WHERE guild_id = $1`, guildID); err != nil {
		return err
	}
	for _, r := range rules {
		if _, err := tx.Exec(ctx,
			`INSERT INTO autorole_rules (guild_id, role_id, kind, delay_seconds, applies_to, enabled, priority)
			 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			guildID, r.RoleID, r.Kind, r.DelaySeconds, r.AppliesTo, r.Enabled, r.Priority); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *pgCommunityStore) listPanels(ctx context.Context, guildID string) ([]rolePanel, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, channel_id, message_id, title, description, kind, mode, enabled
		   FROM role_panels WHERE guild_id = $1 ORDER BY id`, guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	panels := []rolePanel{}
	index := map[string]int{}
	for rows.Next() {
		var p rolePanel
		if err := rows.Scan(&p.ID, &p.ChannelID, &p.MessageID, &p.Title, &p.Description, &p.Kind, &p.Mode, &p.Enabled); err != nil {
			return nil, err
		}
		p.Options = []rolePanelOption{}
		index[p.ID] = len(panels)
		panels = append(panels, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(panels) == 0 {
		return panels, nil
	}
	orows, err := s.pool.Query(ctx,
		`SELECT panel_id, role_id, label, emoji, style, position, exclusive_group
		   FROM role_panel_options WHERE guild_id = $1 ORDER BY panel_id, position`, guildID)
	if err != nil {
		return nil, err
	}
	defer orows.Close()
	for orows.Next() {
		var panelID string
		var o rolePanelOption
		if err := orows.Scan(&panelID, &o.RoleID, &o.Label, &o.Emoji, &o.Style, &o.Position, &o.ExclusiveGroup); err != nil {
			return nil, err
		}
		if i, ok := index[panelID]; ok {
			panels[i].Options = append(panels[i].Options, o)
		}
	}
	return panels, orows.Err()
}

func (s *pgCommunityStore) replacePanels(ctx context.Context, guildID string, panels []rolePanel) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM role_panels WHERE guild_id = $1`, guildID); err != nil {
		return err
	}
	for _, p := range panels {
		if _, err := tx.Exec(ctx,
			`INSERT INTO role_panels (guild_id, id, channel_id, message_id, title, description, kind, mode, enabled)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			guildID, p.ID, p.ChannelID, p.MessageID, p.Title, p.Description, p.Kind, p.Mode, p.Enabled); err != nil {
			return err
		}
		for i, o := range p.Options {
			if _, err := tx.Exec(ctx,
				`INSERT INTO role_panel_options (guild_id, panel_id, role_id, label, emoji, style, position, exclusive_group)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
				guildID, p.ID, o.RoleID, o.Label, o.Emoji, o.Style, o.Position, o.ExclusiveGroup); err != nil {
				return err
			}
			_ = i
		}
	}
	return tx.Commit(ctx)
}

func (s *pgCommunityStore) recordAssignment(ctx context.Context, guildID string, in roleAssignmentInput) (roleAssignment, error) {
	var a roleAssignment
	err := s.pool.QueryRow(ctx,
		`INSERT INTO role_assignments (guild_id, user_id, role_id, action, source, status, error)
		 VALUES ($1,$2,$3,$4,$5,$6,$7)
		 RETURNING id, user_id, role_id, action, source, status, COALESCE(error,''), created_at`,
		guildID, in.UserID, in.RoleID, in.Action, in.Source, in.Status, nullIfEmptyString(in.Error),
	).Scan(&a.ID, &a.UserID, &a.RoleID, &a.Action, &a.Source, &a.Status, &a.Error, &a.CreatedAt)
	return a, err
}

// nullIfEmptyString maps "" to a SQL NULL so an empty error column stays absent
// rather than a misleading empty string.
func nullIfEmptyString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (s *pgCommunityStore) listAssignments(ctx context.Context, guildID string, limit int) ([]roleAssignment, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, user_id, role_id, action, source, status, COALESCE(error,''), created_at
		   FROM role_assignments WHERE guild_id = $1 ORDER BY id DESC LIMIT $2`, guildID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []roleAssignment{}
	for rows.Next() {
		var a roleAssignment
		if err := rows.Scan(&a.ID, &a.UserID, &a.RoleID, &a.Action, &a.Source, &a.Status, &a.Error, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

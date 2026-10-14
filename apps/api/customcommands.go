package main

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Custom commands (db/schema/pg-schema.sql: `custom_commands`).
//
// A custom command is DECLARATIVE operator-authored config: a trigger name (and
// aliases), an allow-list of roles/channels, a per-member cooldown, and one or
// more responses (text and/or an embed; more than one is a random pick). It lives
// in Postgres like every other operational config, the dashboard edits it, and
// the bot reads it over the loopback hop every other config uses.
//
// It is deliberately NOT a scripting surface: the response is data the bot
// renders through the shared template engine (renderTemplate/renderEmbed) and
// sends. There is no code path that evaluates the stored text as anything but a
// string, so a custom command can never execute shell/JS/SQL.

// commandResponse is one possible reply. text is rendered as a template; embed
// is the optional rich embed (jsonb), also templated. An entry with only text is
// a plain message, only an embed is an embed message, both sends both.
type commandResponse struct {
	Text  string          `json:"text,omitempty"`
	Embed json.RawMessage `json:"embed,omitempty"`
}

// customCommand is one operator-authored command. allowedRoles/allowedChannels
// are allow-lists (empty = everyone / any channel). reply posts as a Discord
// reply to the trigger; dm sends the response by direct message; deleteTrigger
// removes the invoking message.
type customCommand struct {
	ID              int64             `json:"id"`
	Name            string            `json:"name"`
	Aliases         []string          `json:"aliases"`
	Responses       []commandResponse `json:"responses"`
	AllowedRoles    []string          `json:"allowedRoles"`
	AllowedChannels []string          `json:"allowedChannels"`
	CooldownSeconds int               `json:"cooldownSeconds"`
	DeleteTrigger   bool              `json:"deleteTrigger"`
	Reply           bool              `json:"reply"`
	DM              bool              `json:"dm"`
	Enabled         bool              `json:"enabled"`
}

// customCommandStore is the persistence boundary; an in-memory fake satisfies it
// in tests, so the handlers never need a live database.
type customCommandStore interface {
	list(ctx context.Context, guildID string) ([]customCommand, error)
	replace(ctx context.Context, guildID string, cmds []customCommand) error
}

type pgCustomCommandStore struct{ pool *pgxpool.Pool }

func newPGCustomCommandStore(pool *pgxpool.Pool) *pgCustomCommandStore {
	return &pgCustomCommandStore{pool: pool}
}

func (s *pgCustomCommandStore) list(ctx context.Context, guildID string) ([]customCommand, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, name, aliases, responses, allowed_roles, allowed_channels,
		        cooldown_seconds, delete_trigger, reply, dm, enabled
		   FROM custom_commands WHERE guild_id = $1 ORDER BY name`, guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []customCommand{}
	for rows.Next() {
		var c customCommand
		var aliases, allowedRoles, allowedChannels []string
		var responses []byte
		if err := rows.Scan(&c.ID, &c.Name, &aliases, &responses, &allowedRoles, &allowedChannels,
			&c.CooldownSeconds, &c.DeleteTrigger, &c.Reply, &c.DM, &c.Enabled); err != nil {
			return nil, err
		}
		c.Aliases = nonNilStrings(aliases)
		c.AllowedRoles = nonNilStrings(allowedRoles)
		c.AllowedChannels = nonNilStrings(allowedChannels)
		c.Responses = parseResponses(responses)
		out = append(out, c)
	}
	return out, rows.Err()
}

// replace rewrites one guild's whole command set in a single transaction: the
// dashboard edits the list as a unit, and a partial apply would leave a trigger
// pointing at a half-saved response.
func (s *pgCustomCommandStore) replace(ctx context.Context, guildID string, cmds []customCommand) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM custom_commands WHERE guild_id = $1`, guildID); err != nil {
		return err
	}
	for _, c := range cmds {
		raw, err := json.Marshal(c.Responses)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO custom_commands
			   (guild_id, name, aliases, responses, allowed_roles, allowed_channels,
			    cooldown_seconds, delete_trigger, reply, dm, enabled)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
			guildID, c.Name, nonNilStrings(c.Aliases), raw, nonNilStrings(c.AllowedRoles), nonNilStrings(c.AllowedChannels),
			c.CooldownSeconds, c.DeleteTrigger, c.Reply, c.DM, c.Enabled); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// parseResponses decodes the jsonb array; a malformed blob yields an empty list
// rather than a boot crash (the row is then simply a command with no response).
func parseResponses(raw []byte) []commandResponse {
	out := []commandResponse{}
	if len(raw) == 0 {
		return out
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return []commandResponse{}
	}
	return out
}

// nonNilStrings guarantees a JSON array (never null) so the wire shape is stable
// and a consumer can iterate without a nil check.
func nonNilStrings(in []string) []string {
	if in == nil {
		return []string{}
	}
	return in
}

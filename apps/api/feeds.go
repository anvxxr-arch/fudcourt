package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/errs"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/httpx"
	"github.com/jackc/pgx/v5/pgxpool"
)

// feedSource is one row of `feed_sources` as the dashboard sees it. The
// operator-owned fields and the worker-owned ones are in ONE struct on purpose:
// the panel has to show the health, and the store must know which columns it is
// allowed to overwrite (see replaceFeedSources).
type feedSource struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	URL       string `json:"url"`
	Adapter   string `json:"adapter"`
	ChannelID string `json:"channelId"`
	Message   string `json:"message"`
	// Optional role to ping on a new item, as a snowflake in text.
	MentionRoleID *string `json:"mentionRoleId"`
	IncludeText   *string `json:"includeText"`
	ExcludeText   *string `json:"excludeText"`
	Enabled       bool    `json:"enabled"`
	// The poll cadence, in seconds. It lives on the source's `scheduled_jobs`
	// definition (`schedule_kind='interval'`), not on the source row, because a
	// feed with no schedule is a feed nobody polls.
	PollIntervalSecs int64 `json:"pollIntervalSecs"`
	// Worker-owned, read-only here.
	Primed              bool    `json:"primed"`
	Owed                int64   `json:"owed"`
	ConsecutiveFailures int32   `json:"consecutiveFailures"`
	LastStatus          *string `json:"lastStatus"`
	LastError           *string `json:"lastError"`
}

// feedLimits bounds one guild's feed list. The bound exists so a scripted
// dashboard cannot turn this service into an outbound scanner.
const (
	maxFeedSources  = 50
	minPollInterval = 60
	maxPollInterval = 7 * 24 * 60 * 60
)

func feedAdapterKnown(a string) bool {
	switch a {
	case "auto", "rss", "atom", "json":
		return true
	}
	return false
}

// validFeedURL is the panel's OWN check, and deliberately a NARROW mirror of the
// worker's guard: enough to refuse a typo or a hostile paste at the point of
// entry, not a second implementation of the real thing. The authority is the
// worker's `feeds::guard`, which vets every hop of every poll; this only shapes
// the refusal an operator sees immediately. If one grows a rule the other lacks,
// the worker is right and this is the bug.
//
// Note what it does NOT do: resolve the name. Resolving here would add an
// outbound lookup — and a time-of-check/time-of-use gap — to the API, for a
// decision the worker must make again at connect time anyway.
func validFeedURL(raw string) string {
	if raw == "" || len(raw) > 2048 {
		return "url must be 1..2048 characters"
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "url is not a valid URL"
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "url must be http or https"
	}
	if u.User != nil {
		return "url must not carry credentials"
	}
	host := u.Hostname()
	if host == "" {
		return "url must name a host"
	}
	if port := u.Port(); port != "" && port != "80" && port != "443" {
		return "url must use the default port"
	}
	if ip := net.ParseIP(host); ip != nil {
		if !isPublicIP(ip) {
			return "url must not point at a private address"
		}
		return ""
	}
	if !strings.Contains(host, ".") {
		return "url must use a fully-qualified host name, not a single label"
	}
	return ""
}

// isPublicIP is the address half of the same narrow check.
func isPublicIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() ||
		ip.IsInterfaceLocalMulticast() {
		return false
	}
	v4 := ip.To4()
	if v4 == nil {
		return true
	}
	switch {
	case v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127: // 100.64.0.0/10, CGNAT
		return false
	case v4[0] == 169 && v4[1] == 254: // link-local, incl. cloud metadata
		return false
	case v4[0] == 192 && v4[1] == 0 && v4[2] == 0: // 192.0.0.0/24
		return false
	case v4[0] == 198 && (v4[1] == 18 || v4[1] == 19): // benchmarking
		return false
	case v4[0] >= 240: // reserved + broadcast
		return false
	}
	return true
}

// validateFeedSource checks one source and returns the operator-facing reason it
// is refused, or "".
func validateFeedSource(src feedSource) string {
	if n := strings.TrimSpace(src.Name); n == "" || len(n) > 64 {
		return "name must be 1..64 characters"
	}
	if strings.ContainsAny(src.Name, "\n\r	") {
		return "name must not contain control characters"
	}
	if msg := validFeedURL(strings.TrimSpace(src.URL)); msg != "" {
		return "url: " + msg
	}
	if !feedAdapterKnown(src.Adapter) {
		return "adapter must be one of auto, rss, atom, json"
	}
	if !isSnowflake(src.ChannelID) {
		return "channelId must be a Discord channel id"
	}
	if src.MentionRoleID != nil && strings.TrimSpace(*src.MentionRoleID) != "" && !isSnowflake(strings.TrimSpace(*src.MentionRoleID)) {
		return "mentionRoleId must be a Discord role id"
	}
	if src.PollIntervalSecs < minPollInterval || src.PollIntervalSecs > maxPollInterval {
		return "pollIntervalSecs must be 60..604800"
	}
	if len(src.Message) > 512 {
		return "message must be at most 512 characters"
	}
	if src.IncludeText != nil && len(*src.IncludeText) > 128 {
		return "includeText must be at most 128 characters"
	}
	if src.ExcludeText != nil && len(*src.ExcludeText) > 128 {
		return "excludeText must be at most 128 characters"
	}
	return ""
}

// nullIfEmpty keeps an empty optional field as SQL NULL rather than ''.
func nullIfEmpty(s *string) *string {
	if s == nil || strings.TrimSpace(*s) == "" {
		return nil
	}
	trimmed := strings.TrimSpace(*s)
	return &trimmed
}

// feedStore is the Postgres-backed half of the feeds panel. `replace` is the
// repo's shape for a dashboard-owned list (see autoroles, custom commands) with
// two differences that matter here:
//
//   - it keys on `name`, so a row the operator edited is the SAME feed, and
//   - it never writes the worker-owned columns. `etag`, `last_modified`,
//     `primed`, `last_*`, `consecutive_failures` and the item ledger belong to
//     the poller; a wholesale replace that reset them would re-announce a
//     backlog on every save.
//
// The delete half is real, though: a source absent from the list is gone, and
// its ledger cascades with it.
type feedStore interface {
	list(ctx context.Context, guildID string) ([]feedSource, error)
	replace(ctx context.Context, guildID string, sources []feedSource) error
}

type pgFeedStore struct{ pool *pgxpool.Pool }

func newPGFeedStore(pool *pgxpool.Pool) *pgFeedStore { return &pgFeedStore{pool: pool} }

// feedSelect joins the source to its schedule. The interval is read with a
// regex guard before the cast: a hand-made definition whose expr is a cron
// string must not make the whole panel fail to load.
const feedSelect = `
SELECT f.id, f.name, f.url, f.adapter, f.channel_id, f.message, f.mention_role_id,
       f.include_text, f.exclude_text, f.enabled,
       CASE WHEN d.schedule_expr ~ '^[0-9]+$' THEN d.schedule_expr::bigint ELSE 900 END,
       f.primed, f.consecutive_failures, f.last_status, f.last_error,
       (SELECT count(*) FROM feed_items i
         WHERE i.source_id = f.id AND i.delivery_state = 'pending')
  FROM feed_sources f
  LEFT JOIN scheduled_jobs d
    ON d.guild_id = f.guild_id
   AND d.job_kind = 'feed.poll'
   AND d.payload->>'source_id' = f.id::text
 WHERE f.guild_id = $1
 ORDER BY f.name`

func (s *pgFeedStore) list(ctx context.Context, guildID string) ([]feedSource, error) {
	rows, err := s.pool.Query(ctx, feedSelect, guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []feedSource{}
	for rows.Next() {
		var f feedSource
		if err := rows.Scan(&f.ID, &f.Name, &f.URL, &f.Adapter, &f.ChannelID, &f.Message,
			&f.MentionRoleID, &f.IncludeText, &f.ExcludeText, &f.Enabled,
			&f.PollIntervalSecs, &f.Primed, &f.ConsecutiveFailures,
			&f.LastStatus, &f.LastError, &f.Owed); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// replace writes the whole list in ONE transaction. A source can therefore never
// exist without its schedule, and a schedule can never outlive its source.
func (s *pgFeedStore) replace(ctx context.Context, guildID string, sources []feedSource) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	// A rollback after a successful commit is a no-op, so this is safe on both
	// paths.
	defer func() { _ = tx.Rollback(ctx) }()

	keep := make([]string, 0, len(sources))
	for _, src := range sources {
		name := strings.TrimSpace(src.Name)
		var id int64
		if err := tx.QueryRow(ctx, `
			INSERT INTO feed_sources (guild_id, name, url, adapter, channel_id, message,
			                          mention_role_id, include_text, exclude_text, enabled)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
			ON CONFLICT (guild_id, name) DO UPDATE SET
			  url = EXCLUDED.url, adapter = EXCLUDED.adapter,
			  channel_id = EXCLUDED.channel_id, message = EXCLUDED.message,
			  mention_role_id = EXCLUDED.mention_role_id,
			  include_text = EXCLUDED.include_text, exclude_text = EXCLUDED.exclude_text,
			  enabled = EXCLUDED.enabled, updated_at = now()
			RETURNING id`,
			guildID, name, strings.TrimSpace(src.URL), src.Adapter, src.ChannelID, src.Message,
			nullIfEmpty(src.MentionRoleID), nullIfEmpty(src.IncludeText), nullIfEmpty(src.ExcludeText),
			src.Enabled,
		).Scan(&id); err != nil {
			return err
		}

		// The schedule IS the poll cadence: `scheduled_jobs` rows are what the
		// worker's tick materializes. `next_run_at` is set only on INSERT, so
		// editing a feed's cadence does not reset its rhythm and a save cannot
		// stampede every feed at once.
		if _, err := tx.Exec(ctx, `
			INSERT INTO scheduled_jobs (guild_id, name, job_kind, schedule_kind, schedule_expr,
			                            timezone, payload, enabled, next_run_at)
			VALUES ($1,$2,'feed.poll','interval',$3,'UTC',
			        jsonb_build_object('source_id', $4::bigint), $5, now())
			ON CONFLICT (guild_id, name) DO UPDATE SET
			  job_kind = 'feed.poll', schedule_kind = 'interval',
			  schedule_expr = EXCLUDED.schedule_expr, payload = EXCLUDED.payload,
			  enabled = EXCLUDED.enabled, updated_at = now()`,
			guildID, name, strconv.FormatInt(src.PollIntervalSecs, 10), id, src.Enabled,
		); err != nil {
			return err
		}
		keep = append(keep, name)
	}

	// Gone from the list means gone. The schedule goes first so the poller cannot
	// be handed a source id that is about to disappear.
	if _, err := tx.Exec(ctx, `
		DELETE FROM scheduled_jobs
		 WHERE guild_id = $1 AND job_kind = 'feed.poll' AND NOT (name = ANY($2))`,
		guildID, keep); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM feed_sources
		 WHERE guild_id = $1 AND NOT (name = ANY($2))`,
		guildID, keep); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// handleAdminFeeds is GET|POST /api/admin/feeds: the poll list and its editor.
func (s *server) handleAdminFeeds(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet, http.MethodPost) {
		return
	}
	if !s.requireAdmin(w, r) {
		return
	}
	if s.feeds == nil {
		writeRefusal(w, r, http.StatusServiceUnavailable, "feeds_unavailable", errs.CategoryInternal,
			"feed store is not configured (FUDCOURT_PG_URL unset)")
		return
	}
	guildID := s.discord.effective(r.Context()).GuildID
	if guildID == "" {
		writeRefusal(w, r, http.StatusServiceUnavailable, "feeds_unavailable", errs.CategoryInternal,
			"no guild configured (FUDCOURT_GUILD_ID unset)")
		return
	}
	if r.Method == http.MethodGet {
		s.writeFeedList(w, r, guildID)
		return
	}
	var req struct {
		Feeds []feedSource `json:"feeds"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation,
			"body must be a JSON object")
		return
	}
	if len(req.Feeds) > maxFeedSources {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation,
			"at most 50 feeds are allowed")
		return
	}
	seen := make(map[string]bool, len(req.Feeds))
	for i, src := range req.Feeds {
		if msg := validateFeedSource(src); msg != "" {
			writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation,
				fmt.Sprintf("feeds[%d]: %s", i, msg))
			return
		}
		name := strings.TrimSpace(src.Name)
		if seen[name] {
			writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation,
				fmt.Sprintf("feeds[%d]: duplicate name %q", i, name))
			return
		}
		seen[name] = true
	}
	if err := s.feeds.replace(r.Context(), guildID, req.Feeds); err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal,
			"feed write failed")
		return
	}
	s.writeFeedList(w, r, guildID)
}

// writeFeedList answers with the CURRENT rows, not the request body: the
// worker-owned fields (health, primed, owed) are only knowable from the store.
func (s *server) writeFeedList(w http.ResponseWriter, r *http.Request, guildID string) {
	sources, err := s.feeds.list(r.Context(), guildID)
	if err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal,
			"feed query failed")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"feeds": sources})
}


# Discord bot — implementation plan (sequence + status)

Executed in dependency order. A phase is "done" only when its tests/build/lint pass
against the real repo — no green-by-disabling. Status is the truth, not the intent.

## Status board

| # | Phase | Status | Evidence / note |
|---|---|---|---|
| 0 | Repository audit | ✅ done | fudcourt monorepo; bot built in-tree per §28 |
| 1 | Architecture foundation | ✅ done | `src/framework/*` (gateway/rest/stores/client), config from `apps/api` loopback, `/healthz` `/readyz` on the api |
| 2 | Identity / auth / permissions | 🟡 partial | precondition tiers by role **id** + hierarchy checks shipped; DB-backed **capability** engine + Discord OAuth dashboard login pending |
| 3 | Discord core | ✅ done | gateway v10 state machine, slash + context-menu routers, precondition middleware, error responder |
| 4 | Moderation | ✅ done | full case lifecycle, case numbers, `/case` `/history`, hierarchy refusals (commit `c84edde`) |
| 5 | AutoMod / anti-spam | ✅ done | rule engine (13 matchers) + deterministic scoring + window state + service + listeners/intents + `automod_rules` store & loopback read; live E2E proven (commits `15ce98a`,`0c875c7`,`b886fb7`,`5007dcd`) |
| 6 | Logging / audit | ✅ done | per-category activity logs (7 categories → routed channels) + audit trail (before/after JSONB); bot mappers + logger + audit client, api store/routes/internal reads; live E2E proven |
| 7 | Community features | ⬜ todo | welcome/goodbye, autoroles, reaction/button/select role panels |
| 8 | Custom commands | ⬜ todo | declarative only; no executable scripting |
| 9 | Worker foundation | ⬜ todo | durable job claim (`FOR UPDATE SKIP LOCKED`), retry/backoff, idempotency |
| 10 | Scheduler | ⬜ todo | one-time / interval / cron, explicit TZ, restart-safe |
| 11 | Feeds | ⬜ todo | adapter pipeline + dedup + SSRF guard on generic HTTP |
| 12 | API surface | 🟡 partial | settings + moderation cases live; remaining resource groups pending |
| 13 | Dashboard | 🟡 partial | admin panel (config + cases); remaining IA pages pending |
| 14 | Integration testing | 🟡 partial | moderation E2E smoke proven live; cross-feature flows pending |
| 15 | Security hardening | 🟡 partial | hierarchy, loopback gate, contract gate (no public internal proxy); SSRF/CSRF/regex passes pending per new feature |
| 16 | Performance review | ⬜ todo | after AutoMod lands (latency-sensitive hot path) |
| 17 | Deployment | 🟡 partial | fudcourt already deployed (Caddy/CF); bot service unit pending |

## Ordering rule

Each phase must pass its own tests before a dependent phase starts. When a test
fails: diagnose root cause → fix → rerun targeted → rerun affected suite → continue.

## Phase 5 as delivered — AutoMod / anti-spam

1. **Rule model** — `automod_rules` (jsonb `matchers`/`actions`, `text[]` exemptions),
   validated on both sides before use; enabled/priority/event are real columns, one
   composite index covers the bot's "enabled, priority DESC" load.
2. **Matchers** (13) — mentions, duplicate, caps, emoji, invite, url, blocked_domain,
   blocked_word, regex (length-capped + ReDoS-shape rejected), attachment,
   new_account, rapid_join, spam. All pure, all unit-tested.
3. **Anti-spam state** — injectable `WindowStore` (in-memory default; a Valkey adapter
   drops in behind the same interface). Deterministic 0–100 score, bounded named terms,
   normal ≤30 / suspicious ≤60 / spam ≤80 / severe >80. No ML.
4. **Actions** — delete, warn, timeout, kick, ban, log_only, notify_mod, add_role,
   remove_role — the four moderation actions route through the **existing
   ModerationService** with `source="automod"`, so the case log and hierarchy checks
   are shared; delete/role go through a narrow `DeliveryPort`.
5. **Exemptions + cooldown** — exempt roles/users/channels short-circuit; per-rule
   cooldown suppresses re-fire and starts after a fire.
6. **Gateway intents** — `INTENTS_BOT = GUILDS|GUILD_MEMBERS|GUILD_MESSAGES|MESSAGE_CONTENT`
   (MESSAGE_CONTENT is privileged — enable it in the app portal).
7. **Tests** — 12 engine + 11 state + 12 service + 16 wiring/listener (bot) and 6 Go
   handler tests; live E2E proven (api row → `{"rules":[…]}` → bot `parseRule`, 0 rejects).

**Still open in phase 5:** a dashboard panel to author/enable rules (the api already
exposes the loopback read; a rule CRUD admin route + panel is the remaining slice),
and swapping the in-memory window store for a Valkey-backed one if a second process
ever needs to share the windows.

## Phase 6 as delivered — Logging / audit

1. **Two trails, deliberately separate.** *Activity* logs mirror Discord events
   (message delete/edit, member join/leave/update, voice, channel); *audit* records
   changes to the bot itself. They share no table and no read path.
2. **Activity routing** — `log_destinations` holds one (guild, category → channel)
   row; categories are a closed set (`message, member, role, voice, channel,
   moderation, automod`). The bot loads the ENABLED map over loopback
   (`GET /api/internal/log-config`) and posts one embed per event; an unrouted
   category no-ops.
3. **Pure mappers** — `src/logging/events.ts` turns a raw gateway payload into
   `{category, embed}` with no client/REST, so the log shape is unit-testable
   (9 mapper tests). `ActivityLogger` (routing) + `AuditLog` (loopback POST) are
   tiny and fully injectable.
4. **Shared action log** — a completed moderation action (Discord **or** dashboard
   **or** AutoMod) mirrors one embed to the `moderation` channel; AutoMod firings
   log to `automod` from the AutoMod service (one embed per firing, not two).
   Best-effort: a log that cannot be delivered never fails the action.
5. **Audit trail** — `audit_logs` (actor, action, resource_type/id, `before`/`after`
   JSONB, source ∈ dashboard|discord|automod|system). Both origins write one row:
   the api records its own mutations (e.g. settings POST captures before/after) and
   the bot POSTs its changes to `POST /api/internal/audit`. Read back newest-first
   via `GET /api/admin/logs/audit` (limit/offset + resource filter).
6. **Tests** — bot: 9 mapper + 4 logger/audit + 4 wiring + 2 moderation-log + 2
   automod-log; api: 12 Go handler tests (loopback gate, admin gate, envelopes,
   validation, round-trip). 186 bot tests pass, `tsc` clean, `go build`/`vet`/`test`
   green. Live E2E: internal read returns the enabled map, an audit POST persists
   with the configured guild id, an unrouted/disabled category is absent.

## Next phase — 7, Community features

## Guardrails carried through every phase

- No secret in logs; no committed secret; `.env.example` stays the only env contract.
- Internal bot routes stay loopback-only and public-proxy-free (contract gate).
- No per-message DB query on the hot path — config/rules cached, refreshed on change.

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
| 6 | Logging / audit | ⬜ todo | Discord activity logs (per-destination) + audit before/after |
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

## Next phase — 6, Logging / audit

Discord activity logs (per-destination) + audit before/after, delivered as a
JSONB-configured log router (members, messages, moderation, voice), with the
destination set editable from the dashboard.

## Guardrails carried through every phase

- No secret in logs; no committed secret; `.env.example` stays the only env contract.
- Internal bot routes stay loopback-only and public-proxy-free (contract gate).
- No per-message DB query on the hot path — config/rules cached, refreshed on change.

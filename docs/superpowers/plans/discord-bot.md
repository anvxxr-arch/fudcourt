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
| 5 | AutoMod / anti-spam | ⬜ next | rule model + Valkey windows + deterministic scoring; **this is the current phase** |
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

## Current phase — 5, AutoMod / anti-spam (plan)

1. **Rule model** — `automod_rules` (JSONB `matchers`/`conditions`/`actions`, validated
   before store), enabled/priority/exempt_{roles,users,channels}/cooldown. Config lives
   in Postgres, not code.
2. **Matchers** — spam, duplicate, mass-mentions, caps, emoji, invites, URLs, blocked
   domains/words, regex (bounded / safe engine), attachments, new-account, rapid-join.
3. **Anti-spam state** — Valkey counters/windows per user; deterministic 0–100 score
   (normal ≤30 / suspicious ≤60 / spam ≤80 / severe >80). No ML.
4. **Actions** — delete, warn, timeout, kick, ban, log_only, notify_mod, add/remove
   role — routed through the **existing moderation service** (same path as `/ban`), so
   AutoMod never forks moderation logic.
5. **Exemptions + cooldown** — exempt roles/users/channels short-circuit; per-rule
   cooldown suppresses re-fire.
6. **Gateway intents** — add `GUILD_MESSAGES | MESSAGE_CONTENT` (+ `GUILD_MEMBERS`
   for join matchers); keep GUILDS.
7. **Tests** — matcher unit tests, scoring determinism, exemption tests, "AutoMod
   action creates a moderation case" (shared-logic proof), bounded-regex guard.

## Guardrails carried through every phase

- No secret in logs; no committed secret; `.env.example` stays the only env contract.
- Internal bot routes stay loopback-only and public-proxy-free (contract gate).
- No per-message DB query on the hot path — config/rules cached, refreshed on change.

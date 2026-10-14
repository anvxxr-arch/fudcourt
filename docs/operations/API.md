# Go API (apps/api) — deployment & performance record

> Landed 2026-10-09 (the apps/api optimization pass: SWR cache + provider
> transport, response hardening, startup prewarm, deploy). Every number was
> measured on this host with the harness in §4 — never estimated. This is the
> regression reference for :3103: a later change may not make any row worse.

## 1. Deployment

- **Unit**: `fudcourt-api.service`, installed as a systemd **user** unit
  (`~/.config/systemd/user/fudcourt-api.service`, byte-identical to
  `deploy/systemd/fudcourt-api.service`), `enabled`, and the account carries
  `Linger=yes` — the service starts at boot and survives logout. Control:
  `systemctl --user {status,restart} fudcourt-api`; logs:
  `journalctl --user -u fudcourt-api` (JSON slog lines).
- **Artifact**: `ExecStartPre=/usr/bin/go build -C apps/api -o bin/fudcourt-api .`
  rebuilds `apps/api/bin/fudcourt-api` (git-ignored) on every start, so the
  deployed binary is always the working tree's build.
- **Env**: `EnvironmentFile=/home/dwizzy/fudcourt/.env` +
  `FUDCOURT_API_ADDR=127.0.0.1:3103` — loopback only; the only ingress is the
  Next BFF / Cloudflare tunnel (DR-002).
- **Redeploy 2026-10-09 17:04:59 UTC** (runs 2-5 of this pass onto the live
  port): `systemctl --user restart fudcourt-api` → journal shows the old PID
  `{"msg":"shutting down","signal":"terminated"}` → `Stopped` (clean, no
  `failed`) → `ExecStartPre … status=0/SUCCESS` → new PID 2015656
  `{"msg":"api listening"}` **0.75 s** later; `Memory: 17.4M (peak 72.8M)`.
  Downtime on :3103 ≈ 0.75 s.
- **Prewarm log on every boot**: exactly one JSON line —
  `{"msg":"members prewarm ok","members":N}` when Discord is configured, or
  (what this host logs, because `.env` carries no `FUDCOURT_GUILD_ID`/
  `FUDCOURT_BOT_TOKEN`)
  `{"msg":"members prewarm skipped-or-failed","reason":"discord not configured"}`.
- **Pre-existing config, deliberately untouched**: `.env` has no
  `FUDCOURT_CLIENT_ID`/`FUDCOURT_CLIENT_SECRET`/`DISCORD_REDIRECT_URI` →
  `/api/auth/login` answers `500 auth_unconfigured`; no
  `FUDCOURT_SESSION_SECRET` → the fail-closed floor means no session ever
  verifies, so `/api/admin/members` live answers 401 for every caller.

## 2. Behavior (the code behind the numbers)

| Concern | Fact |
|---|---|
| Members cache | in-process TTL, `membersTTL` **60 s**, stale-while-revalidate: fresh = memory; stale = served immediately while **one** background refresh runs (single-flight per key); cold miss = inline fetch capped at `membersFetchTimeout` **2 s** → 503; failures are never cached. Key = `guild + membersListLimit(100)` — server config, never request input (`internal/platform/cache`) |
| Startup prewarm | `go api.prewarmMembers()` after the listener goroutine starts; detached, own 2 s cap, never blocks startup; **not** in the `/readyz` registry — an optional provider outage must not flip readiness (justified in the method comment); cold-miss fallback on any failure |
| Provider transport | one shared `http.Transport` (`DefaultTransport` clone): `MaxIdleConns` 64, `MaxIdleConnsPerHost` **16** (stdlib default 2), `IdleConnTimeout` 90 s, plus a bounded drain of error bodies so failed attempts stay poolable |
| Hardening headers | every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` (JSON-only surface); `Strict-Transport-Security: max-age=31536000` **only** when `r.TLS != nil` or `X-Forwarded-Proto: https` (tunnel terminates TLS, DR-002) |
| Cache-Control | `/healthz`, `/readyz`, `/api/auth/{login,callback,logout}` → `no-store`; `/api/admin/members` → `private, max-age=30` (browser window deliberately shorter than the 60 s server TTL); routes with no decided policy get no header |
| gzip | `application/json` only, body ≥ **1 KiB** (`gzipMinBytes`), consent parsed with q-values (`gzip;q=0` refuses, explicit beats `*`), `gzip.BestSpeed` and only when strictly smaller, exact `Content-Length`, `Vary: Accept-Encoding` on all JSON; health probes/error envelopes stay byte-identical identity |

## 3. Measured performance (2026-10-09, this host)

Loopback, keep-alive, n=20 000 unless noted. Where upstream is involved the
fake Discord answers after **120 ms** (real RTT from this box: 120 ms warm /
390 ms cold TLS, run-1 measurement).

| Case (p50 / p95 / p99) | Before | After |
|---|---|---|
| `/healthz`, run-2 binary → live run-5 | 0.149 / 0.230 / 0.300 ms | **0.199 / 0.275 / 0.333 ms** |
| `/api/admin/members` 401 (no session), run-1 → live | 0.209 / 0.328 / 1.009 ms | **0.203 / 0.286 / 0.360 ms** |
| members success path, hot (upstream 120 ms) | 121.5 / 122.6 / 124.3 ms (every request fetched) | **0.272 / 0.420 / 0.954 ms** (0 upstream calls in 30 000 requests) |
| stale read (>60 s old) | blocked on upstream | **0.866 ms** + background refresh (one call) |
| first authenticated request after process boot | 122.0 / 122.4 / 122.6 ms | **0.638 / 1.338 / 1.167 ms** when prewarm wins; 121.6 ms if the request beats it (never worse than before) |
| upstream down → 503 | 4.28 ms | **0.96 ms** (fail-fast, failure not cached, heals on retry) |
| admin members body, gzip on/off | 8 183 B identity (no compression existed) | **714 B** at p50 0.670 ms (−91.3 % bytes, +0.4 ms) |
| `/healthz` with `Accept-Encoding: gzip` | — | identity (28 B under floor), `Vary` present, p50 delta 0.000 ms |
| concurrency reference, `hey -c 50 /healthz` (run-1) | p50 1.2 ms, p99 7.3 ms, 29 831 req/s | unchanged mechanism |

Live verification after the restart (17:05 UTC): `/healthz` **200** with the
full hardening set + `Cache-Control: no-store`; `/readyz` **200**;
`/api/admin/members` **401** with `Cache-Control: private, max-age=30`;
`/api/auth/login` 500 (`auth_unconfigured`, pre-existing); gzip offered on
`/healthz` returns the identity body with `Vary: Accept-Encoding`;
`hey` /healthz avg **0.1 ms, 7 702 req/s**. The ≤5 ms local-latency target
holds with every middleware in the chain.

## 4. Harness & gates

- Benchmarks: `/tmp/bench_api.py` (python `perf_counter`, keep-alive,
  optional `BENCH_COOKIE`/`BENCH_AE`/`BENCH_PORT`) + `hey` cross-check; fake
  upstream `/tmp/discordfake.go` (`-latency -fail-first -members`,
  `/__stats` counters). Scratch files — not part of the repo.
- Gates for this record (green at deploy): `go build ./apps/api/...`,
  `go vet ./apps/api/...`, `go test -count=1 ./apps/api/...` (7 packages),
  `go test -race -count=1 ./apps/api/...`, `gofmt` clean on every touched
  file, `python3 tests/integration/api/check-api-contract.py` →
  `API_CONTRACT_OK`.
- Known scope note: whole-module `go vet ./...` currently fails inside
  `apps/data/internal/ingest/**` — pre-existing, in-flight work outside
  apps/api; the unit's `go build -C apps/api .` does not compile it.
- Tests owning each behavior: `TestAdminMembersListCaching` (cold / hot /
  stale / upstream-failure), `TestMembersPrewarmServesFirstRequestHot`,
  `TestMembersPrewarmFailureFallsBackToColdMiss`, `TestResponseHardening`,
  httpx `TestHarden` / `TestCacheControlPolicy` / `TestGzipRoundTrip` /
  `TestGzipEligibility` / `TestGzipSetsVaryOnJSONIdentity`.

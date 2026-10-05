# Decision Records

## DR-001 — apps/web Next.js 14.2.0 → 16.3.6 ✅ Accepted (2026-09-28)

**Status:** accepted, deployed to production (`fudcourt-web` on :3100 runs 16.3.6).

**Context.** `apps/web` sat on Next 14.2.0 while `apps/blog` already ran
Payload/Next 16 — two majors apart meant two sets of security patches, two
toolchains, and a growing gap in shared patterns (docs claimed one stack,
repo ran two). R-3 in RECOMMENDATIONS called for either upgrading or
recording a documented exception.

**Spike.** Branch `spike/next16` in a separate git worktree
(`/home/dwizzy/fudcourt-next16`, later merged as `8329669`) so the live
checkout never ran a half-upgraded tree.

**What actually broke (both fixes landed before merge):**

1. **Async route params** — the only hard failure. Next 15+ types
   `context.params` as `Promise<{…}>`; `app/api/transactions/[id]/route.ts`
   (PUT/PATCH/DELETE) still declared the sync shape → TS2344 in Next's
   generated `validator.ts`. Fix: declare `params: Promise<{ id: string }>`
   and `await` it — backward compatible, `await` on a plain object works
   under 14 too.
2. **Turbopack dynamic-filesystem tracing** (warning): `execFile` in
   `app/api/cryptorank/route.ts` (runHelper spawning the python helper)
   made Turbopack trace the whole project into the output bundle. Fix:
   the sanctioned `execFile(/*turbopackIgnore: true*/ …)` marker.
3. **tsconfig auto-migration** by `next build` itself: `moduleResolution`
   `node`→`bundler`, `jsx` `preserve`→`react-jsx`, added
   `.next/dev/types` — committed as-is (Next wrote it, Next owns it).
4. React stayed at **18.3.1**: next@16 peer range still accepts `^18.2.0`,
   so no React major had to ride along.

**Evidence (why "accepted" and not "exception"):**

- `npm run build` RC=0 (Turbopack, ~1-9s compile), `tsc --noEmit` RC=0,
  `check-contract.py` OK (28 modes, mutation guards).
- Route sweep, re-aligned to the repurpose pass (latest measured **122/133**,
  2026-09-29, two byte-identical runs): 18 page checks = 13 HTML +
  `/robots.txt` + `/sitemap.xml` + 3 real-404s (`/coin`, `/balance`, `/ticker/FOO`),
  7×307 gate, 33 API GETs (incl. the ticker family), 7×401 fail-closed with no
  session, 58 cryptorank checks, and 10 session-gated probes. The 11 fails are
  environmental, zero regressions: 1 CoinGecko 403 passthrough + 10 session-gated
  probes unrunnable on the :3107 audit target (no `FUDCOURT_SESSION_SECRET` on
  that process) — both classes correct fail-loud, never a weakened check.
  Full breakdown: ARCHITECTURE §7.
- DOM audit (playwright/Chrome) on :3110 vs :3100: identical results —
  17 tables with identical row counts, all panels present, no NaN/
  undefined. The single failing check ("stats strip PRESENT") fails
  **identically on Next 14 production** → pre-existing check/UI drift,
  not a 16 regression (candidate cleanup for SG-3.4 harness precision).
- `mode=home` API body byte-identical across both instances (shared
  cache HIT, count=12).

**Consequences.**

- Production + CI now build with Turbopack; webpack path untouched/unused.
- Known benign warning remains: Turbopack infers workspace root from the
  repo's multiple lockfiles (root lock is stale — see RECOMMENDATIONS;
  silencing requires `turbopack.root`, deferred as noise).
- `next@16.3.6` exact-pinned (repo convention; `^` auto-written by npm
  was corrected back to exact).
- Blog and web now share one Next major → one patch train.

---

## DR-002 — Hosting: self-hosted on the homeserver; no Vercel publish (2026-09-28)

**Context.** `docs/operations/SECRETS.md` was auditing "Vercel ↔ local env parity" when
both probes came back negative: the CLI is unauthenticated and
`fudcourt.vercel.app` answers `404 DEPLOYMENT_NOT_FOUND` — a project shell with
no deployment. Owner decision (dwizzy): **"We don't publish on Vercel, let's
self hosting."**

**Options.** (a) Keep Vercel as a deploy target and finish the parity audit
when credentials exist; (b) hybrid — board stays on the homeserver, only the
public reader goes to Vercel; (c) drop Vercel entirely, production = this
homeserver.

**Decision. (c).** Production is the homeserver stack that already runs:
`fudcourt-web` (`127.0.0.1:3100`), `fudcourt-blog` (`127.0.0.1:3001`),
`fudcourt-sync.timer`. The tracked `apps/web/vercel.json` is deleted and its
`/portfolio` rewrite moves into `apps/web/next.config.js` (host-independent).
Exposure stays LAN/loopback today; publishing through the existing Cloudflare
tunnel would be a separate, explicit decision (mutation auth stays fail-closed
whenever it happens).

**Evidence.** Units active; board `200`; blog `200`; CI is gates-only (no
deploy step), so nothing in CI referenced Vercel; `DEPLOYMENT_NOT_FOUND`
measured 2026-09-28.

**Consequences.**

- The Vercel half of `docs/operations/SECRETS.md` §3/§5/§6 is retired — parity questions
  are moot by decision, not "unverified"; the runbook now documents the
  self-hosted units (SECRETS §3/§6 rewritten).
- Residual cleanup (optional, human): delete the three Vercel projects
  (`fudcourt`, `web`, `blog`) and the `.vercel/` dirs + the
  `VERCEL_OIDC_TOKEN` line in `apps/web/.env.local`.
- `NEXT_PUBLIC_FUD_MUTATION_TOKEN` is gone (see DR-003) — there is no longer a
  build-time secret in the client bundle.
- Managed data services (Turso, Neon) are unchanged — this decision is about
  compute hosting only.

**Follow-up (same day): published at `https://fc.dwirijal.my.id`.** Owner:
"Publish aja di fc.dwirijal.my.id untuk sementara." The existing Cloudflare
tunnel (`39bdfeef…`, config `~/.cloudflared/config.yml`) gained an ingress
`fc.dwirijal.my.id → http://127.0.0.1:3100` plus a proxied CNAME in zone
`dwirijal.my.id`. Origin stays loopback-only; verified over the public
hostname: `/` 200, `/cryptorank` 200 (real upstream JSON), `/portfolio` 200,
`DELETE /api/transactions/1` without token → **401** (fail-closed holds in
public), tunnel regression `ai.karepmuwes.my.id` + `zura.dwirijal.my.id` 200.

## DR-003 — Access tiers via Discord OAuth; retire `x-fud-token` (2026-09-28)

**Context.** A public-surface audit found the treasury readable by anyone:
`https://fc.dwirijal.my.id/api/transactions` returned 200 with 48 rows, 3
wallet addresses with owner aliases, USD amounts and 7 tx hashes. The same
audit found no `robots.txt` and no `sitemap.xml`, so nothing excluded `/api/*`.
Writes appeared protected by `x-fud-token`, but that header was sent from
`NEXT_PUBLIC_FUD_MUTATION_TOKEN` — Next inlines `NEXT_PUBLIC_` values at build
time, and the token was found verbatim in a public JS chunk. The guard was
effectively no guard.

**Owner direction.** Split the surface into four tiers — public / member / team
/ admin — with Discord OAuth as login, balance under `/team/balance`, public
market boards public, and `/admin` for account control. Discord server roles
are the source of truth for a user's tier; admin panel = users/roles + a
read-only audit of all data.

**Outcome.**
- One HMAC-signed, httpOnly `fud_session` cookie carries a **ranked** tier
  (`public < member < team < admin`), so admin implies team.
- Route policy is a single table in `lib/guard.ts` consumed by
  `middleware.ts`: protected pages redirect to `/login?next=…`, protected APIs
  answer JSON 401. Page-level `requireTier` and a server-side write check are
  defence in depth behind it.
- `x-fud-token` is **deleted**, not deprecated: the client sends no secret, so
  there is nothing to leak. Verified absent from every served script.
- `robots.txt` + `sitemap.xml` are generated from `lib/public-routes.ts`, the
  single source of truth for the 11 public URLs.

**Rejected.** Storing tiers in our own DB (chosen against: Discord roles
auto-revoke, and the DB would drift); a cookie per tier; `Disallow: /api/`
alone (a crawler rule is not an access control).

**Consequences.** Reads are no longer open on the LAN — the LAN was assumed to
be a trust boundary, and the public hostname made that assumption false. Any
consumer of the five treasury endpoints now needs a `team` session. A stolen
session cookie grants that tier for up to 7 days; rotating
`FUDCOURT_SESSION_SECRET` invalidates every session at once.
---
## DR-004 — Inbound rate limiting at the origin (2026-09-29)
**Status:** accepted, deployed (`fudcourt-web` on :3100, public hostname
verified).
**Context.** A security review of the public site measured the abuse path:
25 consecutive `GET /api/cryptorank?mode=converter` all answered **200** with
**921,588 bytes** each (~23 MB), and `&fresh=1` bypassed the app cache, so every
one reached the python upstream helper. `/api/ticker` — full board, 69,445 B and
a **64.5 s** cold upstream — behaved the same. The only limiter in the repo,
`lib/rate-limit.ts`, paces *outbound* calls (protecting DexScreener/CryptoRank
from us); nothing bounded what one client could ask the origin for.
**Options.**
1. **Cloudflare edge rules** — the right home for a distributed budget, but it
   is dashboard state, out of this repo's verification loop, and cannot know
   which of our routes is expensive.
2. **A flat per-IP request counter in the middleware** — simple, and wrong:
   `/api/cryptorank` spans 1,190,228 B (`mode=chain`) to 835 B (`mode=coin`), so
   any single number either throttles the cheap modes or protects nothing
   (60 × 921 KB is still 55 MB).
3. **A cost-weighted per-client budget in the middleware, priced from measured
   payload sizes** — what shipped.
**Decision. (3), with the stated limits.** `lib/rate-limit-inbound.ts` charges
each request the measured worst-case bytes of what it can return (unit =
50 KB, rounded up) against a fixed 60 s window: heavy routes 80 units, light
ones 120. `middleware.ts` enforces it on `/api/:path*` before the tier check and
tags every response with `X-RateLimit-*`; a refusal is a 429 with
`Retry-After`. Calibration is evidence, not intuition: the fattest mode is 20
units, and a full `/cryptorank` mount (9 fetches, measured in
`CryptorankPage.tsx`) is 32 units, so two mounts a minute still fit.
**Consequences.**
- The measured abuse path now ends in 429 on the fourth `mode=converter`
  request of a window (verified on the public hostname).
- Budgets scale by scope and identity: a signed-in caller gets 3×, and a caller
  whose peer address is the origin's own (never crossed the tunnel — DR-002
  makes the only ingress the Cloudflare tunnel, and Cloudflare always sets
  `CF-Connecting-IP` for it) gets 100×, so `monitor.py` and every `verify-*.py`
  run keep working.
- Keying resists spoofing: `CF-Connecting-IP` when present, otherwise the
  **last** `X-Forwarded-For` hop (a client can pre-seed earlier ones; trusting
  the first would mint unlimited identities).
- The limiter **fails open**: a counter bug must not take the public boards
  down, and in-memory counters do not touch the treasury database.
- Counters are per Node process and cleared on restart — one `next start`
  behind one tunnel today, so that is the whole population. A distributed budget
  stays Cloudflare's job; this is what the origin can enforce by itself.
- Page paths are deliberately exempt: they are SSR shells with no upstream
  fan-out, so a page budget would only make slow tabs fail. The absence of rate
  headers on a page is the record of that decision.
- Where it lives: PLAN G6, ARCHITECTURE §6, PRD NFR-4, ANALYSIS K-10. Offline
  tests `scripts/tests/rate-limit-tests.ts` run in the pre-push hook and CI with the
  other suites.
### DR-004 amendment — the local scope was dead on arrival (2026-09-29, same day)
**Found by:** the DR-005 cutover's live harness run, which reported two checks
as `got 429` and one of them (`converter`) is not in the `&fresh=1` abuse path
this limiter was built for. Chased to the limiter, not the cutover.
**What was wrong.** `clientKey()` decided `scope: 'local'` from the *absence* of
proxy headers. That state is unreachable on this deployment: Next.js 16
(`node_modules/next/dist/server/base-server.js:612`) runs
`req.headers['x-forwarded-for'] ??= originalRequest?.socket?.remoteAddress`, so
every request — including the operator's own `curl`/`python3` on loopback —
arrives carrying `X-Forwarded-For: ::ffff:127.0.0.1`. The `local` branch and
`LOCAL_MULTIPLIER` were therefore dead code, and the harness's stated protection
("`monitor.py` and every `verify-*.py` run keep working") had never once been
true: every request on this host was priced `scope: public`.
**Measured evidence.** `X-RateLimit-Scope: public` with `Limit: 80`/`120` on
loopback requests that send no proxy headers of their own; a full
`verify-cryptorank.py` run costs **137 units over 53 calls**
(`chain` ×3 @20 = 60, `converter` @20, `tag` ×3 @3 = 9, `tags` @2,
`blockchains` @2, the other 47 calls @1) against the 80-unit heavy window, so it
was refused from call ~25 — the two `429`s in the cutover harness, and they
persisted after a 75 s idle wait, which is what ruled out leftover state.
**Fix.** Scope is decided by the **peer address**, never by a missing header:
no `CF-Connecting-IP` (so it did not transit the tunnel) and a last
`X-Forwarded-For` hop that is loopback (`127/8`, `::1`, `::ffff:127.0.0.1`),
private (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16`,
`fe80::/10`) or ULA (`fc00::/7`) ⇒ `local`. Any `CF-Connecting-IP` ⇒ `public`,
which is what keeps a public caller from smuggling `X-Forwarded-For: 127.0.0.1`
through the tunnel into the local budget; any public last hop ⇒ `public`, keyed
on that hop as before. A missing last hop still counts as local (nothing
identified a remote client). Fail-open, the `X-RateLimit-Scope` header, and the
`MAX_CLIENTS` LRU bound are unchanged.
**Tests.** The old keying test asserted the unreachable branch; it is replaced
by the real table (loopback/`::ffff:127.0.0.1`/private/ULA/`[::1]`/`fe80::1%eth0`
⇒ local; `172.15`/`172.32`/`11.0.0.1`/`192.169`/public v6 ⇒ public; forged first
hop ignored; `CF-Connecting-IP` + forged loopback XFF ⇒ still public) plus a
regression test that the measured deployment case arrives local and that the
measured 137-unit harness mix fits the local budget. `npm run test:shapers`:
**79 tests, 0 fail** (was 78).
**Consequence to watch.** Any locally reachable but unauthenticated route can now
spend 100× while reached from the origin's own address space. That is the
intended operator allowance (and DR-002 keeps the only ingress the tunnel), but
it becomes a real question the day a second, non-proxy ingress is added — the
allowance would then need to key on something else.
### DR-004 amendment 2 — the harness-budget question is CLOSED: the local scope already answers it (2026-10-05)
**Status:** accepted, measured on the live origin. **No code change.**
**Found by:** the residual `[Fudcourt] DR-004 open: harness budget for
verify-cryptorank.py under :3100 middleware` (kanban `t_7327e6d9`, a child of the
2026-10-05 tracker), which re-opened SG-7.6 residual #2 and framed the fix as a
choice between two NEW mechanisms (Option A — a declared `X-Local-Operator`
header + a third scope class; Option B — a per-route harness allowance in
`ROUTE_COST`).
**What was claimed.** That `verify-cryptorank.py` "cannot complete a full run
through the `:3100` middleware under the DR-004 budget it helped calibrate":
137 units over 53 calls against the 80-unit heavy window ⇒ 429 from call ~25,
"exactly the two `got 429` failures the cutover harness reported", because the
harness is priced `scope: public`.
**What is measured now.** Both halves of that claim are false on the current
tree, and the first amendment (SG-6.5) is the reason:
- **The scope is `local`, not `public`.** `GET :3100/api/cryptorank?mode=chain`
  answers `X-RateLimit-Scope: local`, `X-RateLimit-Limit: 8000` (heavy) and
  `?mode=coin` answers `Limit: 12000` (light) — `HEAVY_ALLOWANCE × LOCAL_MULTIPLIER`
  and `LIGHT_ALLOWANCE × LOCAL_MULTIPLIER`. `clientKey()` decides scope from the
  **peer address** (amendment 1), so the harness's `X-Forwarded-For:
  ::ffff:127.0.0.1` from Next 16 `base-server.js:612` is classified local, exactly
  as the amendment intended.
- **The run completes with ZERO rate-limit failures.** A full
  `verify-cryptorank.py --base http://127.0.0.1:3100` run: **0 checks mention
  `429`** anywhere in the run log or the report. Diffed against the same session's
  `--base http://127.0.0.1:3101` run, the fail sets are **30 common / 3 :3100-only**
  and the 3 extras are `launchpool` checks whose detail is `got 0` (a
  connection refusal), not `got 429` — they are a sibling session restarting
  `fudcourt-web` mid-run (`ExecMainStartTimestamp` moved 08:09:24 → 08:12:24 →
  08:16:16 while this card ran), not the limiter. The 30 common fails are the
  retired-`/cryptorank` shell/component block and world-state checks that are
  **byte-identical across both bases** (card `t_dc1fa218` owns them).
- **The call table is confirmed, and it is not 53 calls of network `get()`.**
  AST count of the harness: **55** `get()` call sites. Of those, the ones that
  reach `/api/cryptorank` and are cost-weighted (`chain` ×3 @20, `converter` @20,
  `tag` ×3 @3, `tags` @2, `blockchains` @2, the rest @1) sum to **exactly 137
  units** — matching SG-6.5. 137 ≪ 8000 local, so no window is approached. (The
  "53 calls" figure in the card and in SG-7.5b's narrative is an approximation;
  the unit total is the figure that matters and it is reproduced here.)
- **The public budget is untouched.** A forged `CF-Connecting-IP` replay through
  `:3100` (`GET /api/cryptorank?mode=converter` ×6) answers
  **`200 200 200 200 429 429`** — scope `public`, limit 80, cost 20 — i.e. the
  SG-6.4 abuse wall is intact and the local allowance does not leak into it.
**Decision. Neither Option A nor Option B.** The scope class the card proposed to
ADD (`local`, distinguished from `public`) already exists and already fires for
this caller; adding a third class or a parallel harness budget would be a second
mechanism for a problem amendment 1 already solved, and a declared header (Option
A) would be a *weaker* signal than the socket peer the module reads today. The
residual was a **stale record** — SG-7.5b's `235/5` reading was taken before the
amendment-1 fix was deployed (its own text says the harness "is priced
`scope: public`"), and the card inherited that wording — not a live defect.
**Consequences.**
- SG-7.6 residual #2 is **closed** as "already fixed by amendment 1"; the PLAN
  bullet and the CHANGELOG row carry the closure.
- The lesson recorded: a residual written against a pre-fix measurement must be
  **re-measured against the live origin before a fix is scoped** — the card spent
  two option designs on a bug that the preceding amendment had already closed.
  The tell was available: `curl -D -` on `:3100` prints `X-RateLimit-Scope`, so
  the claim was falsifiable in one request.
- No header, no allowance multiplier, no new scope constant, and no change to
  `ROUTE_COST`, `clientKey`, `middleware.ts`, or the public budget. The limiter
  module and its 16 offline tests are unchanged.
---
## DR-005 — CryptoRank runtime: Python helper → Go `apicalls` sidecar (2026-09-29)
**Status:** accepted, deployed (`fudcourt-apicalls` :3101 + cut-over
`fudcourt-web` :3100; harness re-run against the cut-over origin).
**Context.** Every CryptoRank mode was served by `app/api/cryptorank/route.ts`
shelling out to `scripts/oracle/cr_fetch.py` under a dedicated `curl_cffi` venv. That
worked, but it made the repo's most load-bearing data family depend on a
subprocess spawn per fetch, a Python venv on the host, and a second
implementation of validation/shaping logic — while the fetch itself only ever
needed one thing Python had and TypeScript did not: a browser-grade TLS
fingerprint. A spike asked whether Go could hold that fingerprint natively.
**Options.**
1. **Stay Python.** Zero migration risk, keeps the working path — but keeps the
   spawn-per-request cost, the venv as an unversioned host dependency, and the
   split-brain mode table.
2. **Pure Go**, no Python anywhere. Removes the venv; but it also removes
   `verify-cryptorank.py`'s only independent oracle, turning the harness into a
   self-confirmation (the harness's own decoy detector is built on having a
   *second* client).
3. **Go runtime + Python oracle** — Go serves, `cr_fetch.py` is retained solely
   as the verifier's independent cross-check.
**Decision. (3).** `services/data` (Go, `fudcourt-apicalls` on
`127.0.0.1:3101`) owns mode/key validation, the disabled-mode refusal, the disk
cache, the 429 backoff and the fetch. `app/api/cryptorank/route.ts` becomes a
thin honest proxy: same query string forwarded verbatim, upstream status/body
and `X-CR-Upstream`/`X-CR-Cache`/`Cache-Control` returned unchanged, 502 with
the real reason when the sidecar is down. No validation and no shaping stay in
TS — a second implementation of a rule is a second place for it to drift.
**Measured evidence** (spike 2026-09-29, `/home/dwizzy/apicalls-probe/RESULTS.txt`;
15 upstream GETs, spaced ≥2 s):
- Cloudflare fingerprints the TLS **ClientHello**, not the headers. On
  `/all-coins-list`: `net/http` + full Chrome 131 headers → **403**
  (`cf-mitigated: challenge`, 5,979 B); `uTLS HelloChrome_131` over **h1** →
  **403** (6,022 B); the same over **h2** → **200** / 738,673 B; `tls-client`
  `chrome_131` → **200** / 738,673 B with `__NEXT_DATA__` 177,442 B. A
  Chrome-131 ClientHello **and** HTTP/2 are each necessary; neither alone is
  sufficient.
- Header **order** was *not* required (variant C2b dropped `HeaderOrderKey` and
  still got 200 / 177,442) and browser-like header *values* were not what was
  being checked (B1/B2 had both and still got 403 on Go's TLS stack).
- Go matches the Python baseline at the JSON level: same buildId `45c3c525`,
  `coins[0]` identical (`bitcoin`, `price.USD 83553.22691715157`), two
  consecutive Go runs byte-identical.
**Consequences.**
- **New failure mode: the sidecar is a dependency.** If `apicalls` is down the
  board is down — by design loudly (502 naming the real reason), never a fake
  200. The unit is `Restart=always`/`RestartSec=5` and versioned at
  `services/data/deploy/fudcourt-apicalls.service`.
- **`tofu`-class risk: Cloudflare rule rotation.** The bundled `chrome_131`
  profile can stop matching (or start binding to a JA4/JA4H hash the profile does
  not cover) and a pinned binary would then get 403s silently. Mitigation: the
  403 carries `cf-mitigated: challenge` and is surfaced as a hard, alarmable
  failure — never parsed as "no data". The profile itself is a one-line version
  bump.
- **Toolchain floor `go >= 1.24.1`** — both `fhttp v0.6.9` and
  `tls-client v1.16.0` declare it (`go.mod: go 1.24.1`). The workstation ships
  go1.23.3, so builds rely on `GOTOOLCHAIN=auto` resolving the locally cached
  go1.24.1; CI pins `go-version: '1.24.1'` via `actions/setup-go@v5`. The
  pre-push hook builds offline against the cached toolchain.
- One contract, two implementations is now enforced offline:
  `apps/web/scripts/checks/check-contract.py` *(superseded: the repo-wide contract gate now lives at
  `scripts/verify/check-contract.py`, and the app-local layer gate at
  `frontend/web/scripts/checks/check-structure.py` — paths as of 2026-10-01)* parses the Go table in
  `services/data/internal/cryptorank/modes.go` *(superseded: `backend/data/internal/research/cryptorank/modes.go`)* and asserts it equals the TS mirror
  in `lib/cryptorank.ts` *(superseded: `frontend/web/src/features/cryptorank/client.ts`)* (modes, disabled set, exchange/launchpool/nodesale/RWA
  whitelists, keyed + default-key maps), and additionally asserts the route is
  still a proxy (no `execFile`, no python path, no local validation).
- Politeness unchanged: the disk cache (`APICALLS_CACHE_DIR`, default TTL 60 s)
  was carried over from `cr_fetch.py`, so request volume to cryptorank.io does
  not rise.
- Compatibility is **field-for-field, not byte-for-byte** (corrected by the
  sidecar's own audit, 2026-09-29): bodies are framed by `Encoder.Encode`, so
  they end in one trailing newline, and JSON key order is Go struct order rather
  than the TS insertion order. Measured on `mode=home`: identical key set,
  identical key order, values deep-equal, and byte-identical only after
  trimming that newline. Every consumer parses JSON, so the surface is
  unchanged — but the claim in the route's header comment was wrong as written
  and now states this caveat.
- **Verification, and what the harness proves now.** Cut over, the live harness
  is `241 passed / 3 failed / 8 info` when pointed straight at the sidecar
  (`--base http://127.0.0.1:3101`) and `235/5/8` through the :3100 proxy in the
  same session. The **2-check difference is exactly the DR-004 inbound limiter**,
  not the cutover: `verify-cryptorank.py` makes ~55 calls and its own mix spends
  more than one window (`chain` is priced 20 units and called 3×, `converter` 20
  units), so one run exhausts the 80-unit heavy budget by itself. Against the
  sidecar there is no limiter in the path and those two checks pass. The other
  3 failures in both runs are path-independent (measured by running the TS
  `envelope()` over the same upstream payload): one upstream content rotation
  (`/news` now carries a publisher-less CryptoRank spacer row, `url: null`) and
  the `aioverview` dominant-phrase regex (upstream rotated its digest template
  to "BTC dominance are essentially flat", so the harness's `dominance … <n>`
  pattern finds no number even though both clients return identical text), plus
  two `shell:` checks whose strings upstream-of-me moved from `app/page.tsx` into
  `app/store/store-shell.tsx` in a different session's SPA refactor.
- Where it lives: PLAN G7, DR-005 consequences in ANALYSIS K-4/K-10,
  ARCHITECTURE §2/§4/§7/§8, TECH-STACK §1/§2/§4/§5, SECRETS §1/§4.
---
## DR-006 — `khala` family: a research-report adapter on a plain-`net/http` client, one Go package, no TS mirror (2026-09-29)
**Status:** accepted; **served** (updated 2026-09-29 ~13:00 UTC). The earlier
"landed, not served" record this paragraph used to carry was correct at 11:42 and is
superseded by SG-8.3: `cmd/apicalls/main.go` registers `handleKhala` on `/api/khala`,
`/healthz` reports `{"build":"28 modes","khala":"3 modes"}`, and the `bun run build` on
`:3100` carries the route — measured `GET :3101/api/khala?mode=reports` → **200**,
`GET :3100/api/khala?mode=reports` → **200**, and the same path on the public hostname →
**200**. Two real defects were found by running the live harness and fixed in the Go
code, not by widening a check: `fullTitle` collapsed whitespace (so `metaTitle` lost the
double space the page itself publishes before `- Khala Research`), and `fetch` still sent
`If-None-Match` on `?fresh=1`, letting a 304 answer the live-refetch request with a cache
`HIT`. `verify-khala.py` against the served sidecar: **136 passed / 0 failed / 0 skipped**.

Landed and read: `services/data/internal/khala/{modes,fetch,parse,
shape}.go` (+ tests, 6 fixtures in `testdata/`), `apps/web/app/api/khala/route.ts`,
`apps/web/lib/khala.ts`, `KhalaPage.tsx`, `app/khala/page.tsx`, the `store-shell.tsx`
tab/render, `lib/public-routes.ts`, `ROUTE_COST.khala = 2`, and
`apps/web/scripts/verify/verify-khala.py`. The verifier's recorded artifact
(`apps/web/scripts/khala-report.json`, mtime 11:42:40) reports **133 pass / 1 fail / 0
skip** in 5.5 s against a **scratch `:4101` adapter** — not the production origin, and
not a run performed by this record's author, so **GATED is not claimed**. The design is
frozen (contract **v4**); the PLAN goal (G8) carries the per-item build state.
**Context.** The repo's spine is *one family = one route + one lib contract + one
verifier* (ARCHITECTURE §4). A new family arrives whose upstream is
**https://www.khala.io** — Khala Research, a **Framer** static-site publisher (not
Next.js: `__NEXT_DATA__` = 0, RSC flight = 0 over the 259,008-byte homepage) serving
**8 research reports** and nothing else. Two obvious moves are both wrong here, and the
plumbing forces both to be recorded: (a) reuse `cryptorank`'s browser-TLS stack because
"that is how this repo fetches things", and (b) clone the cryptorank family's shape — a
three-package Go split plus a TS `lib/khala.ts` mirror kept equal by `check-contract.py`.
**Evidence artifact.** `/home/dwizzy/khala-probe/RESULTS.md` — a **read-only probe run
2026-09-29**, scratch **outside the repo** (nothing under `/home/dwizzy/fudcourt` was
modified; the repo never imports or executes it). Design record:
`/home/dwizzy/khala-probe/DESIGN.md`.
**Options.**
1. **Reuse `cryptorank`** (tls-client `chrome_131` + HTTP/2) for khala.
2. **Clone the cryptorank shape** — `internal/{kmodes,khfetch,kshape}` + `lib/khala.ts`
   + a `check-contract.py` `check_go_table` pair.
3. **One plain-`net/http` Go package, a verbatim-proxy TS route, no TS mirror.**
**Decision. (3), with the boundaries stated.**
1. **Plain `net/http`, NOT the tls-client `chrome_131` stack — and no shared fetch
   layer.** Measured: with a non-browser UA (`-A 'fudcourt/1.0'`) khala.io returned
   **200 / 259,008 B** on the homepage, **200 / 468,140 B** on a report page and
   **200 / 332,418 B `application/json`** on the `framerusercontent.com` search index;
   no 403, no `cf-mitigated: challenge`, no "Just a moment" anywhere (RESULTS.md §1).
   No Cloudflare in the path at all — `www.khala.io` is Framer's own edge and
   `framerusercontent.com` is AWS CloudFront (RESULTS.md §1). **The boundary is the
   point, and it is the tempting refactor that is wrong:** cryptorank.io *does*
   fingerprint the TLS ClientHello (`net/http` + full Chrome headers → **403**;
   `chrome_131` + h2 → **200 / 738,673 B**, DR-005), so `cryptorank`'s stack **remains
   required** and must not be generalised away, "simplified" to match khala, or folded
   into a shared client. Two families, two measured client requirements, kept separate;
   each package doc states its own access matrix.
2. **One Go package, no TS mirror.** The cryptorank three-way split is *real* because it
   mirrors three separate upstream artifacts (a Python helper `cr_fetch.py`, TS shapers
   `lib/shapers.ts`, a TS mode table `lib/cryptorank.ts`) — which is why
   `check-contract.py` has a genuine `CR_MODES ↔ Modes` parity check to run. khala has
   **one artifact (the site)** and three modes: `services/data/internal/khala/`
   (`modes.go`, `fetch.go`, `parse.go`, `shape.go`) is a single package, and the TS
   route `apps/web/app/api/khala/route.ts` is a **pure verbatim proxy that validates
   nothing**. A `lib/khala.ts` would create exactly the drift cryptorank's own route
   comment refuses ("Re-validating here would be a second implementation waiting to
   drift"); `check-contract.py` therefore gets only its existing
   `check_route_is_proxy()`-style guard extended to the khala route (assert proxy, no
   `execFile`/`child_process`, no local mode whitelist) and **no** table pair. A future
   TS table for khala would be the wrong move for the same reason. Whoever adds a
   second khala-like family should revisit this: if that family brings a genuine second
   implementation, the split becomes real — revisit, do not copy blindly.
   **As-built correction, stated rather than smoothed over:** the landed tree *does*
   contain `apps/web/lib/khala.ts`. Its own header places it correctly — *"this file is
   its TS mirror, exactly as lib/cryptorank.ts mirrors the cryptorank mode table. Nothing
   here re-validates what the sidecar already validates at runtime"* — i.e. it is a
   **typing/display mirror** (`KH_MODES`, `KH_KEY_RE`, `KH_LIMIT_MIN/MAX`,
   `KH_DEFAULT_LIMIT`, the envelope types, `khalaUrl()`), while the authority boundary
   this decision is actually about still holds: the route guards nothing and Go remains
   the only validator. `check-contract.py` carries **no** khala pair (confirmed), so
   nothing currently catches a future drift between `KH_MODES` and Go's `Modes`; if the
   mirror ever gains a validator or a default Go also applies, that is the drift to guard
   against at that moment.
3. **Parse the report PAGE HTML, not Framer's search index** (which is order-lossy —
   no `order`/`blocks`/`startIndex` field; 260 flat `p` vs 8 `h2` — revision-skewed
   (18 of 216 index paragraphs absent from the rendered page) and whose
   `searchIndex-<hash>.json` stem rotates on every republish, so it must never be
   hard-coded). The HTML parse uses `golang.org/x/net/html`, **already** in
   `services/data/go.sum` (`v0.48.0`) — **no new dependency**.
4. **The envelope mirrors the house envelope; no new shape.** Contract v4 is flat, like
   `CrEnvelope` in `services/data/internal/cryptorank/types.go`: `upstream` is a scalar
   **string** (homepage for `reports`/`latest`, the report URL for `report`); there is
   **no `derived` field** — all provenance lives in **`slice` (string, populated on every
   mode)**, the same field `CrEnvelope` already uses for slice provenance; payload keys
   are **`rows`** (list modes) and **`report`** (nested object). Tag discipline is taken
   from that file's own doc comment, not invented: *`undefined` ⇒ absent (`omitempty`);
   `| null` ⇒ present null.*
5. **No HTML is shipped: `report.body` is structured blocks.** `body:
   [{type:"h2"|"h3"|"h4"|"p"|"li", id?, text}]` in DOM order with inline markup
   flattened to text, plus `sections` (the heading outline) — as built in `shape.go`
   (`KhBlock`/`KhSection`) and `parse.go`. **This removes the
   sanitizer/HTML-injection surface from the consumer entirely** — there is no
   `bodyHtml`/`bodyText`/`bodyFormat`, so no untrusted markup crosses the API and the
   old "sanitize before rendering, never raw `dangerouslySetInnerHTML`" caveat is
   deliberately retired rather than restated. Accepted tradeoff: inline formatting
   (emphasis, link targets) is flattened into `text`.
**Consequences.**
- **Three modes: `reports`, `report`, `latest` — and no invented `news` mode.**
  `/news`, `/blog`, `/posts`, `/rss.xml`, `/feed(.xml)`, `/atom.xml`, `/newsletter`,
  `/subscribe` are **all real 404 (7384 B each)**; no feed URL exists in any page; the
  only newsletter artifact is a beehiiv *signup iframe* (RESULTS.md §6). Reports are the
  only content type, so **`latest` is where the "research AND news" ask honestly lands**:
  the newest N reports, with `slice` carrying the claim verbatim — `khala.io publishes
  research reports only; no news surface exists (/news /rss.xml /feed all 404, measured
  2026-09-29) — latest IS the news surface`. It means "the newest N reports", **not**
  "the last N days" (the newest report measured ~89 days old; RESULTS.md §9).
- **Dates are an ABSENT KEY on `reports` rows and populated only on `latest` rows.** No
  date exists in the homepage HTML (date-shaped `<p>` count = **0**); the only
  "Jul 2, 2026" there is the site-build HTML comment, identical on `/`, `/about`,
  `/disclaimer` and every report (RESULTS.md §4, §5). `reports` performs no date lookup,
  so an **absent key** ("this mode does not report dates") is honest where a **present
  `null`** would claim a lookup happened and found nothing. `latest` really does fetch N
  report pages (cached, ETag-revalidated) and names that count in `slice`. Filling
  `reports` by N+1 fan-out was **rejected**: 8× the requests for a display nicety,
  unbounded in a content-mutable count, and partial failure would yield a list where
  some rows have dates and some do not.
- **The date's anchor is a text regex over the byline region, not the style attribute.**
  The date currently lives in one byline `<p>` carrying
  `--framer-text-color:rgba(255, 255, 255, 0.6)` (format `Mon D, YYYY`; exactly **1**
  date-shaped `<p>` per report page, re-verified in the fixtures) — but a Framer restyle
  rewrites styles routinely, so the **date text** is the durable anchor. The regex must
  read the byline region, not the whole document, because prose dates pollute the body
  (`decentralized-robotics-landscape` → `Jan 7, 2026 | As of Jan 8 2025…`; RESULTS.md
  §4). **Forbidden source:** the `<!-- Published … -->` build comment — identical on
  every page including `/about`, i.e. the site build time. "Not found" ⇒ present `null`,
  never a guess, and the drift arm must be loud.
- **Layout drift is alarmable.** A report 200 whose body cannot be found is a **502 with
  a distinct error**, never a 200 with an empty or chrome-only body — the same posture as
  `cryptorank`'s `cf-challenge` arm and the house rule *empty upstream ≠ valid answer*.
- **Key regex `^[a-z0-9][a-z0-9-]{0,127}$`, from measured slug lengths.** Counted from
  the live `sitemap.xml` (re-fetched 2026-09-29, **200 / 1084 B**): walrus **94**
  (longest), surf **73**, x402 **72**, xmaquina **63**, bittensor-an-investment-history
  **61**, openclaw **46**, bittensor-olympics **35**, decentralized-robotics **32**. A
  **79-char cap was proposed and is measurably wrong** — it would 400 the flagship
  report; `cryptorank.KeyRe`'s 64-char cap would 400 five of the eight and is deliberately
  **not** reused.
- **The decoy classes differ from cryptorank's.** A bad key is a **real upstream 404**
  (7384 B, `<title>Page Not Found | Framer</title>`) — no fabricated 200, so the decoy
  class that forced DR-005 does **not** reproduce here. A missing Framer CMS resource
  answers **403** with 111 B of S3-style `AccessDenied` XML — **403, not 404** — and is
  surfaced with its real status, never parsed as data.
- **Trust class GATED, gated by `verify-khala.py`** — strict params, null-stays-null,
  preserved upstream status, honest `slice` labels on every mode, cache observability,
  and **two independent ground-truth gates**: (a) sitemap slug-set equality
  (`sitemap.xml` = **11 `<loc>`** = 3 static + 8 reports) and (b) site title/date parity
  read from the pages themselves. The existing "second, independent client" doctrine
  generalises: **the verifier fetches khala.io DIRECTLY as its oracle and never reads the
  adapter's output as truth.** Plus a monitor check and a route-sweep entry. **GATED is
  not claimed until the verifier's output has been observed** — it has not been written
  or run.
- **Politeness.** `reports`/`latest` read the homepage; pages are `max-age=0,
  must-revalidate` with a strong `etag`, and conditional GET was measured working
  (**304 / 0 B**), so revalidate. The search index is `max-age=31536000, immutable` and
  its name rotates on republish.
- **Accepted fragilities, stated not hidden:** everything is Framer-internal,
  undocumented markup (`data-framer-name` holds **stale placeholder copy** — never read
  card text from it); `sections[].id`/`body[].id` are the page's own odd ids
  (`1.-the-concentration-problem-and-crypto-s-solution`, `4.1-sn44-–-score`); authors are
  x.com anchors with no machine-readable field, so `authors` is `null`; and the report
  count is currently exactly **8** — a content-mutable number that **nothing may
  hard-code** (assert `upstreamTotal` set-equality against the sitemap, and let
  `missingSlugs` report disagreement).
- Where it lives: DESIGN.md `/home/dwizzy/khala-probe/DESIGN.md` (evidence:
  `/home/dwizzy/khala-probe/RESULTS.md`), PLAN G8, ARCHITECTURE §2/§3/§4/§6/§7/§9,
  SCHEMA §3.1b/§3.2/§3.3.
---
## DR-007 — Toolchain: npm → Bun 1.4.2 for both Next apps (2026-09-29)
**Status:** accepted, deployed (`fudcourt-web` on :3100 restarted onto a
Bun-installed, Bun-built tree; blog install proven the same way).
> **Superseded in part by [DR-008](#dr-008--appswweb-runtime-node-22--bun-142-bun---bun-next-start-2026-09-29)**: the
> toolchain half below (install, lockfile, script runner, CI) stands unchanged, but
> the sentence "Node is the runtime" applies to `apps/blog` only now — `apps/web`
> is **served by Bun**. Read every "Node stays the runtime" clause below as scoped
> to blog + rollback.
**Context.** Owner direction: "typescripts (bun)" for both apps. Two
`package-lock.json` files and `npm ci` were the only install path, while the
host already had Bun 1.4.2 and the offline suites/CI ran through `npx`/
`npm run`.
**Options.** (1) keep npm; (2) move install+build+scripts to Bun while Node
stays the server runtime; (3) move the runtime to `bun run next`.
**(2).** Bun owns the install (`bun install --frozen-lockfile`), the lockfile
(`bun.lock`, both `package-lock.json` retired in the same change) and the
script runner (`bun run dev|build|start|test:shapers`, `bunx`). Node 22 remains
the *runtime*: `next start`/`next build` and the systemd `ExecStart`
(`node_modules/.bin/next`, a shim Bun writes to the same location and mode as
npm) are unchanged, so the server is the same process either way. **(3) rejected**
— it would change the server process for no proven benefit while the deploy is
a systemd unit pointing at `next`.
**Evidence (measured 2026-09-29).**
- Sandbox (`/home/dwizzy/fudcourt-mig`, a copy, so production was never built
  in place until the gates passed): `bun install` web 146 pkgs / blog 391 pkgs;
  `bun run build` RC=0 for both (web 70 MB, blog 398 MB, blog with the
  pre-existing `ignoreBuildErrors` drizzle caveat unchanged).
- Frozen installs from the committed `bun.lock`: web RC=0, blog RC=0 with the
  `overrides.drizzle-orm=0.45.2` pin honored (verified by reading the installed
  package version, not by assuming).
- Offline suite under Bun: `bun test ./scripts/tests/shaper-tests.ts …` 80/80 and
  `bun run test:shapers` 80/80 (was 79 pre-WIP; the WIP rate-limit tests are the
  80th) — `node --test` inside the script is untouched.
- Cut over in the live tree, then `bun run build` RC=0 and
  `systemctl --user restart fudcourt-web.service` → ready in 2 s; 13/13 pages
  200 (incl. `/khala`), treasury APIs 401, `/team/balance` 307 → `/login`,
  `/api/cryptorank?mode=home` 200.
- Dependency-tree parity after the live install: web 112 top-level dirs /
  `bun pm ls` 15, blog 285 / 16 — identical to the sandbox; `ccxt/js/src/okx.js`
  (the bundler-visible path `lib/ccxt-venues.ts` requires) and
  `node_modules/.bin/next` both present.
- CI now installs with `oven-sh/setup-bun@v2` (bun-version 1.4.2) +
  `bun install --frozen-lockfile` and runs `bunx tsc --noEmit` /
  `bun run test:shapers` / `bun run build`; `actions/setup-node@v5` (node 22)
  stays because Node is the runtime **of `apps/blog`** (DR-008 moved `apps/web` to
  Bun). The pre-push hook switched `npm run` →
  `bun run` and `npx tsc` → `bunx tsc`.
**Consequences.**
- `npm ci` is no longer supported in either app; a human running it would
  re-materialize a tree from a lockfile that no longer exists.
- The root `package-lock.json` (stale, lists absent `apps/balance`/`apps/gateway`)
  was left alone: it is not an install path for either app and removing it is a
  separate cleanup.
- Rollback: `git revert` the lockfile/manifest commit, then `npm ci` uses the
  restored `package-lock.json`; no runtime artifact depends on Bun.
---
## DR-008 — apps/web runtime: Node 22 → Bun 1.4.2 (`bun --bun next start`) (2026-09-29)
**Status:** accepted, deployed (`fudcourt-web` on :3100 is served by a Bun process;
unit versioned at `apps/web/deploy/fudcourt-web.service`).
**Context.** DR-007 moved the *toolchain* (install, lockfile, script runner) to Bun and
deliberately left Node as the server runtime, on the reasoning that option (3) "would
change the server process for no proven benefit". The owner's direction is a single
Bun-everywhere target for the Next apps, so option (3) from DR-007 is now the ask — and
DR-007's own gate ("no proven benefit") is satisfied by *proving the absence of harm*
rather than by a speed claim, because Bun is not faster here (measured below).
**Options.** (1) leave it, Node serves web and blog; (2) `bun --bun next start` for
**web only**, node for the Payload/blog app; (3) both apps.
**(2), web only.** Web is the app the owner named, it is the one whose runtime can be
switched without touching a CMS process, and blog's `payload` CLI calls assume Node
(DR-007 already settled the blog half at install/build level). `apps/blog` and
`fudcourt-sync` keep Node/Python.
**Evidence (measured 2026-09-29 on this host, `apps/web`, build `OMhgA85taz_1n1flx_aT2`).**
- *It really is Bun.* With `--bun`, `/proc/<pid>/exe` of the process holding the port is
  `/home/dwizzy/.bun/bin/bun` (without the flag, `node`; a `node_modules/.bin/next` shim
  execs `node` regardless, so the shim is addressed by its real entry
  `node_modules/next/dist/bin/next`).
- *Parity of behaviour.* `bun --bun next build` RC=0 (Turbopack, 16.9 s) and, serving the
  **Node-built** `.next` (production's actual case — the build is not redone):
  `BUILD_ID` unchanged; 15 pages 200 (`/`, every board, `/khala`, `/sitemap.xml`,
  `/robots.txt`, `/ticker/BTC`), `/team/balance` 307, `/ticker/FOO` 404, sitemap `<loc>`
  = 42; `/api/all` and `/api/admin/members` still 401 JSON; `X-RateLimit-*` still emitted.
- *Envelope parity.* `/api/khala?mode=reports` byte-identical before/after restart;
  `/api/cryptorank?mode=home` and `/api/news?limit=3` identical in **key set and values**
  but for `cache` MISS→HIT and `timestamp` — both fields whose value is defined to vary
  per request, not a runtime difference.
- *Session compatibility.* The signed-cookie payload+signature is **byte-identical**
  under both runtimes (same WebCrypto HMAC + base64url), so switching does not invalidate
  the 7-day sessions already in browsers.
- *Upstream clients work under Bun.* `@libsql/client` (Turso) returns rows
  (`SELECT 1` → `OK`), and the ccxt ticker path answers 200 with a cold sweep of
  **71.2 s** — the same figure ARCHITECTURE §9 records for Node, so the 90 s origin
  ceiling is unchanged by the switch.
- *Cost/benefit, honestly.* Boot 0.58 s vs 0.70 s; RSS 114 MB vs 112 MB; latency on
  `/`, `/cryptorank`, `/api/khala?mode=reports`, `/api/news?limit=5` within ±4 %
  (node/bun: 8.7/8.8, 3.0/3.0, 14.0/13.8, 47.6/45.9 ms). **The gain is one runtime
  instead of two in the web app's stack, not throughput.**
**Consequences.**
- The deployed unit is `ExecStart=/home/dwizzy/.bun/bin/bun --bun …/node_modules/next/dist/bin/next start -p 3100`
  (absolute paths: a systemd *user* unit PATH has no `~/.bun/bin`). `package.json`'s
  `start` is `bun --bun next start -p 3000` so local runs match production.
- **Rollback:** restore `ExecStart=…/node_modules/.bin/next start -p 3100` and reload the
  unit — the build artifacts are runtime-agnostic and Node is still installed, so this is
  a one-line revert with no rebuild.
- **Left on Node on purpose:** `apps/blog` (Payload; also `typescript.ignoreBuildErrors`),
  the CI `bun run build` steps (CI's gate is the *source* build, and keeping it on the
  pre-existing path keeps CI changes out of this decision), and every script task
  (`test:shapers` still runs `node --test` internally).
- Node 22 stays installed: it is the fallback runtime and the CI gate's runtime.
- Not claimed: no throughput/memory win (measured above), and no Bun-specific APIs are
  used anywhere in `apps/web`.
---
## DR-009 — Backend weighting: the `llama` family moves into the Go sidecar (2026-09-29)
**Status:** accepted, deployed (`fudcourt-apicalls` :3101 serves `/api/llama`;
`fudcourt-web` :3100 proxies it).
**Context.** Owner direction: *"backend framework weighted on go/rust"*. The
sidecar already owned cryptorank (DR-005) and khala (DR-006) while `llama`
(DeFiLlama TVL) still validated, fetched, cached, sorted and trimmed inside the
Next.js route (`lib/rate-limit.ts` outbound limiter, 177-line route).
**Decision.** Port it the same way, third family, third package:
`services/data/internal/llama/{modes,fetch,shape}.go` + tests, wired as
`/api/llama` on the sidecar mux with its own `/healthz` key, and
`apps/web/app/api/llama/route.ts` reduced to a verbatim proxy cloned from
`app/api/khala/route.ts`. `lib/llama.ts` stays as the typing/display mirror.
**Measured evidence.**
- `go test ./...` green: 20 new package tests + 6 handler tests (57 pass total
  across `internal/llama` + `cmd/apicalls`), covering the sort's missing-tvl
  rule (`?? -1`, never 0), the ten-key protocols projection, the historical
  tail, MISS→HIT + TTL expiry + 8-way single-flight sharing ONE upstream call,
  the real status on 403/429/500/503, transport/non-JSON/non-list loudness, the
  strict param matrix with the exact wire strings, and the served-bytes shape
  (6 keys, no `cache` in the body).
- `verify-llama.py` **51/51 against the Go endpoint** (`--base :3101`): chains
  467 rows == the direct upstream's own count, top-5 names identical to
  upstream's own top-5, protocols `top`/`days` 400 matrix, `X-Cache` MISS→HIT
  including a genuine cold MISS, and the anti-fake parity probe (proxy body vs
  a live `/v2/chains` fetch). Same 51/51 through the production `:3100` proxy.
- `check-contract.py` gained a **llama LLAMA_MODES parity** row
  (`lib/llama.ts` == `internal/llama/modes.go`) plus a proxy-shape assert; the
  route sweep gained 5 strict-param checks (144/155; the 11 fails are the known
  CoinGecko 403 + 10 session-gated probes).
- No user-visible behaviour change: `bunx tsc --noEmit` 0, `bun run build` 0,
  `/llama` + `/api/llama` 200 on `:3100` and on the public hostname.
**Consequences.**
- Same failure mode as the other two families: the sidecar down → the route
  says so loudly (502 with the real reason), never a cached or partial board.
- One deliberate difference from the TS: `JSON.stringify` OMITTED keys whose
  value was `undefined`; the Go projection carries them as a present `null`.
  Both mean "upstream said nothing" and the board renders `—` either way; it is
  recorded in `shape.go` as the deliberate choice, not drift.
- `top`/`days` on the wrong mode are ignored exactly as the TS ignored them
  (its branches only read their own param), which is NOT khala's scoping rule —
  asserted by a test so the difference stays on purpose.
---
## DR-010 — Rust service: the live balance sync (2026-09-29)
**Status:** accepted; `services/sync` builds, passes its tests and produces
byte-comparable rows to the Python original. **Not yet cut over on the systemd
side** — the timer still runs the Python unit (rollback path kept warm), and the
Rust units are versioned at `services/sync/deploy/`.
**Context.** Owner direction names Rust. The only Python *runtime* path left was
`apps/web/scripts/tools/sync-live.py` (5-min timer → 6 Alchemy EVM chains + Solana +
Hyperliquid + a spot-price oracle → Turso `assets`). DR-005's precedent for a
runtime port is: the new implementation serves, the old one stays as the
independent oracle.
**Options.** (1) Rust re-fetches Turso directly; (2) Rust rewrites the table via
the same Turso HTTP pipeline as Python; (3) no Rust runtime at all.
**Decision. (2).** Same Turso `/v2/pipeline`, same tables, same columns, same
`DELETE`-then-`INSERT` order, same share-percentage math and the same
"a failed RPC never becomes 0" rule, so the two implementations can be diffed
row-for-row — which is what makes this a port rather than a second opinion.
**Measured evidence.**
- `cargo build --release` clean (0 warnings, `strip = true`), `cargo test
  --release` **5/5**.
- Parity: both binaries run back to back against live chain + Turso data,
  `17 rows` each, **zero symmetric difference, zero quantity mismatch, zero USD
  mismatch**, `NET WORTH: $170.46` on both.
- Two real defects were caught BY that diff and fixed in Rust (each would have
  produced silently wrong balances):
  1. `hexint` returned `f64` — the wei→ETH scaling then rounded twice, once at
     the hex parse and again at the division. Now it returns `u128` and the
     caller scales with `scale_dec`, mirroring CPython's single-rounding
     `int / 10**dec`.
  2. `round2/round4/round10` used multiply-then-round-half-even. That is wrong
     exactly when the multiplication lands on a tie: `round(12.345, 2)` must be
     **12.35** (CPython, verified) but the old form returned 12.34. Rounding now
     goes through Rust's correctly-rounded fixed-precision formatting, and the
     tests assert measured CPython values (`12.345 → 12.35`, `12.335 → 12.34`).
- The Python oracle also gained the price-source fix the sync outage required
  (`coins.llama.fi` instead of the CoinGecko host that now 403s everything —
  ANALYSIS K-12); the Rust port reads the same source, so the comparison stays
  apples-to-apples.
**Consequences.**
- A cutover is one line in the installed unit (`ExecStart` → the Rust binary)
  and the Python unit stays installed as the rollback; the repo now carries both
  versioned units plus a `sync` CI job (`cargo build/test`) and a pre-push
  `cargo build/test` branch.
- `services/sync/target/` is gitignored; the release binary is a build artifact,
  so the timer must be pointed at a built binary (the unit documents this).
- The oracle is not deleted: `sync-live.py` remains the independent check, the
  same relationship DR-005 established between the Go sidecar and `cr_fetch.py`.

**Superseded by DR-040** (Postgres+TimescaleDB is the single system of record; Turso/libSQL dropped).
---
## DR-011 — Directory naming: one job per directory, no cryptic prefixes (2026-09-29)
**Status:** accepted, landed in source and on the running services (web :3100,
`apicalls` :3101 rebuild + restart, Rust binary renamed). **No behaviour change:**
verified by rendering the pre-change tree and the post-change tree side by side
and diffing the SSR bodies (below).
**Context.** Owner direction: *"buat penamaan folders menjadi best practices"*.
The tree had grown ambiguous names: the Go sidecar's cryptorank family was split
across three abbreviated packages (`crfetch` / `crmodes` / `crshape`) with no
directory per family while `khala` and `llama` each had one; `apps/web/app/`
mixed components with routes (`app/components/`); a stylesheet helper sat at
`lib/ui/shared.ts` (a directory named for the thing it holds, not its role);
one 9 KB state container (`app/home-shell.tsx`) was a route-sibling file; the
Rust service lived at `services/sync-rs` (repo-name suffix) with a `sync-rs` binary.
**Options.** (1) Rename only the top offenders; (2) restructure to per-family
and per-role directories, including the Go package merge and the Rust rename;
(3) leave the Go packages alone (a rename buys no behaviour).
**Decision. (2), with an explicit blast-radius bound.** Every rename is
mechanical and covered by a gate that fails loudly if it drifts:
| Before | After | Rationale |
|---|---|---|
| `services/data/internal/{crfetch,crmodes,crshape}` | `internal/cryptorank/` (one package, 11 files) | matches `internal/khala` and `internal/llama`: one family, one package. No symbol collided — checked programmatically before the move (0 collisions over 211 package-level names) |
| `apps/web/app/components/` | `apps/web/src/components/` | Next.js route tree (`app/`) holds routes; React panels are not routes |
| `apps/web/lib/ui/shared.ts` | `apps/web/src/styles/shared.ts` | the directory names the *role* (design tokens + view types), not the layer |
| `apps/web/app/home-shell.tsx` | `apps/web/app/store/store-shell.tsx` | it is a client state container, not a route; `store/` makes that a rule, not a convention |
| `apps/web/app/admin/member-table.tsx` | `apps/web/app/admin/members-table.tsx` | one table, plural noun |
| `services/sync-rs/` (crate `sync-rs`) | `services/sync/` (crate/binary `fudcourt-sync`) | drop the repo-name suffix; the binary is `fudcourt-sync`, matching the unit name |
| `apps/blog/scripts/seed.ts` | `apps/blog/src/seed.ts` | it imports `./payload.config` and is run by `payload run`; nothing else lives in `scripts/` |
| `services/data/scripts/smoke.sh` | `scripts/smoke-apicalls.sh` | the one script in the dir names its target, so it stays unambiguous when copied out |
**What was deliberately NOT renamed.** The `apps/<slug>` names themselves
(`web` / `blog` / `apicalls` / `sync`) are referenced by systemd units,
`WorkingDirectory=`, the Bun lockfile paths and every doc; churn there is
all-risk-no-benefit. `apps/blog/src/app/(payload)` and `(frontend)` are Payload
CMS / Next route-group conventions and must keep their names. `apps/web/db/`,
`scripts/{verify,checks,tests,tools,oracle,fixtures}` and `deploy/` already
follow the one-job rule.
**Measured evidence.**
- **Equivalence proof (the load-bearing one):** the pre-change tree was started
  on `:3210` (sandbox copy, its own build) and the post-change tree on `:3100`;
  the SSR HTML of 13 routes (`/`, `/ticker`, `/trench`, `/dex`, `/signals`,
  `/scoreboard`, `/chainrank`, `/cryptorank`, `/llama`, `/tracker`, `/news`,
  `/khala`, `/login`) was fetched from both and compared with chunk hashes,
  build-id and module ids normalised. **12/13 byte-identical; the one diff is the
  intentional footer copy fix** (`scripts/verify-cryptorank.py` →
  `scripts/verify/verify-cryptorank.py`), i.e. no behavioural drift anywhere.
- `go build/vet/test ./...` green (`internal/cryptorank` runs the 26-fixture
  parity oracle against the frozen TS goldens, unchanged); `cargo build --release`
  + `cargo test --release` 5/5; `bunx tsc --noEmit` 0; `bun run test:shapers`
  80/80; `bun run build` 0; `check-contract.py` **still parses the Go mode table
  at its new path** (`internal/cryptorank/modes.go`); `dump-schema.mjs --check`
  `SCHEMA_OK`.
- Live harnesses against the rebuilt sidecar: `verify-khala.py` **51 checks pass**,
  `verify-llama.py` **51/51 on :3101 and through the :3100 proxy**, and the
  cryptorank harness was re-run after pointing its shell-wiring needles at
  `src/components/`: **239 pass / 2 fail / 11 info**. The shell-wiring check that
  the rename genuinely broke (a stale `./components/` needle) is fixed; the two
  remaining fails are **upstream data conditions, not code drift** — one news row
  ships `url=None` with a non-null date, and upstream's own aioverview digest says
  dominance 56.75 where the home board says 56.15 (the harness's 1% tolerance).
  Both were failing for the same reason before the rename (the pre-rename report
  carried them plus the shell-needle fail); the 11 `info` rows are the pinned
  decoy/gating findings, which are not regressions by construction.
**Consequences and the traps that cost time (recorded so they are not repeated).**
- Two files were **deleted by an accidental `rm -rf` on a rename target**
  (`app/home-shell.tsx`) and by an over-broad qualifier regex that rewrote
  `cryptorank.io` → `io` inside string literals. Both were recovered from the
  sandbox copy and the move was redone with exact-scoped edits; the parity oracle
  is what caught the second one (26 fixtures failed with a truncated URL). Lesson:
  after a mechanical move, run the *strongest* gate first — here the fixture
  parity test — not just the compiler.
- The shell-wiring assertions in `verify-cryptorank.py` / `verify-llama.py`
  discover their needles by path; they now point at `src/components/`, so the
  harness stays a real assertion rather than silently skipping.
- A final sweep of *code* comments and unit text found 11 more stale references
  (Go package docs still calling the merged package `crfetch`/`crmodes`/`crshape`,
  a `go test ./internal/crfetch/` invocation inside a live-test header, and the
  Python-unit comment pointing the Rust swap at `services/sync-rs/deploy/`). All were
  updated; the one deliberate survivor is `DefaultCacheDir = "~/.cache/crfetch"`,
  which is a real runtime path shared with the Python oracle and must NOT move.
  `check-deploy.py` (newly observed in the pre-push hook) keeps every versioned
  unit's `ExecStart` path honest — it passes on all 7 unit files.
- One unit (the systemd sync) was installed and then **restored to the prior
  Python runtime**: the dry-run of the Rust binary passed (`Result=success`,
  status 0), but cutover was out of scope for a naming change (DR-010 keeps it
  open). Only the unit *stub* in `services/sync/deploy/` reflects the new paths.
---
## DR-012 — Backend weighting: the `news` family moves into the Go sidecar (2026-09-29)
**Status:** accepted, deployed (`fudcourt-apicalls` :3101 serves `/api/news`;
`fudcourt-web` :3100 proxies it; the `:3100` build carrying the proxy is live).
**Context.** Owner direction: *"backend framework weighted on go/rust"*. Three
acquisition families already live in the Go sidecar (cryptorank DR-005, khala
DR-006, llama DR-009). `news` was the last read-only market family still parsed
inside a Next.js route: a 99-line `app/api/news/route.ts` doing its own RSS
fetch, its own regex parse and its own `limit` slice through
`lib/rate-limit.ts`.
**Options.** (1) Leave it in TS — it works and its 400s are strict; (2) port it
(4th family, same shape as llama); (3) port it and drop the TS route entirely.
**Decision. (2), with (3) rejected.** An RSS feed is a *document*, not a JSON
API, so this is the first family whose Go side owns a PARSER rather than a
projection. Keeping the TS route as a verbatim proxy preserves the public
contract (`/api/news` on :3100), the existing board wiring, the sweep checks and
the monitor check with zero client change — the same cutover shape DR-005/006/009
used. Removing the route would have forced every consumer and gate to move for no
gain.
**Measured evidence.**
- `go test ./...` green: **19 new package tests + 7 handler tests** (76 tests
  across the module now), covering the six-key projection, absent-tag→empty-string
  (never null), CDATA/bare parity, the 200-rune description clip, the strict
  `limit` matrix incl. the empty and past-int64 cases, the feed-table refusal,
  MISS→HIT, TTL expiry, 8-way single-flight sharing ONE upstream fetch, the
  real status on 403/429/500/503, transport with no body to quote, a gzip-
  encoded feed, the head-vs-`total` distinction, the cache-keyed-on-feed-URL
  proof (two limits, one call) and "no payload is ever substituted for an error".
- `verify-news.py` **50/50 against the Go endpoint** (`--base :3101`) and **50/50
  through the production `:3100` proxy**, including the anti-fake parity probe:
  the served head matched the DIRECT feed fetch on **10/10 titles**, in upstream's
  own ORDER (so "served rows are upstream's own order" is proven, not assumed),
  and the pre-port silent coercion is pinned as a regression (an unknown source
  must never come back as an empty 200).
- `check-contract.py` gained a **news NEWS_SOURCES parity** row plus a
  proxy-shape assert whose needle list includes `parseInt`, `Math.min`, `<item>`
  and `stripCdata` — i.e. the guard fails if the TS parser ever comes back.
- Route sweep gained 6 strict-param checks (150/161 now; the 11 fails are the
  known CoinGecko 403 + the 10 session-gated probes).
- `bunx tsc --noEmit` 0, `bun run build` 0, `/news` and `/api/news` 200 on
  `:3100`.
**Consequences.**
- `total` is the full parsed item count while `items` is the `limit` head, so a
  5-row body can never be read as "the feed has 5 items" — the harness asserts
  `len(items) == min(limit, total)` against the SAME response's `total`, which is
  what keeps the pair from drifting.
- The cache is keyed on the FEED URL, not the request query: `limit=3` and
  `limit=9` share one 340KB fetch and slice afterwards. That is a deliberate
  improvement over the TS limiter, whose per-query cache entries would have
  fetched the feed once per distinct `limit`.
- `lib/news.ts` is a typing/display mirror with no validation, on the same rule
  lib/khala.ts and lib/llama.ts record: a second validator is the one thing that
  could drift from the sidecar's.
- Bounded by construction rather than by eviction, like llama: `Sources` admits
  one URL, so the cache can hold one body; `Fetcher.Stats()` makes that
  observable and a test asserts it cannot grow.
- Honest limit of this port, stated not hidden: the feed's `<item>` set is parsed
  by regex, so an exotic RSS build (nested `<item>` in a CDATA body, or a channel
  that omits `<item>` entirely) would be read as an empty feed and refused LOUDLY
  with a 502 rather than silently served as "no news". A structured XML decoder
  is the upgrade path if that ever fires.
---
## DR-013 — Backend weighting: the `chainrank` family moves into the Go sidecar (2026-09-29)
**Status:** accepted, deployed (`fudcourt-apicalls` :3101 serves `/api/chainrank`;
`fudcourt-web` :3100 proxies it; the `:3100` build carrying the proxy is live).
**Context.** Owner direction: *"backend framework weighted on go/rust"*. Four
families already live in the Go sidecar (cryptorank DR-005, khala DR-006, llama
DR-009, news DR-012). `chainrank` was the next read-only family still doing its
own fetch and envelope-building in a Next.js route, including its own cache and
single-flight through `lib/rate-limit.ts`.
**Options.** (1) Leave it in TS; (2) port it (5th family, llama/news shape);
(3) port it and also proxy the write endpoints.
**Decision. (2), (3) rejected explicitly.** The writes — `POST
/api/click|presence|claim/quote|claim/confirm|upload` — each have a real side
effect on someone else's production service (their click counters, a pending
paymentId row, their CDN). They stay documented in `lib/chainrank.ts` and absent
from both the route and the sidecar's mux; the proxy does reads only, which is
the posture the route's doc comment already recorded and the verifier already
asserts (it probes the writes' VALIDATION gates directly against upstream, never
through us).
**Measured evidence.**
- `go test ./...` green: **17 new package tests + 10 handler tests** (111 tests
  across the module now). Package coverage: the mode table and its `detail`
  string; the URL builder relaying `page`/`pageSize` byte-for-byte and dropping
  them for `stats`; param-order canonicalisation (`?page=2&pageSize=7` and its
  reverse are ONE cache key); the allowlist refusing write paths and foreign
  hosts; MISS→HIT; TTL expiry; 8-way single-flight with exactly one MISS and
  seven COALESCED (the TS limiter's own distinction, preserved); the explicit
  entry ceiling held under a 60-URL page walk; 405/429/403/500/503 with the real
  status and quoted body; a non-JSON 200; a transport failure with no body; gzip;
  and the shape rules (`null` is not a number, `rows=null` is not an array, an
  unknown mode has no contract).
- `verify-chainrank.py` **50/50 against the Go endpoint** (`--base :3101`) and
  **50/50 through the production `:3100` proxy**, including the relay-verbatim
  matrix measured against REAL upstream (`page=0|-1|abc → 1`, `pageSize=0 → 50`,
  `pageSize=1000 → 200`) and the write-gate probes fired at upstream directly.
- `check-contract.py` gained a **chainrank CR_MODES parity** row plus a
  proxy-shape assert whose needles include `Math.min` and `pageSize` — the guard
  fails if a local clamp ever appears, which is the one drift this family cannot
  tolerate.
- Route sweep gained 4 relay checks (154/165 now; the 11 fails are the known
  CoinGecko 403 + the 10 session-gated probes).
- `bunx tsc --noEmit` 0, `bun run build` 0, `/chainrank` and `/api/chainrank`
  200 on `:3100`.
**Consequences.**
- **Cache key = the full upstream URL, query included**, unlike llama/news where
  one document is trimmed locally. Here the pagination genuinely selects a
  different slice upstream, so `pageSize=7` and `pageSize=50` must not share an
  entry. That also means the entry count is NOT bounded by construction the way
  llama's/news's are, so this family has an explicit ceiling (32) with
  oldest-first eviction, and a test walks 60 URLs to prove it holds.
- **Param order is canonicalised** into the cache key, so two spellings of one
  request cannot become two upstream reads.
- The envelope SPREADS upstream's object and stamps three labels on top
  (`kind`, `upstream`, `fetchedAt`) rather than projecting fields: chainrank adds
  rows' fields freely and a projection would silently drop them. What replaces
  the projection is `CheckShape`, which refuses (loud 502) any 200 that does not
  carry the fields the board renders — this family's spelling of *empty upstream
  ≠ valid answer*.
- `lib/chainrank.ts` keeps the mode list, the row types and the documented write
  surface; the new envelope types are a typing mirror with no validation, on the
  same rule lib/khala.ts / lib/llama.ts / lib/news.ts record.

## DR-014 — Backend weighting: `/api/reconcile` moves to a Rust HTTP service (`fudcourt-reconciled` :3102) (2026-09-29)
**Status:** accepted, deployed (`fudcourt-reconciled` :3102 serves `/api/reconcile`;
`fudcourt-web` :3100 proxies it; the `:3100` build carrying the proxy is live).
**Context.** Owner direction: *"backend framework weighted on go/rust"*. Every
acquisition family is Go (cryptorank DR-005, khala DR-006, llama DR-009, news
DR-012, chainrank DR-013) and one Rust crate owned the *batch* half of the backend
(the 5-minute balance sync, DR-010). Rust therefore had no serving surface at all,
and `/api/reconcile` — the wallet reconciliation board — was the last non-auth,
non-browser route doing its own work in TypeScript: three Turso SELECTs and the
accumulation maths, inline in the route.
**Options.** (1) Leave it in TS; (2) port it to Go, joining the acquisition
sidecar; (3) port it to Rust and serve it from `services/sync`.
**Decision. (3); (1) and (2) rejected explicitly.** (2) would have put it in a
service whose stated job is *upstream acquisition* — this route acquires nothing
and reads our own database. (3) puts it beside the crate that already owns the
Turso pipeline client, gives the Rust half of the stack a real request-serving
surface, and keeps one language per concern. The criterion was correctness-per-line
of new machinery, and the cross-implementation diff below is what made it
verifiable rather than merely plausible.
**A zero-dependency HTTP service, chosen deliberately.** The service needs one
route, two methods and a JSON body, so it is `tokio::net::TcpListener` plus a
bounded request reader (`src/server.rs`, ~40 lines of framing). This adds **no new
crate** — `tokio`, `reqwest` and `serde_json` were already dependencies
(`serde_json` gained the `preserve_order` *feature*, not a package) — which is the
difference between shipping the port and shipping a supply-chain decision. The
costs are named rather than hidden: HTTP/1.1 only, `Content-Length` framing only,
one request per connection, no TLS, and an 8 KiB head cap. It binds loopback and
the Next route is its only client, exactly like the Go sidecar.
**Measured evidence.**
- **The Rust service and the ORIGINAL TS shaper agree byte-for-byte on live data.**
  `lib/reconcile.ts` holds the route's logic moved verbatim and an importable
  shaper; `scripts/tools/parity-reconcile.ts` *(superseded: the harness now lives at
  `scripts/verify/parity-reconcile.ts`, moved there by the Phase-8 tooling relocation, 2026-10-01)* runs the same three SELECTs through
  both and diffs `rows`, `wallets` and `walletSummary` as JSON — **all sections
  identical, key order included** (18 rows, 3 wallets, 10 summaries). The only
  change the port needed to reach that was `preserve_order`: serde_json sorts
  members, JS preserves insertion order, and a diff of the two bodies must not fire
  on member order.
- `scripts/verify/verify-reconcile.py` **28/28 green** against `:3102`: the three
  routes, the 405 on POST, `no-store`, the payload shape, `healthz`'s row count
  matching the payload (two independent reads of one table), and the arithmetic
  invariants asserted over the REAL rows — `expected = in_sum - out_sum`,
  `diff = current - expected`, rows sorted by |diff| descending, `walletSummary`
  recomputed and matched key-for-key, `expected == 0` for a row with no transaction
  history — plus live parity as one of its own checks.
- `cargo test --release` **17/17** (12 new integration tests): the cell coercions
  (`Number(x) || 0` including `Number(true) === 1`, `|| 'Unknown'`), the
  IN/else split (a lowercase `in` is an OUTFLOW), the two loops' different asset
  fallbacks, the stablecoin-only `current_total` quirk, and the routing table.
- **Two real defects were caught by writing the tests, not by running the service.**
  (a) The first version accumulated into a `BTreeMap`, which on an `|diff|` tie
  emits byte order (`abc` before `zeb`) where the TS route emitted insertion order —
  a false parity failure waiting to happen and a genuinely different board. (b) The
  `insert=true` rows my own harness checked for turned out to be real stored zeros,
  so the check was asserting something the service never claimed; it was replaced
  with a not-zeroed-board check plus the phantom-expectation invariant.
- The `:3100` route was **statically proven first**: a throwaway `next start -p 3199`
  carrying a temporary `FUDCOURT_SESSION_SECRET` answered `401` for an
  insufficient tier and `200 {source: "rust"}` for a team session, with the payload
  identical to the service's own and `x-reconcile-upstream` naming it. Production's
  `.env.local` still has no session secret (K-11), so the restart preserved the
  fail-closed `401` exactly as before.
**Consequences.**
- **The TS shaper is an oracle, not a runtime path.** The route answers `502` with
  the real reason when the service is unreachable — it does NOT fall back to
  `lib/reconcile.ts`, because a board that keeps rendering from a silent fallback
  is the failure this house refuses. `lib/reconcile.ts` keeps the same status
  `scripts/oracle/cr_fetch.py` has.
- The stablecoin-only `current_total` and the transaction-derived `expected` are
  **preserved, not fixed**. Both are the route's original rules; changing either
  would silently re-score every wallet, so they are asserted (the harness FAILS if
  the stablecoin-only behaviour stops holding) and documented in the module header.
- Loopback-only, no auth of its own, exactly like the Go sidecar: middleware +
  `lib/guard.ts` still own the team-tier gate, and the route adds none.
- Ops: versioned `services/sync/deploy/fudcourt-reconciled.service` (enabled + started,
  `Restart=always`, `EnvironmentFile=/home/dwizzy/fudcourt/.env`), the binary refuses
  to start without `TURSO_AUTH_TOKEN` (a service that silently reconciled against
  nothing would answer `{"rows": []}` and look healthy), and the crate grew a
  `[lib]` surface so both binaries share `db`/`pyfmt`.
- **The monitor learned about the new unit, because nothing else would have.** A
  dead `fudcourt-reconciled` turns `/api/reconcile` into a 502 that the existing
  monitor (web unit + route probes) cannot see, and the route is team-gated so no
  unauthenticated probe can reach it either. `scripts/verify/monitor.py` now checks
  `fudcourt-reconciled` is active AND that `:3102/healthz` answers THIS service's
  envelope, directly on loopback. Measured: with the unit stopped the monitor prints
  `FAIL unit fudcourt-reconciled: inactive` and
  `FAIL reconcile health: URLError … Connection refused`; restarted, both lines
  disappear (leaving only the pre-existing CoinGecko 403). Deterministic order,
  +0.4 s.

**Superseded by DR-040** (Postgres+TimescaleDB is the single system of record; Turso/libSQL dropped).

## DR-015 — `apps/blog` runtime: npm/Node → Bun (the frontend-runtime rule now holds with no exception) (2026-09-29)
**Status:** accepted, deployed (`fudcourt-blog.service` runs `bun --bun next start -p 3001`).
**Context.** Owner direction: *"frontends next js typescripts (bun)"*. DR-007 moved
both apps' **install/build/scripts** to Bun and left the *runtime* on Node, then
DR-008 moved `apps/web`'s runtime to `bun --bun next start` — but scoped it to web,
leaving `fudcourt-blog.service` on `/usr/bin/npm run start`. The stated reason was an
**assumption**: "Payload's CLI/build path is Node-shaped". An assumption recorded as a
constraint is exactly the kind of thing this repo measures instead of inheriting, and
the audit for this goal found it unsupported: nothing had ever tried the blog's
production build under Bun.
**Options.** (1) Leave blog on Node with the assumption as the reason; (2) measure Bun
against the built blog on a spare port, and switch only if it serves the real app;
(3) switch unmeasured.
**Decision. (2); (1) and (3) rejected.** The measurement is cheap, the blog service had
been **inactive since 2026-09-28 18:31** (killed, not restarted), so a switch could not
regress a running service, and the frontend rule the objective states should not carry
an exception that was never tested.
**Measured evidence.**
- `bun --bun node_modules/next/dist/bin/next start -p 3011` on the existing production
  build: Ready in 120 ms, then `/` **200 (10,934 b)**, `/admin` **200 (44,676 b)**,
  `/api/posts` **200 (11,053 b)** returning the real Payload documents from Neon
  (first doc `never-fake-rules`), i.e. the Payload admin and REST layers both work under
  Bun — the specific thing the assumption claimed would not.
- The one honest caveat the process printed: `"next start" does not work with
  "output: standalone" configuration` — the blog build carries `output: standalone`,
  so the standalone `server.js` entry is the alternative the log names. It is NOT used
  (the unit runs `next start`, as it did under npm), so the warning is pre-existing and
  unchanged by this decision rather than introduced by it.
- Deployed: the versioned unit `apps/blog/deploy/fudcourt-blog.service` now has
  `ExecStart=/home/dwizzy/.bun/bin/bun --bun node_modules/next/dist/bin/next start -p 3001`,
  `systemctl --user show -p ExecStart` confirms Bun is the process, the unit is
  **active**, and `/` `/admin` `/api/posts` all answer **200** through the unit on
  `:3001`. `apps/blog/package.json`'s `start` script is the single source of that
  command (`bun --bun next start -p 3001`), matching `apps/web`'s own `start` script.
**Consequences.**
- Both frontends are now Bun-runtime; "bun (install) + Node (runtime)" is retired as the
  blog's posture, so the objective's frontend clause has no carve-out left.
- The blog is **running again** for the first time since 2026-09-28 18:31 (it had been
  killed and never restarted) — the switch incidentally restored a downed service.
- Rollback is one line (`/usr/bin/npm run start`), the build is untouched, and the
  `output: standalone` warning is the same one npm produced.

## DR-016 — Backend framework: **none** — Go `net/http` + a hand-rolled Rust server, with `tls-client` confined to the one family that needs it (2026-09-29)
**Status:** accepted, deployed (measured against the running services).
**Context.** Owner direction: *"backend framework weighted on go/rust"*. The
"weighted on go/rust" half was already an explicit program (DR-005, DR-006, DR-009,
DR-010, DR-012, DR-013, DR-014) with §1 of this audit measuring it at **58% of backend
runtime LOC in Go/Rust** (Go 7,996 + Rust 1,649 vs 7,000 TS). The *framework* half had
never been written down anywhere in the repo, so it was the one clause of the
direction with no recorded resolution — an unrecorded choice is a choice a future
reader has to re-litigate.
**Measured state (this audit).**
- **The Go sidecar uses no web framework.** `cmd/apicalls/main.go` builds a
  `http.NewServeMux()` and registers handlers by hand (`/healthz`, `/api/cryptorank`,
  `/api/khala`, `/api/llama`, `/api/news`, `/api/chainrank`) — stdlib routing, no gin,
  echo, chi, fiber or gorilla.
- **The only HTTP client library is `tls-client`, and it is confined to ONE family:**
  `internal/cryptorank` (2 files) needs it because beating cryptorank.io's Cloudflare
  ClientHello fingerprinting requires a browser TLS profile (`chrome_131` + HTTP/2 —
  measured, docs/architecture/TECH-STACK.md). The other five packages — `khala`, `llama`, `news`,
  `chainrank` (one upstream, plain feeds/APIs) and `httpx` — use plain `net/http`
  (2 files each), as does the shared escaping helper.
- **The Rust service uses no web framework either:** `fudcourt-reconciled` is
  `tokio::net::TcpListener` plus ~40 lines of bounded HTTP/1.1 framing
  (`services/sync/src/server.rs`), chosen in DR-014 specifically so the port added **zero
  new crates**.
**Options.** (1) Adopt a Go framework (gin/echo/chi) for the sidecar and an
equivalent (axum/actix) for Rust; (2) keep stdlib routing and hand-rolled framing, and
confine `tls-client` to the family that requires it; (3) adopt a framework in Go only.
**Decision. (2); (1) and (3) rejected.** Every family serves one route with a small,
fixed mode table; (1) would add a dependency, a routing/JSON idiom and a second way to
handle errors across both backends in exchange for a route table that fits in one
screen. `net/http`'s `ServeMux` already gives exact-path dispatch, and the mode tables
— not the router — are where this backend's complexity actually lives (they are the
single source of truth `check-contract.py` diffs against the TS tables). Note (2) is
**not** framework dogmatism: `tls-client` is kept exactly where the fingerprint
requirement lives, and is deliberately absent everywhere it is not needed — which is
the operative rule, "a dependency must be paid for by a requirement."
**Consequences.**
- The Rust server's honesty about what it does not implement (HTTP/1.1 only, no
  chunked bodies, one request per connection, no TLS, 8 KiB head cap) is a direct
  consequence of this decision and is stated in `server.rs` rather than implied.
- Adding a framework later is a local change: handlers are already isolated per
  family package, so a router swap touches `main.go`'s registrations, not the family
  logic the harnesses verify.
- The internationalisation/telemetry/validation features a framework would supply are
  absent by design; each family owns its own param validation (strict 400s), which is
  what every verifier already asserts.

## DR-017 — Merge `fudcourt-web` + `fudcourt-blog` into ONE Next app (2026-09-30)
**Status:** accepted, deployed (`fudcourt-web` :3100 serves the dashboard AND the
blog; `fudcourt-blog.service` and `:3001` are retired; `apps/blog` is deleted).
**Context.** Owner instruction: *"merge fudcourt-web and fudcourt-blog"*. Two Next
apps served one product from one repo, with two units, two lockfiles, two dependency
trees and a public hostname open decision that never closed because the second app
had nowhere to live.
**Options.** (1) Leave them separate; (2) merge into one app, moving the blog to a
route prefix; (3) merge by mounting the blog at `/` and moving the dashboard.
**(2). (1) and (3) rejected.** (3) is impossible without breaking every shipped URL:
the dashboard owns `/` and all 18 public boards, while the blog's own index is a
single page.
**THREE CONSEQUENCES WERE FORCED BY THE FRAMEWORKS, NOT CHOSEN — stated because a
reader will ask why the blog's URLs moved.**
1. **Next allows exactly one root layout per app.** The dashboard's `app/layout.tsx`
   and Payload's `(payload)/layout.tsx` (whose `RootLayout` supplies
   `<html>`/`<body>` plus the admin CSS) are both root layouts, so they can only
   coexist as siblings in DIFFERENT top-level route groups. The dashboard therefore
   moved into `app/(frontend)/…` (URL-neutral: a route group contributes nothing to
   the path) and the blog into `app/blog/(payload)/…`.
2. **`/admin` and `/api/*` collide.** `/admin` is the dashboard's tier-gated control
   panel and `/api/*` is the whole market-data surface. Payload's admin and REST/GraphQL
   API are served from a filesystem-determined path, so they were relocated under the
   blog's prefix: **`/blog/cms/admin`** and **`/blog/cms/api/*`**.
3. **React 18 → 19 was mandatory.** `@payloadcms/ui` 3.89 requires
   `react: ^19.0.1 || ^19.1.2 || ^19.2.1`, while `apps/web` was on React 18.3.1. The
   pre-migration check that mattered: the React-18-only APIs removed in 19
   (`ReactDOM.render`, `hydrate`, `react-dom/test-utils`, `useFormState`,
   `defaultProps`, `.propTypes`) appear **nowhere** in the app (grepped, zero hits),
   and the typecheck passes under 19 — so the major bump was a version change, not a
   code migration.
**Resulting layout.**
```
apps/web/app/
  (frontend)/   the dashboard: /, /team/*, /admin, /login, /member, /api/*, robots.ts, sitemap.ts
  blog/
    page.tsx, [slug]/      the public blog (Payload-driven)
    (payload)/
      cms/admin/[[...segments]]/   Payload admin  -> /blog/cms/admin
      cms/api/*                    Payload REST+GraphQL -> /blog/cms/api/*
apps/web/src/cms/    payload.config.ts, collections/, migrations/, payload-types.ts, seed.ts
apps/web/media/      uploads (Media.staticDir, resolved against the app root)
```
**Measured evidence.**
- **Route sweep (the acceptance test) `SWEEP_BASE=http://127.0.0.1:3100`:
  `164/165 PASS, 1 FAIL`** — the single failure is the documented CoinGecko 403 (K-8),
  which is an upstream refusal, not a route. That run is *stronger* than any pre-merge
  sweep: the probe process carried a session secret in its environment, so the 10
  auth-gated checks ran as well (`mut-auth` 7/7, `gate-auth` 3/3) instead of being
  skipped as unrunnable under K-11.
- **All 18 public pages 200, all 7 anonymous gates 307, treasury APIs 401,
  `/ticker/FOO` 404** — identical to pre-merge behaviour.
- **Blog parity was diffed against the still-running old app**, not asserted:
  `/blog` HTML (`<h1>FudCourt Blog</h1>`, same post list), `/blog/never-fake-rules`
  (identical `<h1>`), and Payload REST (`total 3`, same slugs, same order) are
  byte-identical between `:3001` (old) and the merged `:3199` (new).
- Family harnesses after the merge: llama **50** (1 cold-miss SKIP), news **49**
  (same SKIP class), chainrank **50**, signals **39**, khala **136/0**, reconcile
  **28** — all green. cryptorank **241/244** with the 3 failures being upstream data
  drift measured against `chainrank.fyi`/coingecko ground truth (`trending` nulls,
  a 4.68% related-coin price move, an empty `news` slice), the same class that failed
  pre-merge.
- `bunx tsc --noEmit` **0**; `bun run build` **0**; `bun run test:shapers` **80/80**;
  `check-contract.py` **CONTRACT_OK**; `check-deploy.py` **OK (7 units)**.
- **Two defects were found and fixed by the harnesses, not by inspection:**
  (a) `robots.ts` inside a route group silently compiled its body but registered no
  route — `/robots.txt` 404'd while `sitemap.xml` (a `route.ts`) worked; hoisting it
  to `app/robots.ts` restores it, and the 404 is exactly what the sweep caught.
  (b) 9 stale path references in the verify harnesses (`app/api/…`, `app/store/…`,
  `app/<seg>/page.tsx`, and the cryptorank shell's import needle) that the route-group
  move invalidated.
**Consequences.**
- **One process, one build, one lockfile, one unit.** The blog's 1.7 GB
  `node_modules` and its second Next version (16.3.5 vs 16.3.6) are gone; the repo is
  on one Next version, and `bun install` for the merged app took 2.6 s.
- **Payload's API is back under the inbound rate limiter.** `/blog/cms/api/*` is now
  matched by `middleware.ts` and priced at 2 units by `costForRequest` — leaving it
  out would have silently removed a cost surface from the limiter, which is the one
  thing the limiter exists to prevent.
- **`lib/guard.ts` gates nothing under `/blog`**, deliberately: Payload enforces its
  own auth from the `users` collection, and the public read path
  (`/blog/cms/api/posts`) must stay reachable for the blog pages to render.
- `/blog` joined `PUBLIC_ROUTES` (sitemap) and `/blog/cms/` joined `robots.txt`'s
  disallow list.
- Rollback is `git checkout` of the pre-merge tree plus re-enabling the retired unit;
  the tombstone `apps/web/deploy/RETIRED-fudcourt-blog.service.txt` records the
  removal commands.

## DR-018 — Folder architecture: one `src/` tree, vertical feature slices, and a gate that keeps it that way (2026-09-30)
**Status:** accepted, deployed (`fudcourt-web` :3100 serves the restructured tree;
`STRUCTURE_OK`, 165/165 route sweep).
**Context.** Owner direction: *"make folder architecture optimize and scalable"*. The
audit found the tree had drifted into three parallel non-route trees (`app/`, `lib/`,
`src/`) with no placement rule, two import conventions for the same thing, and a flat
`lib/` bag of 22 files mixing auth, database, HTTP, ten data families and routing. The
cost is measurable in locality: **cryptorank lived in five places** (lib client, lib
shaper, a component, an API route, a page) and tray #11 would have to guess where each
piece goes. DR-011 had already fixed the names once, and the layout decayed anyway —
so the missing piece was never the layout, it was a rule that fails when broken.
**Options.** (1) Leave the layout, document the convention; (2) collapse everything into
`src/` but keep a layer-first `lib/` (roles/data/families/…); (3) **vertical slices**:
one directory per data family holding its client, shaper/types and panel, plus
`platform/` for cross-cutting infrastructure and a structure gate; (4) colocate routes
inside feature directories.
**Decision. (3); (4) rejected on a hard constraint.** Next.js reserves `route.ts` /
`page.tsx` names, so a feature directory placed under `app/` silently becomes a set of
endpoints. Routes therefore stay in `src/app/` and must remain thin; the family's logic
lives in `src/features/<family>/`. (2) was rejected because a layer-first split forces
every new family to touch three directories, which is exactly the tax this change
exists to remove.
**The tree (one `src/`, layers by role, slices by family).**
```
apps/web/
  src/
    app/            ROUTES ONLY — (frontend)/ dashboard, blog/ CMS + frontend
    features/       one slice per data family: cryptorank chainrank khala llama
                    news dex markets ticker signals treasury tracker dashboard
                    (each holds client.ts + shapers/types + its panel)
    platform/       auth/ (session, guard, mutation, discord)
                    db/ (turso client)  http/ (rate limits, mut-client)
                    routing/ (public + view route tables)
    ui/             presentational primitives (leaf: imports nothing)
    styles/         design tokens + shared view types (leaf)
    shell/          the SPA state container that composes features
    cms/            Payload config, collections, migrations (Payload convention)
    middleware.ts   Next requires it beside app/
  scripts/  db/  media/  deploy/  (unchanged roles)
```
**The rule is enforced, not documented.** `scripts/checks/check-structure.py` fails on
the six drifts that have actually happened: a retired location returning (`lib/`,
`components/`, `store/`), imports escaping a layer by `../` chain instead of the single
`@/` alias, `platform/` importing a feature, `ui/`/`styles/` importing app code, one
feature importing another feature, and an empty slice directory. **Negative-tested:**
injecting `platform/db` → `features/khala` fails the gate; injecting `dex` → `llama`
fails it; recreating `lib/` fails it; the tree restores to `STRUCTURE_OK`.
**Measured evidence.**
- **Route sweep `165/165 PASS, 0 FAIL`** against the restructured app — the first fully
  green sweep recorded for this repo (the long-standing CoinGecko 403 had cleared), with
  every auth-gated check running because the probe carried a session secret.
- `STRUCTURE_OK (104 files: app 53, features 29, platform 10, cms 9, shell 1,
  styles 1, ui 1)`; `CONTRACT_OK`; `check-deploy` OK (7 units); `bunx tsc --noEmit` **0**;
  `bun run build` **0**; the offline suite **80/80**.
- Two supporting cleanups, both dead weight: the retired-by-DR-002 `.vercel/` directory
  (which still held live project ids) and a stray nested `apps/web/apps/web/public/media`
  tree.
- **The offline suite was made move-proof.** It used to compile with four bare `tsc`
  flag-soup invocations, which cannot express `paths` — so the moment the tree moved, the
  suites broke with `Cannot find module '@/…'`. It is now one project
  (`tsconfig.shaper-tests.json`) plus `scripts/tests/alias-resolver.cjs` (a `--require`
  shim resolving `@/` against the compiled output). One alias, no second convention.
**Consequences.**
- **Adding a family is now mechanical**: `src/features/<name>/` + one Go package + one
  verifier + one docs row, and the gate names anything placed elsewhere.
- The single `@/` alias replaced three conventions (`@lib/`, `@/components/`, and 18
  relative `../../lib/` chains). Cross-layer imports cannot silently appear.
- `docs/` was reorganized on the same principle — **by the question the reader arrives
  with**: `product/`, `architecture/`, `operations/`, `records/`, with `docs/README.md`
  as the index. All markdown links were rewritten depth-aware and validated
  (**0 broken links** across the repo).
- Rollback: the pre-change tree is archived (`/tmp/prestruct/{web,docs}.tgz`) and
  `git checkout` of the old paths restores it.

## DR-019 — Blazingly fast: local Postgres+TimescaleDB read model and a shared Valkey cache (2026-09-30)
**Status:** accepted, deployed (`fudcourt-web` :3100, `fudcourt-apicalls` :3101,
`fudcourt-pgload.timer`; both services enabled at boot).

### Why
Two measured bottlenecks, neither of them guesswork:

| Path | Measured | Cause |
|---|---|---|
| Treasury read (Turso) | **394 ms** round trip, 94 ms per SELECT | libsql client tunnels a WebSocket to the Neon primary over WireGuard |
| Exchange sweep (ticker) | **71–80 s** cold, 0.048 s warm | one quote per (venue, symbol, type) across ten exchanges, in module state |

"Blazingly fast" is therefore defined as: the same numbers, from closer, without
changing what they are.

### Decision
**1. Turso stays the system of record; Postgres becomes the read model.**
`db/schema.sql` was already the canonical schema, so `db/pg-schema.sql` mirrors it
1:1 (TEXT→text including the `datetime('now')` strings, REAL→double precision,
`INTEGER PRIMARY KEY`→`GENERATED BY DEFAULT AS IDENTITY` so source ids survive).
`src/platform/db/mirror.ts` projects Turso→Postgres idempotently and *prunes* —
`sync-live.py` runs `DELETE FROM assets` + re-INSERT, so upserting alone kept every
previous batch and doubled net worth (170.42 → 340.84; caught by the parity gate).

- `query()` reads local Postgres via Bun.sql; `execute()` writes Turso and then
  projects. SQLite dialect is translated in one place: `?`→`$n`, `ORDER BY rowid`
  →`ORDER BY id` (an INTEGER PRIMARY KEY *is* the rowid in SQLite, so this
  preserves the exact order; `ctid` would reorder after an UPDATE).
- Every ordering gained a total-order tiebreaker. SQLite's rowid makes an ORDER BY
  on a non-unique column deterministic; Postgres leaves ties unspecified, and the
  transactions list genuinely differed row-for-row until this was fixed.
- `scripts/tools/parity-pg.ts` gates it: the app's own `DASHBOARD_READS` are run
  against both engines and compared. Result: **PARITY_OK, 8/8 identical**.
- Effect: **94 ms → 0.2 ms per query; 8-query dashboard 5.1 ms warm.**
- Window accepted: sub-second staleness between a write and its projection. Turso
  remains the single writer, so this is bounded staleness, never split brain.

**2. TimescaleDB, for the one thing Turso never gave us.**
`asset_history` + `price_history` hypertables (2.30.1, Apache-2 on the existing
PostgreSQL 17 cluster, :5433). Every `assets` snapshot becomes a time-series row.
Retention is a `DELETE` in the projection, not `add_retention_policy()` — that API
is Timescale License and this build refuses it, so the install stays Apache-only.

**3. Valkey as a shared L2 that outlives a restart.**
Sidecar: `internal/cache` (valkey-go), consulted between each family's L1 and
upstream — llama, chainrank, news. Web: `platform/cache/valkey.ts` (Bun's native
client, no new dependency) for the ticker sweep. Both **fail open at every step**:
disabled, unreachable, or unreadable caches all resolve to "do the work as before".
- The cached value carries the ORIGINAL `fetchedAt` with the body, so a HIT never
  reports an hour-old body as fetched this second.
- **Serve-stale-while-revalidate** for the ticker: fresh ≤60 s, stale ≤1 h served
  immediately with a background refresh, L2 ≤1 h. The old 60 s TTL was smaller
  than the 71–80 s sweep, so a restart *always* re-paid it in full.
- Effect: **first ticker call after a process restart: 73.78 s → 0.12 s (~600×).**

### Verification
- `PARITY_OK` (8/8 dashboard queries byte-identical to Turso).
- Ticker cold 134.7 s → post-restart 0.12 s, 50 rows, timestamp preserved.
- Go: `go test ./...` green; the L2 is inert without `cache.Init()`, which is why
  the existing cache/single-flight tests still pass unchanged.
- Web: `tsc` 0 errors, `bun run build` clean.
- Honest limits: llama's L2 gain is modest (0.86 s → 0.47 s; a fast CDN), and the
  ticker is slower cold than before (134 s vs 80 s) — one most-recent sweep is now
  retained for the stale window, which costs some parallelism and buys the 600×.

**Superseded by DR-040** (Postgres+TimescaleDB is the single system of record; Turso/libSQL dropped).

## DR-020 — Executor data isolation: one `executor` Postgres schema, no migration runner (2026-09-30)
**Status:** accepted, landed in `apps/web` (the `executor` schema is created on first
use by `ensureExecutorSchema()`; the paper-mode E2E ran against the real cluster on
2026-09-30).

**Context.** The CEX Executor writes **live data**: exchange credentials, open
executions, child orders, fills, an append-only event log. DR-019 had just moved the
treasury read model into local Postgres, and that read model is not a passive copy —
`src/platform/db/mirror.ts` is explicitly a **pruner**: `sync-live.py` runs
`DELETE FROM assets` followed by fresh INSERTs, so the mirror runs
`DELETE FROM <table> WHERE <pk>::text NOT IN (…)` on every projection pass. That is
the right design for a mirror (upserting alone doubled net worth, 170.42 → 340.84,
caught by the parity gate) and **exactly the wrong blast radius for an order ledger
and a credential vault**. One `DROP`-class mistake, one mirror bug, one restore-from-
backup that replays a stale batch would erase fills and event history that exist
nowhere else — Turso is not a source for them, because the executor never writes there.

**Options.** (1) Executor tables in `public` beside the mirror; (2) executor tables in
`public` with the mirror's table list explicitly excluding them; (3) a dedicated
`executor` schema; (4) a second database.

**Decision — (3).**

**1. Every executor object lives in `executor`; nothing lives in `public`.**
`executor.exchange_accounts`, `executions`, `execution_plans`, `child_orders`,
`fills`, `execution_events`, `balance_snapshots`, `positions_snapshots`,
`risk_profiles`, `audit_logs` — created by `CREATE SCHEMA IF NOT EXISTS executor`
plus the tracked DDL. The blast radius is now the **schema**, not the connection: the
mirror's statements are unqualified names resolved through `search_path`, so they
cannot name an `executor` object even by accident, and a mirror that only ever
touches `public` leaves the executor's ledger untouched. (1) and (2) were rejected
because (2) is an *exclusion list* — it holds only until someone adds a table to the
mirror's list, and the failure mode is silent. (4) was rejected: it buys a second
connection string, a second backup, and a second restore drill to protect against a
blast radius that a schema qualifier already bounds.

**2. No migration runner. The DDL is tracked, and the app reads the tracked file.**
`EXECUTOR_DDL` in `src/platform/executor/store.ts` is executed by
`ensureExecutorSchema()` (called once at startup by both the API's
`bootstrapExecutor()` and the worker), one statement per round trip because the
extended query protocol refuses multi-statement strings, every statement
`IF NOT EXISTS`, so the bootstrap is idempotent and safe on every process start.
`database/schema/executor-schema.sql` is the readable copy **and the definition**:
since the 2026-10-02 lift it is the only copy, and `EXECUTOR_DDL` is that file read
at module load with its comment lines dropped (`readFileSync` from the repo root;
cwd is the app root under systemd). Until the lift the same SQL existed twice, in
the file and in a template literal, with `executor-store-tests.ts` asserting the two
were equal after normalisation. The two-copy hazard only exists on the Go side now
(an `embed` copy, pinned byte-exact by `TestEmbeddedSchemaMatchesTracked`), and the
TS side cannot drift because there is nothing left to drift from. Rationale for
keeping the compositional approach rather than adopting a migration runner is
unchanged: the schema has exactly one writer (this app) and no other consumer needs
to create it; a migration tool would add a second source of truth plus an ordering
discipline, for tables that `CREATE TABLE IF NOT EXISTS` already brings forward
correctly.

**3. Timestamps are `bigint` unix MILLISECONDS; money and quantity are `double
precision`.** The domain types carry `number` ms on the wire, so a bigint
round-trips exactly with no timezone and no parse; `timestamptz` would reintroduce
both. Money columns are doubles because the wire values are numbers and every
calculation happens in `decimal.js` upstream (`risk.ts`), never in SQL — so a
`numeric` column would add a parse and lose nothing. Status/enum columns are
`text`: the type unions live in `types.ts` and a new enum value must not require a
DDL change.

**Measured evidence.**
- `executor-store-tests.ts` asserts the isolation directly: no `\bpublic\.` occurs
  anywhere in `EXECUTOR_DDL`, every statement is `CREATE (SCHEMA|TABLE|INDEX) IF NOT
  EXISTS`, and no `timestamp with time zone` type appears.
- Paper-mode E2E against the **real** Postgres + Valkey + worker (2026-09-30):
  **38/38 checks PASS** — creation, immutable plan snapshot, child orders, fills,
  restart recovery with no duplicate children, cancel, event log, and secret
  hygiene. Every one of those reads or writes `executor.*` through the real store.

**Consequences.**
- The executor's data is disposable to every existing backup/restore, prune and
  parity procedure in the repo, and those procedures need no change.
- Adding a table is: add it to `db/executor-schema.sql`, add it to `EXECUTOR_DDL`,
  let the byte-identity test fail until both match, then add the store statement. The
  test is the gate that keeps the two copies honest.
- There is no down-migration path and no schema-version table — restoring an older
  binary against a newer `executor` schema is safe because every statement is
  `IF NOT EXISTS` and reads bind by column name, but a *column removal* is a
  manual, forward-only operation. Stated rather than hidden.

## DR-021 — Risk-first sizing is a hard constraint; credentials are sealed per field and never leave the server (2026-09-30)
**Status:** accepted, landed in `apps/web` (enforced by `executor-risk-tests.ts`,
`executor-engine-tests.ts`, `executor-store-tests.ts`, `executor-worker-tests.ts`
and the paper-mode E2E; 123 offline tests + 38 E2E checks green on 2026-09-30).

**Context.** The product premise (PRD §1, §6) is that the user defines **the
outcome or the risk**, and the system derives everything else: quantity, notional,
margin, leverage. That is easy to state and easy to erode — every exchange-native
form asks for a quantity, so a single `if (mode === 'risk')` that quietly falls back
to a raw quantity turns the premise into a suggestion while still reading as
risk-first in the UI. The failure is monetary and irreversible, so the constraint
has to live in code paths that cannot be skipped, not in a review checklist. The
second half is credentials: the executor is **BYOK and non-custodial** (PRD §43), and
the same process that holds the strategy engine also holds API keys that can move
money.

**Decision — 1. Sizing derives from risk/outcome; the engine is the only authority.**

**1a. The user cannot type a quantity and have it honoured as risk.** The request
contract (`ExecutionRequest` → `SizingDefinition`) carries one of nine sizing modes —
`risk_usd`, `risk_percent`, `allocation_usd`, `allocation_percent`, `notional_usd`,
`fixed_quantity`, `fixed_margin`, `target_profit_usd`, `target_profit_percent` — and
the *engine* (`risk.ts`, `plan.ts`) turns it into quantity, notional, margin,
required leverage and liquidation price. All money math is `decimal.js`; `number`
appears only at the wire edge. The capital modes (`notional_usd`,
`fixed_quantity`, `fixed_margin`) exist because they are genuinely useful, but they
are **not** risk sizing and the UI never labels them as such — the same rule the
data families already follow (PRD §11 separates Risk % from Allocation % as distinct
outputs, PRD §38 requires a stop for risk-based sizing; the labelling rule itself is
this repo's house rule from DR-018, not a PRD clause).

**1b. Risk figures are fee-aware and rounded DOWN, always.** Total risk is
`priceRisk + entryFee + exitFee + slippageRisk + safetyReserve = Q · unitRisk`, where
the exit leg is priced at the **stop** and market entries are charged slippage
exactly once (`risk.ts`'s cost model, PRD §22–§23's `TotalRisk` breakdown). Every
exposure quantity is floored to the instrument's step grid, so a rounded position can
never exceed the unrounded budget (PRD §106):
`quantity >= 0`, `notional >= 0`, `risk >= 0`, `rounded ≤ unrounded safe quantity`,
`risk after rounding ≤ risk budget`; for auto leverage, `selected ≤ userMax` and
`selected ≤ exchangeMax`.

**1c. `auto_safe` leverage is a selection, not a suggestion.** Margin feasibility is
a LOWER bound on leverage, liquidation safety an UPPER bound, and the engine picks
the **minimum** feasible leverage — maximising liquidation distance — capped at
`min(userMax, exchangeMax)` only when that cap is feasible. When the cap sits below
the margin lower bound, the engine selects the cap (still ≤ every max, so §106
holds in every branch), warns, and forces `liquidationSafe: false` rather than
claiming safety. The liquidation price is explicitly preview-grade
(`E·(1 ∓ 1/L + mmr)`, PRD §21); venue brackets are preferred where available.

**1d. Over-order protection is enforced twice, on top of the strategy engine.**
PRD §107's invariants — `Σ child quantities ≤ target quantity`, `reduce-only ≤ open
position` — are held by the **worker** (`clampChild`), not only by the engine: entry
children are bounded by the planned quantity minus everything filled or still open
on the entry side, both the request and the room floored to the step grid, so
flooring a room can never round an order *up* into extra exposure. Exit children are
NOT bounded by the entry room — they are reduce-only and sized to cover the full
planned entry — but they still pass through the same grid floor, so an exit is
dropped to `null` rather than sent when it rounds to zero. A clamp that shrinks an
order emits `PLAN_RESIZED`; the worker's engine-side clamp and this one are belt and
braces because a duplicated order is real money. `client_order_id` is unique per
execution (`fud_{executionId}_{sequence}`), so a retry cannot double-submit either.

**1e. The risk budget is a hard cap at runtime, not only at creation.** When
projected risk after reconciliation would exceed the remaining budget, the worker
resizes to `maxSafeQuantity` and stops with `RISK_STOPPED` (PRD §37); it never
silently violates the bound. A Risk+Profit conflict is returned as a `conflicts`
entry and **blocks** creation (PRD §117 default); the preview may show Requested vs
Possible, but `POST /executions` refuses a conflicting plan.

**1f. Execution maths reads the immutable creation-time plan.** `execution_plans`
holds the plan snapshot (instrument grid, fee model, slippage model) written at
creation; the worker reads *that* and never re-derives one. A missing plan is a
FAILED execution, not a guessed one.

**Decision — 2. Credentials: per-field AES-256-GCM, master key from env, fail-closed.**

**2a. BYOK, non-custodial.** The user supplies their own API key/secret/passphrase;
funds stay at the exchange. **Withdrawal permission is unsupported**: a key whose
restrictions report `withdraw: true` is refused at connect/test with the reason
spelled out, not silently downgraded.

**2b. Per-field envelope encryption, not one blob.** Each secret is sealed
individually with **AES-256-GCM** under a fresh 12-byte IV (`randomBytes(12)` per
call — a GCM nonce must never repeat under one key), and the 16-byte auth tags are
concatenated in column order (`iv`/`auth_tag`: 12 + 16 bytes per secret; 3 secrets ⇒
36-byte IV, 48-byte tag). Per-field means a compromised row cannot be decrypted
partially-by-attrition, and a wrong key or tampered ciphertext **throws** on the GCM
tag rather than returning garbage. Keys shorter/longer than 32 bytes or non-hex are
refused before any crypto runs.

**2c. The master key is `FUDCOURT_EXECUTOR_MASTER_KEY`, 64 hex chars = 32 bytes, and
its absence is FAIL-CLOSED.** `masterKeyFromEnv()` reads it lazily and throws when it
is missing or malformed; every credential operation then fails loudly rather than
storing or decrypting anything. It lives in the git-ignored `apps/web/.env.local`
only, is never committed, and **never enters Postgres** — only the sealed bytes do
(PRD §44's "master encryption key outside PostgreSQL"). `rotateCredentialKeys`
re-encrypts every secret under a new key without touching the schema.

**2d. Plaintext has exactly one path, and it is server-side only.** The store's
`revealCredentials(userId, id)` is the only method returning plaintext; it is
user-scoped and it is never returned to a browser, never logged, and never placed in
an error. The only plaintext that ever reaches a client is `apiKeyMasked`
(`ABC...XYZ`, `***` when ≤8 chars). Every response carries the masked
`CredentialRecord`; the E2E asserts the plaintext secret appears in neither the API
list payload nor the raw database row. `mapError` sanitises adapter errors before
they leave `exchange.ts`, so no key/secret/passphrase or signed payload can appear in
an `ExecutorError` (PRD §109).

**2e. Ownership and the kill switch.** Every user-scoped store statement binds
`user_id` and a wrong user reads `null`/`[]` — never an error, never a row, and the
API answers **404** (not 403) so existence is not leaked. `/executor` and
`/api/executor` are tier-gated at `team`, the same tier as the treasury surface they
move money beside. LIVE placement additionally requires `FUDCOURT_EXECUTOR_LIVE=1`;
off ⇒ live executions PAUSE at the placement boundary (recoverable by flipping the
switch and resuming), paper and reconciliation keep running.

**Measured evidence.**
- `executor-risk-tests.ts` (39 tests): fee-aware sizing linearity, round-down to
  step, every §106 invariant, the `auto_safe` cap branches, liquidation
  approximation, `maxSafeQuantity` exactness under partial fills.
- `executor-store-tests.ts` (41 tests): §44 round-trips (multi-byte UTF-8, base64
  padding, empty string, 4 KiB), a non-32-byte/non-hex key refused before crypto,
  `masterKeyFromEnv` fail-closed, per-field IV/tag lengths, the DDL byte-identity and
  `public.`-absence assertions, user-scoping on every statement.
- `executor-worker-tests.ts` (9) + `executor-engine-tests.ts` (20) + `executor-ui-tests.ts` (8): clamp, restart
  recovery with no duplicate child orders, RISK_STOPPED, lock contention, TWAP
  jitter, and the chase-limit cancel/replace contract (§2g).
- Paper-mode E2E against real Postgres + Valkey + worker (**38/38**, 2026-09-30):
  risk-based sizing from a $40 budget → qty 0.0198 < 0.02 with projected risk 39.996
  ≤ budget; `Σ child qty 0.0171 ≤ planned 0.0198`; over-order still holds after
  restart; credential decrypts server-side only, no plaintext in list payload or DB
  row.

**Consequences.**
- The risk budget is the product's core promise, so it is enforced in the sizing
  engine, the planner, and the worker's placement clamp — three independent points,
  because one of them being bypassed is the failure mode that costs money.
- A capital-sizing request (`notional_usd` etc.) is legitimate but must never be
  presented as risk sizing; the preview keeps the two distinct.
- Rotating the master key requires a `rotateCredentialKeys` pass, not a re-connect of
  every account; a lost key is unrecoverable by design (there is no escrow).
- Live trading is off unless the operator opts in with `FUDCOURT_EXECUTOR_LIVE=1`,
  matching §108's kill switch; the default posture is paper.

**2f. Portfolio ceilings are enforced, not advisory.** PRD §72–§74 define
account-level ceilings (`maxOpenRiskPct`, `maxDailyLossPct`). Storing them without
checking them would make the settings screen a lie — a user who sets "max open risk
5%" and is never stopped has no protection at all. Both are therefore hard gates at
`createExecution`, evaluated BEFORE the row exists so a refusal leaves nothing behind
to reconcile:

- **§73 open risk.** `store.summarizePortfolioRisk` aggregates in ONE SQL statement —
  `SUM(COALESCE(current_risk, planned_risk))` over live executions — so the ceiling is
  checked against a single consistent snapshot rather than a sum that could straddle
  a concurrent fill. `current_risk` (recalculated after every fill, §36) wins over
  the stale `planned_risk`: committed risk is what it stands at, not what it was
  planned to be. A new opening is refused when `openRisk + ownRisk` exceeds the
  ceiling.
- **§74 daily loss guard.** Realized P&L per closed execution is exit-leg proceeds
  minus average-entry-price × exited quantity, minus every fee on the execution,
  summed over executions that closed today. At `-maxDailyLossPct` of equity, new
  openings are blocked.
- **Exits are never gated.** `intent: 'close'` and `'reduce'` bypass both checks by
  construction. A guard that could refuse an exit would trap the user inside the very
  risk it exists to bound.
- The decision is a **pure function**, `evaluatePortfolioGates`, so the rule itself is
  testable with no database and no venue; the wrapper only gathers numbers.

Both refusals answer **409** carrying the committed figure, the requested figure, the
computed ceiling, and the configured percentage, so the UI can explain the refusal
without the user guessing. §117's default of BLOCK applies unchanged: nothing is
resized and no override exists.

**2g. A strategy that manages a working order is not "finished" when nothing is
left to place.** An audit against §128's acceptance list found three defects that
the existing suite could not see, because the tests exercised the quantity-placing
path and never the order-managing one:

- **Chase Limit was inert.** `placeEntry` returned early on `remaining <= 0`, and
  a working child order makes `remaining` exactly 0. So on the tick after its first
  placement the engine emitted `complete` and the strategy could never reprice — it
  did not chase at all. `strategyStep`'s completion check and `placeEntry`'s guard
  now both exempt the strategies whose job is to *manage* a live order (chase,
  iceberg), and the completion test pins it: place → cancel → replace at the moved
  touch, twice, then stop.
- **The reprice placed without cancelling.** The replacement order was emitted
  while the old child was still working, leaving two live orders on one position —
  the over-order path §107 and §128.15 forbid. §32 is cancel-then-replace, so the
  cancel is emitted and the replacement waits for the venue's acknowledgement.
- **The replacement budget was unreachable and off by one.**
  `constraints.maxDurationMs !== undefined ? A : A` assigned the same constant on
  both branches, so a user could never set it; and the *first* placement
  incremented the counter, so `maxReplacements: 1` permitted zero repricings and
  `0` refused to trade. It now counts cancel/replace cycles only, and the guard
  applies only once a first peg exists.

Also wired here: `TwapConfig` (PRD §29) was declared in the contract but never
reachable — both jitters were hard-wired to 0 through a ternary with identical
branches, so §28's randomization could not be requested at all. Jitter is now
opt-in through the composer, and the planned schedules normalize the jittered
quantities back to the target so §107's exact sum still holds. A related float bug
was fixed with it: the final slice's remainder was computed as
`target - acc` in binary floating point, landing a hair below the truth, so
`floor8` dropped a whole 1e-8 step and every TWAP finished short of its planned
quantity. The remainder is now exact decimal arithmetic.

`maxChaseDistance` and `minReplacementIntervalMs` are honoured, validated
(a negative distance or a non-integer budget is refused, never clamped, per §55),
and exposed in the composer.

**2h. A control that no test can reach is a control that does not exist.** The
engine audit above found the defects by asking a different question: not "does
this work?" but "what would a failure here look like?" For Chase Limit the answer
was "the order-managing path is never exercised", because every existing test
drove the quantity-placing path. Three things followed:

- `executor-ui-tests.ts` (8 tests) now pins the composer→API seam against the
  exported pure `buildExecution`. It fails if a field is added to the form and
  not to the request, and it pins the omit-if-unset rule in both directions: a
  blank jitter or budget is **absent** from the body, while an explicit `0`
  replacement budget is **transmitted** (it is a real instruction — place once,
  never reprice — and a `value || undefined` filter would have swallowed it).
- `/api/executor/*` was falling through the inbound limiter to `DEFAULT_COST`
  (1 unit), making live order placement the cheapest way into the backend. The
  family is now priced at 8, inherited by every sub-path so
  `/api/executor/executions/:id/cancel` is not a cheaper way to trade, and the
  cost table's own guard test (which exists to stop unmeasured pricing) records
  the reasoning inline.
- The composer's server-rendered HTML was verified to omit an untouched optional
  constraint rather than defaulting it to `0`, and the built client bundle
  contains the new fields.

Measured: `executor-engine-tests.ts` 20/20, `executor-ui-tests.ts` 8/8, total
offline suite **222/222** (137 executor tests), paper E2E **38/38**, tsc 0,
`next build` green, all six `/executor*` pages 200 behind an authenticated
`team` session and 307 without one.
- §33 — **A Scale In ladder is priced per level, never off its top level.** The
  sizing code priced a ladder like a single entry at `refPrice`, which made two
  separate false promises to the user. First, the risk bound: a ladder fills at
  every level, so its worst case is the fraction-weighted sum `Σfᵢ|levelᵢ − stop|`,
  not the distance from the top level to the stop. The budget bought more size
  than it could pay for. Second, `estimatedEntry` reported the top-level limit
  while the position's realized entry is the ladder's VWAP — and that single
  number is what feeds liquidation (§17/§21), the profit projection (§13) and the
  R:R the user reads (§84). A 50% @ 99,000 / 50% @ 93,000 ladder was reported as
  entering at 100,000 when it fills at 96,000.
  - Sizing is now exact decimal arithmetic over the levels: total risk is linear
    in quantity with fractions fixed, so `Q = budget / riskPerUnit`, rounded DOWN
    to the step grid so the bound survives rounding (§71, §106). Fees are charged
    per level on their own notional and the exit fee on the whole filled
    position, so the budget covers the most expensive way the ladder completes.
  - The §37/§117 hard-bound resize had to become ladder-aware too. It called
    `maxSafeQuantity`, which prices from a single reference entry; feeding it a
    ladder's VWAP under-counts per-unit risk and returns a quantity that
    breaches the very bound being enforced. Re-solving the ladder against the
    bound is the only correct reading — and on this ladder the VWAP (96,000) sits
    BELOW the stop (98,000), so a single-reference distance is negative and no
    correct quantity follows from it at all.
  - A level sitting on the stop has no bounded risk: refused, never silently
    sized to zero.
Measured: `executor-plan-tests.ts` **25/25** (7 new — the ladder sizing, its
percentage variant, the VWAP report, and the bound resize), total offline suite
**228/228** (143 executor tests), paper E2E **42/42** against real Postgres
(the ladder buys 0.0132 on the same $40 that buys 0.0198 for a single entry, and
reports entry 96,000). Each fix was confirmed load-bearing by removing it: the
VWAP branch fails its own test, and the VWAP-based resize does not merely
misbehave — it fails to typecheck, because a single-reference resolver cannot
express a ladder at all.
## DR-022 — Go is the default backend language; Rust is specialized (2026-10-01)
**Status:** accepted (standing rule; incidents recorded in DR-005, DR-009, DR-010, DR-012, DR-013, DR-016).
**Context.** Backend work landed in several languages as families were rescued one by one; without a stated default, every new service re-litigates the choice. The evidence already points one way: all application logic that decides anything — data acquisition (`services/data`, DR-005/009/012/013), the API (`services/api`), the executor (`services/executor`) — is Go with stdlib `net/http` and no framework (DR-016), while Rust earns its place only where the runtime profile demands it.
**Decision.** Go is the default for backend services. Rust is permitted for specialized workloads — streams and observers — which is what `services/sync` is: one crate (`services/sync/Cargo.toml`) watching exchange/chain state and reporting (balance sync + reconcile maths), no business decisions. Objective (`.ai/restructure-fudcourt.md` Phase 6) says it verbatim: "Keep business decisions in Go." Rust MUST NOT take executor business logic (objective CRITICAL CONSTRAINTS).
**Consequences.** New services start as Go unless they are stream/observer workloads; the Python `sync-live.py` twin and `cr_fetch.py` survive only as oracles, never as runtimes (DR-005/DR-010). A Rust business-logic contribution is a design error, not a style choice.
## DR-023 — PostgreSQL is the durable source of truth; Valkey is ephemeral coordination (2026-10-01)
**Status:** accepted (deployed posture — DR-019, DR-020; this entry states the split as a rule).
**Context.** Two stores, one temptation: using the fast one for truth. DR-019 put the Postgres read model + Valkey L2 in place for latency; PRD §64 gives Valkey locks, leases, heartbeats, idempotency keys and snapshots. The failure mode of blurring them is durable state that evaporates on restart.
**Decision.** PostgreSQL is the only durable source of truth (treasury read model `database/schema/{schema,pg-schema}.sql`; execution ledger `database/schema/executor-schema.sql`, DR-020). Valkey holds only what may be lost: distributed locks (`execution:{id}:lock`, PRD §65 — `apps/web/src/platform/executor/lock.ts`, `services/executor/internal/lock`), rate limits, worker leases, market snapshots, idempotency keys (PRD §64). Objective states it as architecture rules: PostgreSQL "durable source of truth"; Valkey "cache / locks / transient queues / ephemeral coordination".
**Consequences.** Losing all of Valkey costs at most a reconcile pass (recovery rules in `docs/architecture/executor.md` §5), never data. Cache failures fail open (`platform/cache/valkey.ts`); lock failures fail closed (`lock.ts`) — the one asymmetry is deliberate: lost cache = extra work, lost lock = duplicate orders.
## DR-024 — Postgres + Valkey are sufficient: no Kafka, NATS, or Kubernetes (2026-10-01)
**Status:** accepted (constraint on all future work).
**Context.** The stack runs on one homeserver behind a Cloudflare Tunnel (DR-002) with systemd units (`deploy/systemd/`). Message brokers and orchestrators were proposed implicitly every time "events" or "worker" came up. The objective forbids them outright unless existing code requires it ("Do NOT introduce Kubernetes, Kafka, NATS, service mesh, or additional infrastructure unless existing code already requires it"; "PostgreSQL and Valkey are sufficient for the current architecture"; "Do NOT create unnecessary microservices").
**Decision.** No broker, no orchestrator. Durable event flow is the append-only `executor.execution_events` table (PRD §63) and the `packages/contracts` event catalog; scheduling is the executor worker (PRD §67–68) driven by a systemd unit (`deploy/systemd/fudcourt-executor-worker.service`); coordination is Valkey (DR-023). A small number of strongly bounded services, deployed as units.
**Consequences.** Event consumers poll/read the log or the API — there is no pub/sub fan-out to rely on (Valkey pub/sub MAY appear as a convenience, never as the delivery guarantee). Introducing a broker later requires a new DR with measurements, not a quiet dependency.
## DR-025 — The executor moves out of Next.js into `services/executor` (Go); the TS stays the parity oracle until cutover (2026-10-01)
**Status:** accepted, **in flight** (Phase 5 of `docs/architecture/migration-plan.md`; Go packages landing in `services/executor/internal/*`, port table in `docs/architecture/executor.md` §2).
**Context.** The CEX executor — money-moving code: risk math, sizing, strategies, exchange signing, worker, locks — lives today inside the Next.js app (`apps/web/src/platform/executor/*`, 16 API route handlers, `apps/web/scripts/executor/worker.ts`). The objective forbids exactly that ownership ("apps/web MUST NOT permanently own: executor runtime, risk engine, order sizing engine, exchange API adapters, exchange signing, execution workers, distributed locks, reconciliation, core backend persistence"; `docs/architecture/target.md` §3.2). The same process serving HTML holds exchange API keys.
**Decision.** The executor domain is ported to `services/executor` (Go) package by package (`docs/architecture/executor.md` §1: `executor`, `decimal`, `exchange`, `risk`, `sizing`, `execution`, `idempotency`, `orders`, `strategy`, `lock` landed; `planner`, `worker`, persistence, `cmd/executor` in flight). **Until Go parity is demonstrated through tests, the TypeScript runtime remains the production executor and the parity oracle** (objective §22; "Do NOT remove the existing TypeScript executor until Go parity is demonstrated through tests"). The parity matrix (Feature × TS × Go) lives in `docs/architecture/executor.md` §3 and gates each deletion; `apps/web/scripts/tests/executor-*-tests.ts` (155 tests) are the seed oracle (`docs/architecture/current.md` §5a). Cutover deletes the TS path cleanly — no shims, no dual write beyond the migration window (`migration-plan.md` Phase 5: one worker live at a time).
**Consequences.** For the migration window, `docs/architecture/target.md` §3.2's forbidden ownership is knowingly violated by `apps/web` and documented as such (`docs/architecture/domain-map.md` §3.1 lists all 20 importing files). Money-path code exists twice until parity closes; that window is bounded by the matrix, not by calendar.
## DR-026 — Exchange adapters use canonical interfaces; venue differences stay in the adapter (2026-10-01)
**Status:** accepted (enforced in `services/executor/internal/exchange`; TS mirror `apps/web/src/platform/executor/exchange.ts`).
**Context.** Binance, Bybit and MEXC disagree on symbols, precision, statuses, order types and error shapes. Venue conditionals scattered through strategy/risk code make every new venue a full rewrite and hide venue-specific bugs inside the money path.
**Decision.** One canonical `Exchange` interface with normalized models, capabilities, errors and symbol mapping (`services/executor/internal/exchange/exchange.go`, objective §8.16). Per-venue adapters (`binance/`, `bybit/` (in flight), `mexc/`, `paper/`) absorb every wire difference; **core executor code MUST NOT branch on the venue** — "No `if exchange == "binance"` outside this package (objective §8.16)". Adapter errors are sanitized before leaving the boundary (PRD §109, `exchange.ts` `SECRET_PATTERNS`).
**Consequences.** A new venue is a new adapter package + capability registry entry, nothing else. Anything the canonical interface cannot express gets added to the interface (and thus to every adapter) rather than special-cased at a callsite. Wire details not verifiable offline are recorded as ASSUMPTION comments, never TODOs (`binance/mexc` adapter headers).
## DR-027 — OpenAPI in `packages/contracts` is the API contract source of truth (2026-10-01)
**Status:** accepted, landed for the executor surface (data/sync/api surfaces in flight — `docs/architecture/migration-plan.md` Phase 3 amendment).
**Context.** The executor API's contract previously existed only as TS types + route handlers, so Go, Rust and the SDK could drift silently. The objective makes `packages/contracts` the only shared artifact ("openapi/, events/, schemas/ — the ONLY shared artifacts", `docs/architecture/target.md` §4).
**Decision.** `packages/contracts/openapi/fudcourt.yaml` (OpenAPI 3.0.3; 15 paths / 19 operations mirroring `types.ts` + the route handlers) is the contract source of truth; `packages/sdk-ts` generates from it (`bun run generate`, deterministic — migration-plan Phase 3). Requests are closed (`additionalProperties: false`); error bodies keep server text (`packages/contracts/schemas/error-envelope.json`). The Go services MUST preserve these methods, paths and envelopes (`fudcourt.yaml` header). Additive changes per release only; breaking changes require a versioned path.
**Consequences.** A behavior change that is not in the contract did not happen: extend the yaml, regenerate the SDK, then change implementations. Hand-editing generated SDK copies is forbidden. The contract gate (`check-contract.mjs`) and CI job `contracts` keep the three copies honest.
## DR-028 — Ledger entries are immutable; corrections are adjustment entries (2026-10-01)
**Status:** accepted (policy; enforcement **in flight** — see consequences).
**Context.** Financial history that can be edited cannot be audited, and a "fix" that rewrites a past row erases the evidence of the original error. The treasury tables (`journal`, `ledger`, `transactions` — `database/schema/schema.sql`) are the accounting record behind portfolio and reconciliation.
**Decision.** Posted ledger entries are immutable. A mistake is corrected by a compensating **adjustment entry** (new `journal` row referencing the original), never by UPDATE or DELETE of posted history. Same rule already enforced for the executor event log: `database/schema/executor-schema.sql` — "no UPDATE/DELETE path exists in the store and none may be added — history is the product here".
**Consequences.** Read models MAY rebuild (`services/data` + `services/sync` projections, DR-019), but the entry log only grows. **Reality gap (2026-10-01):** the current TS transaction API still carries `UPDATE`/`DELETE` paths (`apps/web/src/app/(frontend)/api/transactions/[id]/route.ts`, `.../transactions/route.ts`); removing them and adding the adjustment-entry path is in flight with the `services/api` portfolio/treasury move (`docs/architecture/migration-plan.md` Phase 4) and must not be described as done before it lands.
## DR-029 — Portfolio is derived state: it derives from canonical sources and never mutates financial truth (2026-10-01)
**Status:** accepted (target architecture `docs/architecture/target.md` §5).
**Context.** Net worth, positions and risk aggregates tempt every layer to "fix" them at the read edge. DR-020 already documented the blast radius of a mutative mirror over financial tables (the pruner bug that doubled net worth).
**Decision.** Portfolio views derive from canonical sources — `ledger`/`journal`/`trades`/`transactions` and `services/sync` snapshots (`docs/architecture/domain-map.md` §2: "portfolio (derived from ledger/positions)") — and the portfolio domain MUST NOT write, adjust or patch financial truth to make a view agree. Disagreement is a reconciliation finding (Rust `services/sync/src/reconcile.rs`), resolved by new entries (DR-028) at the source.
**Consequences.** Portfolio code is read-only by construction; its tests assert derivation, not mutation. Any "portfolio fix" that edits a source row is a DR-028 adjustment at that source — never a projection edit. The DR-019 Postgres mirror stays a projection (with pruning), and `executor.*` stays outside its blast radius (DR-020).
## DR-030 — Events are append-only; shape evolution rides `event_version` (2026-10-01)
**Status:** accepted (`packages/contracts/schemas/event-envelope.json`, `packages/contracts/events/catalog.json`; execution log enforcement in `database/schema/executor-schema.sql`).
**Context.** Consumers (UI log, audit, future stream work in `services/sync`) need stable meaning across releases; producers need room to add fields. Mutable or silently-reinterpreted events break both.
**Decision.** Events are immutable facts: one row per occurrence, never updated or deleted (`executor.execution_events`, PRD §63). The envelope is canonical (`event_id`, `event_type`, `event_version`, `occurred_at`, `request_id`, `actor_id`, `resource_id`, `payload` — `docs/architecture/events.md` §1). **Evolution rule:** consumers MUST tolerate additive changes within the same `event_version` (ignore unknown payload keys); any breaking change bumps `event_version`. Canonical `event_type` ids are PascalCase (`ExecutionCreated`); legacy SCREAMING_SNAKE names are accepted aliases (`catalog.json` `alias_policy`).
**Consequences.** Producers MAY add payload keys freely; they MAY NOT rename/remove/retype without a version bump and a consumer migration window. Emission failures never block execution control (`worker.ts` `safeEvent` swallows store errors — the event log is history, not a control channel). Secrets never enter events (see DR-031).
## DR-031 — Credential sealing: per-field AES-256-GCM, credential_id-only references (2026-10-01)
**Status:** accepted, landed in `apps/web` — **recorded elsewhere in detail: [DR-021](DECISIONS.md) §2 (2a–2e)**; this entry fixes the standing rule for the `services/executor` port.
**Context.** The executor is BYOK and non-custodial (PRD §43–45), so one row holds key material that can move money. A single-blob envelope decrypts partially-by-attrition and couples rotations to the weakest field.
**Decision.** Each secret is sealed individually with **AES-256-GCM** under a fresh 12-byte IV, 16-byte auth tag per secret, concatenated in fixed column order `api_key, api_secret, [passphrase]` (`database/schema/executor-schema.sql`, `apps/web/src/platform/executor/store.ts`). Master key from env (`FUDCOURT_EXECUTOR_MASTER_KEY`, 64 hex), missing/malformed ⇒ credential operations fail closed. **Outside the vault, only `credential_id`/`account_id` references exist** — order, fill and execution rows carry FKs, never key material; only `api_key_masked` (`abc...xyz`, PRD §109) is displayable (DR-021 §2d). Withdrawal permission is never requested/used (PRD §43; `docs/architecture/security.md` §4).
**Consequences.** `services/executor` inherits this layout byte-for-byte (migration-plan Phase 5: "Encrypted keys must be re-encrypted/imported, not copied raw"); a Go port that stores plaintext or a single blob violates this DR. A lost master key is unrecoverable by design (no escrow); rotation is a re-encrypt pass (`rotateCredentialKeys`), not re-onboarding.

## DR-032 — No root `Cargo.toml` workspace, no root `bun.lock` (2026-10-01)
**Status:** accepted (deliberate deviation from the objective's target tree; recorded so it is a decision, not an omission).
**Context.** The objective's target tree lists `Cargo.toml` and `bun.lock` at the repo root next to `go.work` and `package.json`. Inspected reality: exactly one Rust crate exists (`services/sync`, its own `Cargo.toml` + `Cargo.lock`), exactly one JS workspace with dependencies exists (`apps/web`, its own `bun.lock`), and Go already unifies its three modules through `go.work`. A root Cargo workspace wrapping a single member adds a level of indirection with no build/test/CI benefit; a root `bun.lock` would have to be kept byte-identical to `apps/web/bun.lock` forever or become a second, silently divergent lockfile.
**Decision.** Keep the toolchain roots where the artifacts are: `go.work` unifies the Go modules, `services/sync/Cargo.toml` is the only Cargo manifest, `apps/web/bun.lock` is the only JS lockfile. The objective explicitly allows this adaptation ("This is a target structure, not an excuse to blindly move every file. Inspect the repository and adapt where appropriate") and the minimal-infrastructure rule (§4: no new infrastructure without demonstrated requirement).
**Consequences.** A second Rust crate or a second JS install would re-open this decision (add the root workspace then, not now). CI (`rust.yml` `working-directory: services/sync`, `web.yml` in `apps/web`) already builds each artifact where it lives, so nothing about a root manifest is missing operationally.
## DR-033 — One name per service: the data sidecar is `fudcourt-data`, and no live credential sits in a tracked file (2026-10-01)
**Status:** accepted and landed (binary `services/data/bin/fudcourt-data`, package `services/data/cmd/data`, unit `deploy/systemd/fudcourt-data.service`, installed as `fudcourt-data.service` on `:3101`).
**Context.** Phase 1 moved `apps/apicalls` to `services/data` but renamed only the directory: the binary, the Go package, the env prefix (`APICALLS_*`), the unit (`fudcourt-apicalls`) and the docs still carried the name of the 2026-09-29 spike (DR-005). One component had two names, and the host ran the retired one (`fudcourt-apicalls.service`) while the repo described the new one — drift `systemctl` reported as fact. Separately, the tracked tombstone `deploy/systemd/RETIRED-fudcourt-apicalls.service.txt` carried `APICALLS_VALKEY_PASSWORD=` with the **live** Valkey password in clear text.
**Decision.** (1) The component is `fudcourt-data` everywhere: `cmd/data`, `bin/fudcourt-data`, env prefix `FUDCOURT_DATA_*`, unit `fudcourt-data.service`, cache `~/.cache/fudcourt-data`, script `smoke-data.sh`. The spike name survives only where it is history (`apps/apicalls`, the `apicalls-probe` spike, the tombstone). (2) No tracked file carries a live credential; units read secrets from the gitignored `EnvironmentFile` (`/home/dwizzy/fudcourt/.env`, 0600). (3) A committed secret is treated as burned and **rotated**, because deleting the line does not delete it from git history.
**Consequences.** `fudcourt-apicalls.service` is disabled and its installed unit renamed aside; `fudcourt-data.service` is the one bound to `:3101`. Renaming a service means renaming its env prefix, and a consumer still reading `APICALLS_*` silently gets the default rather than an error — so the sweep is held by `check-contract.py` (guards updated to the new const) plus the live verifiers, never by grep alone. The rotation is the repair: the old password is rejected and the L2 is proven by a cold→warm ticker (71.0 s → 0.023 s).
## DR-034 — Two canonical id spaces behind the frozen envelopes: reference data is bounded, instruments are per-venue markets (2026-10-01)
**Status:** accepted and landed (`2904749`, `33958a8`, `2830118`, `6531d45`). Adoption is **not**
started: no route, no SQL table, no consumer re-pointed (§"What this does not close").
**Context.** The canonical model recorded Asset/Token/Chain/Venue as having no id space and
`InstrumentID` pinned to `binance:spot:BTC/USDT` with nothing minting it — symbols were the de-facto
key on every money row. Before any consumer could be re-pointed, two things had to be decided: what
mints each id, and where the canonical layers sit relative to response bodies clients already read.
Both were decided in code, and this entry records the decisions and the boundary they must not
cross.
**Decision — two id spaces, one hashing implementation.**
1. **Reference space** (`backend/api/internal/markets/reference`, salt
   `fudcourt/canonical-reference/v1` — `registry.go:13`). Preimage exactly
   `id = kind ":" hex(sha256(salt NUL kind NUL naturalKey))[0:10]` (`ids.go:35` `MintIDWithSalt`;
   `IDHexLen = 10` at `ids.go:15`). Kinds are exactly `asset`/`token`/`chain`/`venue`
   (`reference.go:97-103`, `EntityKinds`), and each kind's natural key is stable and non-display:
   `asset/<kind>/<SYMBOL>`, `token/<chain-name>/<FULL address>`, `chain/<name>`, `venue/<venue-id>`
   (`AssetKey`/`TokenKey`/`ChainKey`/`VenueKey`, `ids.go:48-68`). The whole table ships as a data
   artifact, `shared/contracts/data/reference.json` (`document_version` 1; 9 chains, 8 assets,
   11 tokens, 12 venues, 49 mappings, 7 unmapped, 3 misses), drift-pinned by
   `TestReferenceArtifactIsCurrent` (`document_test.go:467`) and `TestBuildIsPinnedToKnownIDs`
   (`registry_test.go:36`).
2. **Instrument space** (`backend/api/internal/markets/instruments/canonical.go`, salt
   `fudcourt/canonical-instrument/v1` — `:57`, kind `"instrument"` — `:53`). Preimage
   `"instrument:" + hex(sha256(salt NUL "instrument" NUL naturalKey))[0:10]`, naturalKey built ONLY
   from RESOLVED components — `venue_id`, market type, `base_asset_id`, `quote_asset_id`,
   `settlement_asset_id` — never a spelling (`MintInstrumentID:264`). Pinned by
   `TestInstrumentIDGoldenVector` (`canonical_test.go:270`, id `instrument:aed45391cb`).
3. **Why separate, and why one implementation.** Reference data is **bounded** (hundreds of
   entities — the `IDHexLen = 10` doc in `ids.go:15-18` reasons from exactly that scale) and is
   published in `reference.json`; instruments are **unbounded per-venue markets** and are
   deliberately NOT emitted into that document (`canonical.go:40-45`). Both spaces are hashed by the
   **same** function, `reference.MintIDWithSalt` (`canonical.go:36`), with **distinct salts**, so an
   instrument id cannot collide with a reference id even if a kind were misspelled, and the two
   spaces cannot drift apart the way two hash implementations would. `Build` refuses two entities
   with the same id (`ErrDuplicateID`, `document.go:211`) rather than trusting the 40-bit arithmetic.
   `[INFERENCE]` The shared-function claim is read from the import and call at `canonical.go:36,264`;
   no test asserts collision-freedom across the two salts (the salts differ, which is the argument).
**Freeze boundary — canonical layers sit BEHIND the frozen public envelopes.** List, pinned in
`canonical-placement.md` §1: the **`:3101` family envelopes** (`backend/data/cmd/data/main.go:156-188`
— five `/api/...` families plus `/healthz`), the **`:3102` reconcile body** (`{rows, wallets,
walletSummary, source}` — `backend/sync/src/reconciliation/reconcile.rs:237`), the **28-id event
catalog** (`shared/contracts/events/catalog.json`), the **36-path OpenAPI surface**
(`shared/contracts/openapi/fudcourt.yaml`), and the **15 executor route handlers**
(`frontend/web/src/app/(frontend)/api/executor/**/route.ts`). **No envelope was reshaped**: the
workstream's code delta is additive and confined to the two new packages plus two additive
`scripts/verify/verify-all.sh` lines, and its commits touch no file under `backend/data`,
`backend/sync`, `frontend/**`, `backend/workers/**` or `database/` (`canonical-placement.md` §1
`git show --stat` sweep).
**Answers to the questions the earlier audit raised.**
- **O1 — owner of canonical reference data: `backend/api`.** Rationale recorded at
  `reference.go:7-17`: `backend/data` is stateless passthrough (its own `platform/cache` doc: "a
  cache is an optimisation; it must never become a dependency"), `backend/api` holds the domain
  packages, `backend/sync` owns only the `assets` snapshot, the executor owns only `executor.*`. Since
  no Go package may be imported across services, the registry publishes a DATA artifact instead of
  exposing a type. **Rejected alternative:** an HTTP endpoint served by `backend/api` — rejected
  because `backend/api` serves no domain routes today (only `/healthz`, `/readyz`,
  `/api/auth/{login,callback,logout}`, `/api/admin/members`; `cmd/api/main.go:73-100`) and an id
  space is a static fact, so a runtime hop would make "what is asset X called" a network dependency
  (`reference.go:73-79`).
- **O3 — the mapping is curator-owned and shipped as an artifact, not first-writer-wins.** It lives
  in `…/reference/seed.go` (curated Go data, every row carrying its citation) and ships as
  `shared/contracts/data/reference.json`; a runtime resolver was rejected so two providers that
  disagree cannot silently mint two ids for one asset; adding an asset is a code change with a test,
  and the artifact's `unmapped`/`misses` lists are the honest record of what is known but unresolved.
- **O4 — instrument identity is minted, not a spelling.** `BASE/QUOTE` and
  `exchange:marketType:BASE/QUOTE` are both spellings; the canonical instrument id is the minted
  opaque id above, and the legacy `exchange:marketType:BASE/QUOTE` string is retained as the
  human-readable spelling with its meaning unchanged. No consumer is re-pointed in this change.
**Gates added, and what each can and cannot catch.**
- `shared/contracts/scripts/check-schemas.mjs` → `SCHEMAS_OK files=56 refs=344 enums=148`: parses the
  schema tree, pins `$schema`/`$id`, resolves every local `$ref` and the README index both ways.
  **Cannot** see a phantom directory named in prose — it indexes only `schemas/**/*.json` and
  README links whose target ends in `.json`, so an unbackticked tree-block line naming
  `schemas/events/` (which never existed) is outside its reach.
- The reference-artifact drift step, `go run ./backend/api/internal/markets/reference/cmd/emit -check`
  → `REFERENCE_OK 19565 bytes`: compares the emitted document against the tracked file
  **byte-exactly**, so any undocumented edit to `reference.json` fails and the regenerated bytes are
  the proof.
- `shared/contracts/scripts/check-doc-citations.mjs` (new here) → `DOCS_OK docs=8 citations=904
  allowances=6` (**point-in-time**, as observed on 2026-10-01 — the gate has since been widened to
  nine scanned documents and now reports `docs=9 citations=969`; see its header for the quoting
  policy). Re-measured 2026-10-01: `7ebcb39` rewrote 20 stale executor/script citations and the
  `7b8dc2d` re-observation added 7 more — the gate's first run, before that sweep, read
  `citations=900 allowances=45` against the 24-token list): resolves every backticked repo-path
  citation in the seven canonical architecture
  docs plus `shared/contracts/schemas/README.md` against the tree, with an explicit named-allowance
  list — now the four history-only tokens (two moved-path records, one build artifact, one
  deliberately-cited absence) — for paths that legitimately miss. **Cannot** check a line number or
  symbol, or a path that exists but is the wrong file.
All three are wired into `scripts/verify/verify-all.sh` (the schema gate and the drift step in
`33958a8`; the doc-citation gate immediately after the schema gate, a 2-line insertion that the
concurrent tooling-relocation commit `d4119ca` swept into its own diff).
**What this does not close (standing gaps, recorded not implied).** (a) There is **no SQL-side
`(provider, provider_id) → canonical_id` table** — `database/schema/*.sql` has none, so a database
consumer still resolves through a symbol. (b) **No HTTP route serves the reference document**, so
nothing outside the Go package can obtain an id at runtime; an instrument id is likewise obtainable
only in-process, from `instruments.ResolveInstrument` (`canonical.go:351`) or a future emitted
artifact. (c) **No consumer has been re-pointed** — every provider-shaped reader is unchanged.
(d) **Criterion 14 is NOT MET**: the frontend still reads provider-shaped payloads
(`features/{cryptorank,dex,llama,khala,chainrank,signals}/ui.tsx`), as recorded in
`canonical-acceptance.md` §1 row 14.
**Consequences.** The two id spaces are frozen as written: changing any component, separator, salt or
the truncation re-mints every id in that space and is a breaking change that MUST be a new version,
not an edit (the golden-vector tests exist to make that impossible to do silently). Any future
"canonical ids in the database" work is a migration plus a loader for `reference.json`, not a second
minter. A consumer that needs an id must read the artifact or call the package — never parse an id
back into a symbol, which is the property the opaque form was chosen for.
## DR-035 — The `/api/executor/*` surface is served by the executor process itself, not by `backend/api` (2026-10-01)
**Status:** accepted and landed (`7b8dc2d`). Additive: the Go surface is proven offline. The web-tier
re-point is now **coded but not switched on** (see **Consequences**): the thin proxy and its gate
exist and the TS handlers remain the production path until an operator flips the gate.
**Context.** The executor cutover had a missing half: the engine, worker and `executor.*` persistence were ported (`parity-matrix.md` rows 1-9), but the fifteen `/api/executor/*` contract routes existed **only** as TS handlers under `frontend/web/src/app/(frontend)/api/executor/**`, so nothing on the Go side could answer them and the TS runtime could not be deleted. A decision was owed on *which* Go process owns that HTTP surface. The dependency rules settle the wrong answers: services MUST NOT import each other's internals (`target.md` §3.2), so `backend/api` cannot import the executor's planner/risk/sizing, its sealed credential vault or its `executor.*` store - yet those are exactly what the surface needs.
**Decision.** The executor **serves its own surface**. `backend/workers/executor/internal/api/**` implements all **15** contract paths (accounts GET/POST, `accounts/{id}` GET/DELETE, `accounts/{id}/test` POST, settings GET/PUT, executions GET/POST, `executions/{id}` GET + `/orders` + `/fills` + `/events` + `{start,pause,resume,cancel}`, preview POST, emergency POST), and `cmd/executor` mounts them on a **separate loopback listener**, `FUDCOURT_EXECUTOR_API_ADDR` (default `127.0.0.1:3105`), distinct from the `127.0.0.1:3104` `/healthz`+`/readyz` operational surface so a request burst can never starve the readiness probe (or the reverse). Both stay loopback-only (DR-002); the web tier is the only client. Envelope fidelity is pinned to the TS handlers the surface shadows - same status codes and same `{error, detail}` / `{error, errors[]}` / `{error, detail, category}` bodies (401/404/400/405-with-`Allow`/409/403-kill-switch/502-categorized), wrong-owner-404, preview writes nothing, secrets never returned, `FUDCOURT_EXECUTOR_LIVE=1` gating live creation. Evidence: `cmd/executor/api.go` (package doc states the reasoning and the rejected alternatives), `internal/api/server.go` (the mux), `internal/api/{routes,harness}_test.go` (**29** hermetic tests - memory store + in-repo paper venue + pinned clock; no Postgres, Valkey, credentials or network), and the versioned unit `infrastructure/systemd/fudcourt-executor.service` (pins `:3105`).
**Rejected alternatives** (recorded in `cmd/executor/api.go`'s package doc): **(a)** a new shared Go pure-math/contracts module - genuinely clean, but it needs a new `go.mod` + `go.work` entry and moves the canonical planner/risk packages, a repo-wide decision with its own rollout (adopting it later is a pure relocation: `internal/api`'s handlers keep their contracts and only their imports change); **(b)** the executor exposing a surface with `backend/api` proxying to it - adds a pass-through hop while all the logic still lives here. The chosen shape needs **no** new module, service or proxy, keeps **one** canonical planner, and is testable offline.
**Consequences (accepted, plainly).** The runtime path becomes **`web -> executor`** via a thin web-tier proxy, not the earlier `web -> api -> executor` sketch. **The highest-risk consequence is the session-secret coupling:** the executor now *verifies* the same signed `fud_session` cookie the web tier *issues*, so `FUDCOURT_SESSION_SECRET` must be present in **both** processes and **byte-identical** (one definition, `frontend/web/.env.local`, read by both). If the two ever diverge, **every `/api/executor/*` route answers 401 while `/healthz` still reports ready** - a silent authentication failure behind a green readiness light, so the unit documents "rotate in that one file and restart both units together; never hand-set it here." The listener MUST stay loopback-only (a non-loopback bind would expose the surface without the web tier's tier gate). The wire structs in `internal/api` are **hand-ordered, not maps**, because JSON key order is part of the byte-shape compatibility the web tier depends on (`encoding/json` sorts map keys alphabetically); the field order is the TS literal order and the tests pin it. To finish the cutover: **(a) coded 2026-10-02, not switched on** — all 15 web `/api/executor/*` handlers thin-proxy to `127.0.0.1:3105` through one shared helper (`frontend/web/src/platform/executor/executor-proxy.ts`) when `FUDCOURT_EXECUTOR_PROXY=go`; the gate is OFF by default, so the TS handlers are still the live path until an operator sets it, (b) provision `FUDCOURT_SESSION_SECRET` + `FUDCOURT_EXECUTOR_PG_URL` (the unit's env is fail-visible - it cannot start without them), then (c) provision `FUDCOURT_EXECUTOR_MASTER_KEY` and run `verify:executor` against the **Go** worker. The TS deletion is still OPEN; nothing above claims it done.
## DR-036 — O2 answered from the stores (five of six tables are dead); the canonical mapping gains a SQL half, unwired (2026-10-02)
**Status:** accepted and landed. Additive and **unwired**: the loader and its DDL are proven offline and against a scratch database, and **nothing calls them** — no consumer, route, timer or service is re-pointed (see **What this still does not do**).
**Context.** DR-034 left two P0s parked on the same open question, O2 in `canonical-model.md` §9.2: *are `accounts`, `journal`, `ledger`, `trades`, `venues`, `price_history` live tables with an out-of-band writer, or dead ones?* The docs recorded that this "cannot be answered from the tree" — and it cannot be, because the answer is in the stores, not the tree. This record answers it by querying them read-only, then lands the second P0's minimal durable step on the strength of that answer.
**O2 verdict, per table (read-only; 2026-10-02, both stores).** Live store = Turso (`libsql://fud-balance-anvxxr.aws-ap-northeast-1.turso.io`, the DR-019 system of record; `backend/sync/src/persistence/db.rs` `TURL`). Read model = local Postgres+Timescale (`127.0.0.1:5433`, `frontend/web/src/platform/db/mirror.ts` `FUDCOURT_PG_URL`). Two snapshots ~4 min apart, both stores; the two live syncs in that window are `fudcourt-sync.service` (5 min) and `fudcourt-pgload.timer` (60 s), both enabled and active. Table | exists | rows (Turso/PG) | max timestamp | advanced? | verdict:
| table | exists | rows | max timestamp | advanced? | verdict |
|---|---|---|---|---|---|
| `assets` (control) | yes | 16 / 16 | `updated_at` `2026-10-02 00:29:44` | **yes** (00:24:37 → 00:29:44, one sync tick) | **LIVE** |
| `transactions` (control) | yes | 48 / 48 | `created_at` `2026-09-28 07:09:46` | no in-window (reached after the 2026-09-15 import) | **live, low-rate** |
| `wallets` (control) | yes | 3 / 3 | `created_at` `2026-09-15 20:26:05` | n/a (no `updated_at`; `UPDATE` is the writer) | **live (read/update)** |
| `accounts` | yes | 6 / 6 | no date column | n/a | **dead (seeded, frozen)** |
| `journal` | yes | 8 / 8 | `created_at` `2026-09-15 23:48:35` | no | **dead (frozen)** |
| `ledger` | yes | 3 / 3 | no date column | n/a | **dead (frozen)** |
| `trades` | yes | **0** / 0 | — | n/a | **dead (empty)** |
| `venues` | yes | 12 / 12 | no date column | n/a | **table dead (seeded, frozen); the venue ENTITY is LIVE** — see below |
| `price_history` | **NO** in Turso | — / **0** PG | — | n/a | **dead (never written; no producer exists)** |
**Entity vs table — "dead" is a verdict on the TABLE, not on the noun.** Every one of the six is an active (or reserved) domain concept in code even where nothing writes a row, so a later cleanup must not retire the concept along with its unwritten table:
- `venues` — **the TABLE is dead (no write since the 2026-09-15 import) while the venue ENTITY is LIVE.** The 12 seeded rows mirror the 12 `venue_id`s that `shared/contracts/data/reference.json` mints; the venue slug space is validated in code (`backend/api/internal/accounts/exchange/account.go:122` `KnownExchange` — `binance|bybit|mexc`) and resolved by the executor's venue boundary (`backend/workers/executor/internal/exchanges/`, one adapter per venue, `ErrUnknownVenue` at `symbols.go:42,74`). Venue identity is used and resolvable *without the table*; only the table is unwritten.
- `accounts` — **the TABLE is dead; Account is a live entity**: `backend/api/internal/accounts/{exchange,wallets}` (venue-account model + wallet registry) and `executor.exchange_accounts` (the canonical CEX account).
- `ledger` — **the TABLE is dead; LedgerEntry is a live entity**: `backend/api/internal/finance/ledger` (`ledger.Entry`, `NewEntry`, immutable money movements) — the table stores only a running balance and is not that model.
- `trades` — **the TABLE is dead; the trade/fill entity is live**: `backend/workers/executor/internal/core/execution/records.go` (`Fill`/`FillRecord`, `ExchangeTradeID`), persisted in `executor.fills`.
- `journal` — **the TABLE is dead and, alone among the six, the noun has no code-side entity** beyond the mirror's pass-through column (`frontend/web/src/platform/db/client.ts:64-67`); it is table-only.
- `price_history` — **the TABLE is dead** (absent from Turso, empty in PG); the price series has a code-side analogue (`overview.MarkPrice`/`IndexPrice`, `backend/api/internal/markets/overview/market.go:84,93`) but no store.
The six table verdicts stand unchanged; the clause exists so the *retirement* target is unambiguous (Phase 6 retires tables, not venue/account/ledger/fill identity).
**Evidence for the dead verdicts, and the writer search (all negative).** (1) `grep -rniI --exclude-dir=node_modules --exclude-dir=target --exclude-dir=.next --exclude-dir=.shaper-tests -E "(INSERT[^;]{0,30}(INTO|OR REPLACE INTO)|REPLACE INTO)[[:space:]]+(accounts|assets|journal|ledger|trades|transactions|venues|wallets|price_history)\b" .` (run it with source globs — e.g. add `--include='*.go' --include='*.rs' --include='*.ts' --include='*.py'`; over the bare whole tree the prose recording this search self-matches) → the only treasury writers are `assets` (`backend/sync/src/persistence/db.rs:133`, `tests/oracle/sync-live.py:345`), `transactions` (`frontend/web/src/app/(frontend)/api/transactions/route.ts:78,116`), `wallets` (`…/api/wallets/route.ts`); **nothing** inserts `accounts`, `journal`, `ledger`, `trades` or `venues`. (2) Git history holds no such writer either: `git log --oneline --all -S'INSERT INTO journal'` (and `… ledger`, `… trades`, `… venues`, `… price_history`) → **empty**; the one `INSERT INTO accounts` hit is DR-034's own docs commit `2904749`. (3) Out-of-band writers, searched and absent: `crontab -l` (root, `dwizzy`, sudo) → only `fudrouter`/`zura` backups; `/etc/cron.d`, `/var/spool/cron/crontabs` → nothing touching these tables; `systemctl --user list-timers --all` → `fudcourt-sync` (5 min, writes `assets` only), `fudcourt-pgload` (60 s, mirror), no other `fudcourt-*` entry; `systemctl list-timers --all` (system) → nothing fudcourt; `infrastructure/systemd/*` `OnUnitActiveSec` → 60 s / 5 min / 5 min only, no `OnCalendar=`. The operator-side tree `~/.hermes/**` mentions `wallets`/`accounts` only in a *probe* (`~/.hermes/skills/fudcourt-development/references/local-infra.md`, `…/cache/scratch/fud_sentinel.sh` — both read/`UPDATE wallets`, no inserts) and its `cron`-named session dumps are retrospectives of the repo's own `sync-live.py`, not a live writer. (4) `price_history`'s DDL comment says "Written by the price sampler"; `grep -rniI "INSERT INTO price_history"` over the source tree (source, tests, scripts) → **0 hits** (a bare whole-tree grep is non-zero because this prose self-matches), and the table is absent from Turso entirely — the DDL comment is aspirational, and the 90-day retention `DELETE` in `mirror.ts` runs against a table nothing fills. **(5) Liveness criterion (stated once, so a re-run meets the same bar).** A single snapshot of row counts and `max(ts)` cannot distinguish "live" from "stale data left behind", so **no table was judged dead on one snapshot alone**: each verdict required either (a) `max(ts)` observed to ADVANCE between two spaced reads, or (b) positive proof of a writer mechanism (a found cron entry, systemd unit/timer, or script). The writer search (1)–(3) returned **nothing** for the six — that is limb (b) failing — and the three controls all advanced inside the window (`assets` on the 5-min sync tick, `transactions` after the import, `wallets` read/updated), which is what makes the six null results interpretable rather than an artefact of a broken probe. A future re-run MUST meet the same bar (an advancing `max(ts)`, or a found writer); a table that meets neither is **indeterminate**, not dead, and must be recorded as such.
**What the O2 answer changes and what it does not.** The three controls behave as documented (`assets` advanced inside the window; `transactions` reached 2026-09-28 after the import, i.e. it *is* writer-fed, just rarely) — so the null result on the six is interpretable rather than an artefact of a broken probe. The six are **dead**: seeded once at import (2026-09-15) or never written. **No out-of-band writer exists**, so **no live consumer owns any of them, and this workstream changes none of them** — the DR-020/DR-034 "additive only, no columns on money-bearing rows" constraint is therefore not merely policy but fact-grounded. **A consequence worth recording (not acting on): the mirror projects the dead set on a timer.** `frontend/web/src/platform/db/mirror.ts` (`TABLES`, copied by `loadFromMirror` and driven by `fudcourt-pgload.timer` every 60 s) still carries all six — `accounts`, `journal`, `ledger`, `trades`, `venues`, and `price_history`'s retention `DELETE` — so a timer upserts/prunes tables that never change at the source; it is harmless work, but it is work a retire-or-adopt decision would remove. **Retire-or-adopt is a PENDING product decision, not one this record takes:** a table with no in-repo writer can still be the operator's bookkeeping-of-record, so the six are *answered* (dead, with the store evidence above), the recommendation is to retire or explicitly adopt each, and the call belongs to the operator at Phase 6 — out of scope here, and no schema change was made this round.
**Decision (the second P0, minimal durable step).** A SQL side for `(provider, provider_id) → canonical_id` now **exists**: `database/schema/pg-schema.sql` gains two additive `CREATE TABLE IF NOT EXISTS` tables, `canonical_reference` (PK `(provider, provider_id)`, plus `canonical_id`, `kind`, `loaded_at`, and a row-level `CONSTRAINT canonical_reference_kind_prefix CHECK (canonical_id LIKE kind || ':%')` that makes the kind/id-prefix agreement a write-time refusal) and `canonical_reference_miss` (the artifact's `misses`), with indexes on `canonical_id` and `kind`. **The CHECK is applied at first creation only if it were inline** — `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table — so the constraint is NAMED and a guarded `DO $$ … $$` block re-adds it by name when absent: a re-applied schema therefore still refuses a mismatched `kind`, and the block is a no-op once the constraint exists (adding to an already-created table otherwise needs an explicit guarded `ALTER TABLE … ADD CONSTRAINT`, which is exactly what the block performs). **Proven against a scratch database:** create → drop the constraint → re-apply re-adds it; a second re-apply does not error and does not create a duplicate; the refusal still fires (`ERROR: new row for relation "canonical_reference" violates check constraint "canonical_reference_kind_prefix"`); and the OLD inline-only form was shown to leave the table with no constraint at all after a re-apply (exit 0, silent). Every column has a source in the artifact (no column is invented) and none stores money. They are loaded by `backend/api/internal/markets/reference/loader.go` — `LoadReferenceRows`/`ParseReferenceRows` read `shared/contracts/data/reference.json` and **never re-derive an id** (they validate `document_version`, the artifact's own kinds, namespaces, duplicate keys and mapped-vs-missed disjointness, then carry its rows verbatim; a missing/empty/malformed file or a document_version this loader was not written for is a loud refusal), and `RenderSQL` emits one idempotent, self-pruning load statement (`INSERT … ON CONFLICT (provider, provider_id) DO UPDATE` + `DELETE … WHERE NOT EXISTS`). The loader's accepted namespaces are **derived from the registry's `EntityKinds`**, not restated, so the loader and the minter cannot drift. The loader is stdlib-only because `backend/api` has no SQL driver — applying the statement is `psql`/`bun`, so nothing in this module gains a dependency.
**Proof.** Offline (`loader_test.go`): the rendered rows are pinned against the checked-in artifact (49 mappings, 3 misses), the render is deterministic, its upsert+prune shape and single-statement form are asserted, the refusals are exercised (missing/empty/junk JSON, wrong or absent `document_version`, unknown namespace, empty provider_id, duplicate key, mapped-and-missed), quote escaping is checked, and `mappingKinds` is asserted equal to the registry's `EntityKinds`. Against a scratch database (`createdb` on `:5433`, dropped afterwards — **the `fudcourt` database was never written to**): the DDL applies; a valid row inserts; a row whose `canonical_id` prefix disagrees with `kind` is **REFUSED** by the check constraint (`ERROR: new row for relation "canonical_reference" violates check constraint "canonical_reference_check"` at the time of that run — the constraint was anonymous then and is now named `canonical_reference_kind_prefix`, so a re-run reports that name — with the failing row in the DETAIL, observed on PostgreSQL 17.11), as is an id with no prefix; load #1 → `mappings_upserted=49 misses_upserted=3` (all 49 artifact rows pass the CHECK); re-running the DDL is a no-op (`NOTICE … already exists, skipping`); a hand-inserted bogus key `('bogus','ghost')` is **pruned** by the next load (`mappings_pruned=1`) and the count returns to 49. So the table is a mirror of the artifact, not an accumulator, and it refuses a namespace-confused row rather than storing one.
**Relationship to earlier records.** DR-020 ("no migration runner"): this adds DDL to the hand-written `pg-schema.sql` and **does not create `database/migrations/`** — a migrations directory is still not required, because both the DDL (`IF NOT EXISTS` plus the guarded `DO` block that re-adds the named `CHECK`) and the load statement are idempotent; creating one would be a separate decision, not taken here. DR-034: this closes its standing gap (a) — "no SQL-side `(provider, provider_id) → canonical_id` table" — and follows its closing instruction that such work is "a migration plus a loader for `reference.json`, not a second minter": the loader mints nothing. DR-019: the new tables live in the Postgres read model because the artifact is a generated file, and Turso (the system of record) has no analogue — consistent with `assets`/`transactions` also having no Turso identity table. One gate change rides along: `shared/contracts/scripts/check-doc-citations.mjs` scanned a hard-coded set of **8** documents, so `docs/architecture/symbol-key-inventory.md` (tracked in `fd49b3a`; 79 cited paths) escaped citation checking entirely — a new doc silently accumulated unchecked paths, which is how stale paths spread. It is now added to that set (`DOCS_OK docs=9 citations=969 allowances=6`), so every one of its cited paths resolves; its content is another worker's and its analysis was not rewritten.
**What this still does not do (explicit).** No consumer is re-pointed — every provider-shaped reader is unchanged and still resolves through the symbol. No runtime wiring: nothing calls the loader (no route, no `cmd`, no timer, no service), and there is no DSN-gated integration test in `backend/api`, because that module has no Postgres driver to open one with. **No columns were added to any existing table** and no existing table was altered; the change is two new tables only. The artifact remains the single source of truth — a database row is a derived cache and is re-derived by re-running the loader. Criterion 14 remains unmet (unchanged from DR-034). Phase 9's remaining blockers are now: serving the artifact (or a route) to a runtime consumer, and actually re-pointing one.
## DR-037 — The design values are one token module, two generated artifacts and two gates (2026-10-02)
**Status:** accepted and **landed end-to-end** — the token source, the emitter, the two gates, the wiring and the migration that re-pointed every consumer. It was deliberately RED (`DESIGN_FAIL`) until the migration sessions landed; it is GREEN now (`DESIGN_TOKENS_OK (files=150 exemptions=6)`), with `C` and the drifted HSL `:root` deleted (see the closing state at the end of this record).
**Context.** There was no design system. The same design values lived in three places that could drift, and had: (a) `frontend/web/src/styles/shared.ts` exported `C`, a flat hex table; (b) `frontend/web/src/app/(frontend)/globals.css` declared a SEPARATE HSL `:root` set — measured, all seven comparable pairs had drifted (`--background: hsl(160 38% 5%)` = `#08120e` against `C.bg` `#07110f`; `--primary: hsl(153 74% 61%)` = `#52e5a3` against `C.accent` `#3ddc97`; likewise foreground/card/border/destructive/muted), and the `body` rule used those HSL intents, so the page background and every `C`-styled panel were already two different colours; (c) `tailwind.config.js` had `theme: { extend: {} }`, so no utility class could reach a token even if one had existed. Feature UIs additionally hand-rolled raw hex (`#ffd166`, `#ff9f43`, `#04140f`, rgba overlays), magic font sizes, paddings and radii — the migration gate counted 1280 such sites at landing, and shrinking that list is the migration's job. There was no artifact to keep the three sources in step and no gate that could notice when they were not.
**Decision.** One source of truth plus generated artifacts plus gates:
1. **`frontend/web/src/styles/tokens.ts` is the SSOT.** A leaf module (no imports, no JSX, `as const`) exporting `color`, `space`, `radius`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`, `zIndex`, `fontFamily`. Every value in it already has a real consumer in the tree and every px-keyed scale is keyed by its own value (`space[12] === 12`, `fontSize[13] === 13`), so the migration off `C`/HSL/raw literals is value-for-value and provably zero-visual-change. The governing rule, stated in the module and enforced by the gate's dead-token alarm: **no invented tokens** — a token without a consumer is drift in the other direction.
2. **`frontend/web/scripts/design/emit-tokens.ts` generates two artifacts** (`bun scripts/design/emit-tokens.ts [--check]`): the `:root` custom-property block between the sentinel lines `/* @generated design-tokens:start — bun scripts/design/emit-tokens.ts */` … `/* @generated design-tokens:end */` inside `globals.css` (text outside the sentinels is never touched), and `tailwind.tokens.json`. Var scheme: `--fc-color-<name>`, `--fc-space-<n>`, `--fc-radius-<key>`, `--fc-font-size-<n>`, `--fc-font-weight-<name>`, `--fc-line-height-<name>`, `--fc-letter-spacing-<name>`, `--fc-z-index-<name>`, `--fc-font-mono`, `--fc-font-sans`; px values render as `Npx`, unitless values (weights, line heights, letter spacings, z-index) verbatim, and string-valued entries (`radius.circle` = `'50%'`) as written. (`alpha()` is a function, not a scale, and is not emitted as a custom property.) The emitter is deterministic (declaration order, no timestamps) and `--check` re-renders and compares byte-for-byte, printing `TOKENS_OK` or `TOKENS_DRIFT` plus a diff and exiting 1.
3. **`globals.css` names the C-backed tokens.** `body` now uses `var(--fc-color-bg)`, `var(--fc-color-text)`, `var(--fc-font-sans)`. The seven HSL intents are GONE: they were the drifted half, and the token values are the `C` values (the real rendered colour), so the drift is resolved by construction rather than by re-tinting.
4. **`tailwind.config.js` reads the generated JSON into `theme.extend`** through an ABSOLUTE `__dirname`-anchored `fs.readFileSync` + `JSON.parse` — zero raw values in the config, and a utility class and the inline-style layer can no longer disagree. The bare `require('./tailwind.tokens.json')` is BANNED with the reason in a two-line comment: Tailwind loads configs through its own loader (and Next/Turbopack re-bundles them), so a relative specifier resolves against the loader's base rather than this file's directory and can throw `MODULE_NOT_FOUND` during `next build`. `bun run build` is the proof it does not: it exits 0 and the emitted CSS (`frontend/web/.next/static/chunks/*.css`) contains the `:root` block verbatim (`--fc-color-accent:#3ddc97`) plus the utilities that consume it (`background-color:var(--fc-color-surface)`, `font-family:var(--fc-font-sans)`, `border-radius:var(--fc-radius-14)`).
5. **Two gates.** `scripts/checks/check-design-tokens.py` is the MIGRATION gate (offline, stdlib-only), scoped to `src/**/*.{ts,tsx,css,scss}`. HARD: raw colour literals — exactly two forms are permitted, the CSS keywords `transparent`/`currentColor`/`inherit` and an `rgb()/rgba()` over a token colour's exact RGB triple (`61,220,151` accent/positive, `255,107,107` negative, `28,58,49` border, `107,143,130` textMuted, `255,255,255` textInverse) at ANY alpha, so token-derived tints stay expressible and `rgba(0,0,0,0.8)` (the `color.overlay` value) is not; numeric literals in `fontSize`/`borderRadius`/`lineHeight`/`letterSpacing`/`zIndex`/`fontWeight` and string literals in `fontFamily`/`font` other than `'inherit'` (literal `0` allowed, `'50%'` must be `radius.circle`); the dead-token alarm, with `0`-valued scale entries exempt as anchors; and raw hex/`rgb(`/`hsl(` in CSS outside the generated block. SOFT, never failing: numeric/string literals in `padding*`/`margin*`/`gap*`/`position`/`width|height` — a layout system over 46 distinct padding values is a visual redesign, not a rename, so it is counted and printed (`DESIGN_SOFT: total=…`) to keep the debt visible. It prints one machine-readable line, `DESIGN_FAIL: files=… colors=… scales=… deadtokens=…`, and reaches `DESIGN_TOKENS_OK (files=150 exemptions=6)` once the migration lands. Two defects in the gate itself were found by the migration and fixed with a failure proof: the named-colour check matched any `[A-Za-z]+` value after `fill`/`stroke`/`color`/`background` (so the executor's child-order lifecycle table `TRANSITIONS` — `fill: 'FILLED'`, an event/status pair — read as a colour) and is now a WHITELIST of CSS Colour Level 4 names; and the css/scss rule ignored the directory exemptions, leaving `src/app/blog/(payload)/custom.scss` falsely red, so both rules now consult one `color_exempt()`. `bun scripts/design/emit-tokens.ts --check` is the ARTIFACT-DRIFT gate. Both are wired into `scripts/verify/verify-all.sh` immediately after the DR-018 structure gate, and into `.github/workflows/web.yml` beside its structure-gate step. `bun run tokens` / `bun run check:design` are the package entry points.
6. **The allowlist (raw colours only) is the observed minimum**, justified per entry in the gate: `src/styles/tokens.ts` (the SSOT itself), `src/styles/shared.ts` (it keeps the DOMAIN palettes `CHAIN_COLOR` and `COLOR_PRESETS` — brand/provider colours and the user's wallet swatches; data the user picks at runtime, not chrome), the NEW `src/features/*/palette.ts` convention (a family that genuinely owns a provider/brand palette keeps it in a sibling file named for what it is, instead of inlining it into `ui.tsx`), `src/cms/**` (the Payload CMS surface; only `seed.ts` carries literals today — its inline SVG placeholder is media, not chrome), and `src/app/blog/(payload)/**` (the Payload admin/login surface and its own stylesheets). NOT exempted: `src/app/blog/page.tsx` and `src/app/blog/[slug]/page.tsx`, which are product chrome. Glob entries are matched with `fnmatch`, never by dict membership — a literal lookup would exempt only a file named `*` and leave the convention inert, and a glob that matches NOTHING is itself a failure line, so the entry cannot go inert the same way again. The gate fails if an exempted path — or the `palette.ts` convention, when nothing matches it — disappears, so the list cannot rot.
7. **Token set v2, from the audit.** `radius += {4, 10, circle:'50%'}`, `fontSize += {9, 24, 32}`, `fontWeight = {regular, medium, semibold, bold, heavy}`, `lineHeight = {tight, snug, relaxed, normal, loose}`, `letterSpacing = {none, xs:0.4, sm:0.5, wide, wider}`. Nothing v1 was renamed and `fontWeight.bold === 700` still holds. Every added key is one the audit found already in use (`design-inventory.md` §A.2 histograms), so the no-invented-tokens rule survives the extension.
8. **A normalization table is the ONLY permitted value change.** `fontSize` 11.5/12.5/15/34 → `12/13/16/32`; `borderRadius` 2/3/999→`4/4/full` and `'50%'`→`circle`; the four extra greens (`#4ade80`,`#3fb950`,`#22c55e`,`#06d6a0`)→`color.positive`; `#f87171`→`negative`; `#fbbf24`→`warn`; `#06281c`/`#06120e`/`#07110f`-as-text →`textOnAccent`; `#fff`→`textInverse`; `rgba(255,80,80,a)`→`rgba(255,107,107,a)`; blog greys `#666`/`#888`/`#999`→`textMuted` and `#222`→`border`; the two font-family strings→`fontFamily.mono`/`.sans`. Each is a one-line pixel change the migration commit must name; any value change NOT in the table is a bug, not alignment.
**Evidence.** `bunx tsc --noEmit` clean; `bun run build` exits 0 and the emitted CSS under `frontend/web/.next/static/chunks/*.css` carries `--fc-color-accent:#3ddc97` (the Tailwind-load proof for item 4); `python3 scripts/checks/check-structure.py` → `STRUCTURE_OK (142 files across (src root)(1), app(73), cms(9), components(2), features(34), platform(22), styles(2))` — `styles/` is still a leaf layer and the two-file count is `shared.ts` + `tokens.ts`; `bun scripts/design/emit-tokens.ts --check` → `TOKENS_OK (13 colors, 15 space, 12 font-size, 67 vars total)`; emission run twice is byte-identical (`md5 3fba01e8eaa7c4d7035b931ff5ac9e79` for `globals.css`, `md5 5a794ff17e77e765796cd79a39d916f9` for `tailwind.tokens.json`, both runs); the FAILURE PROOF — editing one token value and re-running `--check` prints `TOKENS_DRIFT` with a unified diff and exits 1; the migration gate currently reports `DESIGN_FAIL: files=152 colors=18 scales=109 deadtokens=6` with `DESIGN_SOFT: total=711 padding=307 margin=224 gap=69 position=0 size=111`, which is the expected pre-migration state and the migration's remaining work; `node shared/contracts/scripts/check-doc-citations.mjs` → `DOCS_OK docs=10 citations=984 allowances=4`.
**Relationship to earlier records.** DR-020 ("no migration runner", reaffirmed by DR-036): this adds NO runner and no DDL. The generated-artifact pattern is the one DR-034 established for `shared/contracts/data/reference.json` — a checked-in artifact whose bytes are the proof, regenerated by a deterministic emitter and guarded by a `-check` drift gate — applied to CSS/JSON instead of a JSON document. DR-018: `styles/` remains a leaf layer that may import only itself (`tokens.ts` imports nothing), and no file is added at the `src` root.
**Consequences.** The three drifting sources can no longer drift silently: any hand-edit to either generated artifact, or an edit to `tokens.ts` that was not re-emitted, fails `--check`; any new raw literal or magic style value fails the migration gate. The dead-token alarm makes token ADDITION a two-part change (value plus consumer) and will fail any future token no one uses. The `C` export in `shared.ts` is deliberately retained: the migration workers still consume it and a later cutover step deletes it together with the (now deleted) HSL intents; `tokens.ts` does not re-export it. A tint is `alpha(color.x, a)` from the SSOT (a pure string function: `#rrggbb` + alpha, throws on anything else, clamps to [0,1]), so the palette can stay flat hex and the eight hand-spelled `rgba()` tints the audit found have one spelling instead of eight. Also stated plainly (and recorded in the gate's header, not implied): the migration gate cannot catch a token whose VALUE is wrong, and it cannot see a token consumed ONLY through a Tailwind utility class (`p-12`, `bg-accent`) — those names are derived from the generated JSON and leave no source mention, so such a token would read as dead; if that becomes the house style the gate must learn the utility names rather than have the alarm silenced.
**Closing state (the migration landed, same day).** The adoption pass completed: `C` in `shared.ts` and the drifted HSL `:root` intents are **deleted** — not aliased, not re-exported, and the emitter's pre-migration value check was removed with its sources rather than left as a check that can no longer fail (`frontend/web/scripts/design/prove-value-for-value.ts` keeps the one-off, frozen-snapshot proof). Every consumer is re-pointed at a token, `shared.ts` stays the home of the domain palettes and the shared view types/helpers, and the gate reports `DESIGN_TOKENS_OK (files=150 exemptions=6)` with zero offender lines and zero dead tokens; `VERIFY_ALL_OK` on the full harness. **The normalization table below is the ONLY value change the migration was permitted to make** — each row a one-line pixel change stated in its own commit; any other value change is a bug, not alignment. One component decision rides along: there is **no page-chrome atom** — the three page shells (member, admin, login) each needed something a shared shell could not express value-for-value, so they are tokenized in place and the attempted shell was deleted rather than kept as indirection.
**What this does not do (explicit).** It migrates nothing: `src/features/**`, `src/components/**`, `src/cms/**` and `src/app/**` still hand-roll literals, and the whole point of publishing the gate red is to make that list shrink. It changes no rendered pixel, adds no dependency (the emitter is Bun/TS stdlib, the gate is Python stdlib), and touches no runtime path. It does not create a second convention: `C` and the domain palettes stay where they are until their owners cut over.

## DR-038 — CoinAnk is keyless by a COMPUTED request signature, and upstream's `success:true` can still be a fabricated zero (2026-10-02)
**Status:** accepted and **landed end-to-end** — the `coinank` package, the sidecar wiring, the hermetic tests, the live verifier and the docs. No API key exists on the path and none was requested; the whole family is a reverse-engineering result.
**Context.** CoinAnk ships two surfaces. `open-api.coinank.com` is the documented product and is gated by a human-issued VIP key (VIP1–VIP4, catalogued in `docs/architecture/coinank-data-types.md`). `api.coinank.com` is the backend the coinank.com dashboard itself calls, and it has **no key** — its gate is a request header the dashboard's own Nuxt bundle computes in the browser. So "buy a key" was never an alternative path to the same data: it is a different product with different coverage, and the second surface is the one that can be reached without procurement. Two things had to be established before a single row could be trusted: what the signature actually is, and what upstream does when it does not like a request. Both were answered by reading the public bundle and then probing live, never by assuming.
**Decision.**
1. **The signature is reconstructed in code, from the public bundle, and pinned by vectors produced outside the implementation.** `coinank-apikey = base64( uuid[8:] + uuid[:8] + "|" + str(Date.now() + C) + "347" )`, where `uuid` is the bundle's client UUID (its first 8 characters are rotated to the tail), `C` is the bundle's fixed clock offset and `347` is a literal. These are protocol constants that ship to every browser, not credentials — DR-033's rule applies: they live in **code** (`sign.go`), never in prose docs, and the docs state only that they are re-derivable from the public bundle. `sign_test.go` pins the derivation against vectors computed independently of the Go code, because a self-consistent test of a wrong formula proves nothing.
2. **An upstream refusal is a 502, never an empty 200.** A wrong or absent signature does not produce a 401: `api.coinank.com` answers **HTTP 200 `{"success":false,"code":"500","msg":"system error!"}`**. Any implementation that only checks the HTTP status renders that as a confident empty table — the exact failure the frozen-envelope contract forbids. `fetch.go` therefore returns a typed `HardError` carrying upstream's own `code` and `msg`, and the handler maps it to **502 with that message**.
3. **The interval allowlist is a refusal of a real trap, not pedantry.** `interval` accepts exactly `1h, 2h, 4h, 6h, 12h, 1d`. Measured live, `8h` (and `24h`, `7d`, `30d`) are answered by upstream with **`success:true` and an all-zero table** (`totalTurnover: 0`). A pass-through route would render a fabricated zero as data; the allowlist is what makes that impossible. Out-of-allowlist values are refused **locally** with `400 invalid param`, and the body names both the accepted set and the reason (the reason is generated from the same `Intervals` slice the validator uses, so it cannot drift from the code). The five accepted intervals were each confirmed to carry real turnover.
4. **Params upstream silently ignores are 400 `unexpected param`.** `symbol`/`baseCoin` on `fundingRate` and `pageNum`/`pageSize` on `whales` do nothing upstream. Accepting them would be a lie about what the caller asked for, so they are refused, alongside genuinely unknown params and params scoped to another mode (`interval` on `etf`).
5. **`upstreamCount` is present only when it is a measurement.** For an array payload it is the row count and is asserted equal to `len(data)`. For the object payload (`whales`) the key is **ABSENT** — a `0` there would assert a count upstream never published. `data` is upstream's payload **verbatim**; the family invents no second vocabulary for data it did not author.
6. **Cache is transport state, header-only.** `X-CA-Cache` (`json:"-"`), `X-CA-Upstream`, `Cache-Control: public, max-age=30` — the same shape as the CoinGlass sibling, so a body `cache` key cannot appear as a second, disagreeing spelling. The disk cache stores the **raw upstream body**, so a warm hit and a cold hit return identical bytes.
7. **The verifier is an ORACLE, not a mirror.** `scripts/verify/verify-coinank.py` re-derives the signature **in Python** and fetches all five upstreams **itself**, then compares the adapter's counts against that direct fetch (within a tolerance band, since a live market moves between the two calls). An adapter-only verifier would confirm the adapter's arithmetic with the adapter's arithmetic.
**Evidence.** `go build ./backend/data/... && go vet && go test` green: hermetic signature vectors, a fake `Doer` for the fetch path (no network), the allowlist and the full param matrix, and an env-gated live test. `python3 scripts/verify/verify-coinank.py` → **114 pass / 0 fail / 0 skip** against the live sidecar, including the five direct-oracle fetches (fundingRate 881 / liquidation 10 / longShort 716 / etf 704 / whales object 50 rows), the independent-signature acceptance probe, the `1h`-is-real vs `8h`-is-all-zero pair, the six-interval matrix, the ten-case 400 matrix, the 405 method guard, and `healthz` → `coinank: 5 modes (keyless, client signature)`. `python3 scripts/verify/check-contract.py` → `CONTRACT_OK` unchanged (the family has no web proxy route, so the TS/Go parity gate is unaffected). Live `mode=etf` → 200 with **704 rows**, `X-CA-Cache: HIT` on the warm call.
**Relationship to earlier records.** DR-033 (one name per service; no live credential in a tracked file): the protocol constants are client-shipped and kept in code, and no credential is introduced at all. The CoinGlass family (the sibling research family) established the envelope shape this one follows — provenance-first, verbatim `data`, header-only cache, upstream refusal as 502 — so the two keyless families now read the same way and differ only in their mechanism (CoinGlass **decrypts** a body; CoinAnk **computes** a header). The oracle-first verifier follows the standing rule that a claim is read from the source, never from the adapter's own response.
**Consequences.** A caller can no longer be handed a zero it should not trust: the all-zero interval is unreachable through the route, and an upstream refusal surfaces as a 502 carrying upstream's message. The family is sidecar-only for now (`:3101`, no `/api/coinank` proxy in the web app) — the same standing as CoinGlass, and a deliberate deferral rather than an omission. Two things this does NOT claim: the 502 mapping is proven by the code path plus a structural check (no wired mode currently triggers a live upstream refusal, because all five are param-free), and the `whales` mode's pagination is upstream's default page only — `pageNum`/`pageSize` are refused rather than forwarded, so paging beyond the first page is out of scope until a mode that genuinely pages is designed.

### DR-038 amendment — the CoinAnk family now has a web proxy route (2026-10-03, later)
**What changed.** The “sidecar-only for now” deferral recorded above is closed: `/api/coinank` now exists in the web app as a thin verbatim proxy to `fudcourt-data` (`:3101`), so the fifth keyless family is reachable from the board like its siblings. The route validates nothing — the sidecar stays the single validator (the `interval` allowlist, the param-scoping matrix) — and relays the upstream 502 refusal as written, so the family is still **DARK** through the web surface.
**Consequence for the gate.** `check-contract.py` no longer passes this family through: it now carries a `CN_MODES` TS↔Go pair (the mirror in `src/features/coinank/client.ts` must equal `backend/data/internal/research/coinank/modes.go`) plus a proxy-shape assertion on `frontend/web/src/app/(frontend)/api/coinank/route.ts`. The “the family has no web proxy route, so the TS/Go parity gate is unaffected” clause in the evidence above was true when written and is superseded here.

## DR-039 — CoinMarketCap is keyless by having NO credential at all, and `limit=0` is a success envelope carrying an empty list (2026-10-03)
**Status:** accepted and **landed end-to-end** — the `coinmarketcap` package, the sidecar wiring, the hermetic tests, the live verifier, the recon doc and the categorization rows. No API key exists on the path and none was requested.
**Context.** CoinMarketCap ships two surfaces. `pro-api.coinmarketcap.com` is the documented product, gated by an issued `X-CMC_PRO_API_KEY` and billed per credit. `api.coinmarketcap.com/data-api/v3` is the backend the coinmarketcap.com dashboard itself calls, and it has **no credential of any kind** — no key, no signature, no ciphertext. This is the **third** distinct keyless mechanism in this sidecar, after CoinGlass (an encrypted body that must be decrypted) and CoinAnk (a header computed in the browser bundle): here there is nothing to undo at all, so the family is a plain `net/http` GET and stays stdlib-only. Three other keyless dashboards were probed first and **dropped rather than shipped**: `api.coinalyze.net` (401), `api.coinstats.app` (404 on the dashboard path), `coincodex.com/api` (blocked).
**Decision.**
1. **The documented pro API is NOT wired.** It needs a human-issued key and a credit quota, so it is a different product with different coverage and rate limits — not an alternative transport for these modes. Recording that plainly matters: a future maintainer seeing "CoinMarketCap" in the family list must not assume the pro host is what is being read.
2. **A refusal is a 502, never an empty 200.** CoinMarketCap does not use HTTP status codes to refuse: a validation failure and a transient "system busy" alike arrive as **HTTP 200 with `status.error_code != "0"`** (measured `"400"` for `marketPairs` with no slug, `"500"` `"The system is busy, please try again later!"` for an unknown slug and for a non-integer limit). `fetch.go` therefore keeps the whole status object and `Decode` returns a typed `HardError` carrying upstream's own `code` and message; the handler maps it to **502 `upstream refused`**. Any implementation that only checks the HTTP code renders a refusal as a confident empty table — the exact failure the frozen-envelope contract forbids.
3. **The pagination bounds are LOCAL, because upstream answers `limit=0` with a success.** Measured live: `limit=0` returns **HTTP 200**, `status.error_code "0"`, and `{"cryptoCurrencyList":[],"totalCount":"8138"}` — a **success** envelope carrying an **empty list**. Nothing in that response distinguishes *"you asked for zero rows"* from *"this market has no coins"*, so a pass-through route would render it as a confident empty board. `limit` is therefore validated against `[1,1000]` (default 100, the dashboard's own page size) and `start` against `[1,100000]` (default 1) **before any request is made**; a bad value is a local **400 `invalid param`** whose `detail` names the accepted range and the reason, generated from the same constants the validator uses so the message cannot drift from the code. `limit=99999` (a measured **9,643,042-byte** response) is refused at the door for the same reason.
4. **Params upstream silently ignores are 400 `unexpected param`.** `?bogus=1` on the listing returns the ordinary listing: upstream does not reject an unrecognised query param. A pass-through that accepted anything would report success for a request it did not honour, so the param-scoping matrix is enforced in the handler — an unknown name, **or a known param sent to the wrong mode** (`slug` on `listing`, `limit` on `global`), is a 400.
5. **`upstreamCount` is present only when it is a measurement.** For an array payload it is the row count at the mode's known path (`cryptoCurrencyList`, `exchanges`, `marketPairs`); for the **object** payload (`global`) the key is **ABSENT** — a `0` there would assert a count upstream never published. The array path is shared between the adapter and the verifier through one `ArrayPath` accessor, so the two cannot disagree about where the rows live. `data` is upstream's payload **verbatim**.
6. **Cache is transport state, header-only.** `X-CMC-Upstream`, `X-CMC-Cache` (`json:"-"`), `Cache-Control: public, max-age=30` — the same shape as the CoinGlass and CoinAnk siblings, so a body `cache` key cannot appear as a second, disagreeing spelling. The disk cache stores the **raw upstream body**, so a warm hit and a cold hit return identical bytes.
7. **The verifier is an ORACLE, not a mirror.** `scripts/verify/verify-coinmarketcap.py` fetches `api.coinmarketcap.com/data-api/v3` **itself** and compares row counts against the adapter's own response (within a tolerance band, since a live market moves between the two calls). An adapter-only verifier would confirm the adapter's arithmetic with the adapter's arithmetic.
**Evidence.** `go build ./... && go vet ./... && go test ./... -count=1` green — hermetic tests over a fake `Doer` (no network): the mode table and its order, the URL builder, the array-path table, the param-scoping matrix, the bounds (`limit=0`/`abc`/`-1`/`99999`/`1001`, `start=0`/`100001`), the slug validator, the refusal-as-error path for both `"400"` and `"500"`, the object-payload-has-no-count rule, the null-data-is-an-error rule, and the cache MISS/HIT/fresh triple; plus 13 handler tests (`coinmarketcap_test.go`) asserting each rejected param **never reached upstream** (the fake records every request). `python3 scripts/verify/verify-coinmarketcap.py` → **70 pass / 0 fail / 0 skip** against the live sidecar, including the four direct-oracle fetches (listing **101**, exchanges **100**, marketPairs **100** rows, global **object**), the 13-case 400 matrix, a **real upstream refusal → 502 `code=500`**, `MISS → HIT → fresh MISS → HIT`, header/body agreement, and `healthz` → `coinmarketcap: 4 modes (keyless, no credential)`. `docs/architecture/data-categorization.{md,json}` gains the family's 5 rows (156 → **161**). No `check-contract.py` change is needed: that gate is scoped to Go-owned paths with a web proxy route, and this family is sidecar-only (the same standing as CoinGlass and CoinAnk).
**Relationship to earlier records.** DR-033 (one name per service; no live credential in a tracked file): no credential is introduced at all, so there is nothing to keep out of a tracked file. DR-038 established the envelope shape this family follows — provenance-first, verbatim `data`, header-only cache, upstream refusal as 502 — so the three keyless families now read the same way and differ only in their **mechanism** (decrypt / compute / nothing). DR-018: no file is added at a `src` root; the new package is a leaf under `internal/research/`.
**Consequences.** A caller can no longer be handed an empty board it should not trust: the `limit=0` trap is unreachable through the route, an ignored param is refused instead of silently dropped, and an upstream refusal surfaces as a 502 carrying upstream's message. The family is sidecar-only for now (`:3101`, no `/api/coinmarketcap` proxy in the web app) — the same deliberate deferral as CoinGlass and CoinAnk, and a deferral rather than an omission. Two things this does NOT claim: the mode set is the four surfaces that survived the probe matrix (a dashboard endpoint not probed is simply not wired), and the pro API's richer coverage — historical quotes, converters, metadata — is out of scope by decision 1, not by accident.

### DR-039 amendment — the CoinMarketCap family now has a web proxy route (2026-10-03, later)
**What changed.** The “sidecar-only for now” deferral recorded above is closed: `/api/coinmarketcap` now exists in the web app as a thin verbatim proxy to `fudcourt-data` (`:3101`), forwarding `X-CMC-Upstream`/`X-CMC-Cache`. The LOCAL `start`/`limit` bounds stay in the handler (the `limit=0` trap is refused before any fetch), and an upstream refusal still surfaces as a 502 carrying upstream's own `error_code`.
**Consequence for the gate.** `check-contract.py` now carries a `CMC_MODES` TS↔Go pair (the mirror in `src/features/coinmarketcap/client.ts` must equal `backend/data/internal/research/coinmarketcap/modes.go`) plus a proxy-shape assertion on `frontend/web/src/app/(frontend)/api/coinmarketcap/route.ts` — superseding the “No `check-contract.py` change is needed” clause above.

## DR-040 — Postgres+TimescaleDB is the single system of record; Turso/libSQL is dropped (2026-10-03)

**Status:** accepted, implemented.

**Context.** DR-019 split the treasury store in two: Turso (libSQL/SQLite) held the
system of record (`accounts`, `assets`, `journal`, `ledger`, `trades`,
`transactions`, `venues`, `wallets`) and a local Postgres+TimescaleDB database was
the read model, kept in parity by `frontend/web/scripts/tools/pg-load.ts` on a 60 s
timer (`fudcourt-pgload.timer`). The split bought a measured read win (a Turso round
trip from the homeserver is ~394 ms against ~2.8 ms for local Postgres), but it left
the system of record on a remote managed service — and, measured 2026-10-03, the two
halves had drifted into a shape that LOSES WRITES:

  * every app write route (`api/transactions`, `api/wallets`) already calls `query()`,
    which is a DIRECT Postgres statement (`platform/db/client.ts`);
  * the documented Turso write path, `execute()`, has ZERO callers;
  * the projection PRUNES (`DELETE FROM <t> WHERE <pk>::text NOT IN (<turso keys>)`),
    so a row the UI wrote into Postgres that Turso never saw is deleted by the next
    timer tick.

The app therefore already writes Postgres, Turso is written only by
`tests/oracle/sync-live.py` (the `assets` table), and the projection can silently
revert a UI write. The two-store split had become a correctness hazard with no
remaining benefit.

**Options.** (a) Repair the split — repoint `execute()` at Turso and route every app
write through it, keeping the mirror. (b) Collapse to ONE store. (c) Keep both stores
and stop projecting.

**Decision.** (b). Postgres+TimescaleDB — the `fudcourt` database in the
`postgres-hardened` container on 127.0.0.1:5432 — is the single system of record.
Turso/libSQL is dropped entirely: the `@libsql/client` dependency, `TURSO_URL` /
`TURSO_AUTH_TOKEN`, the generated SQLite schema dump, the projection and its timer,
and every code path that names it. TimescaleDB — the one capability Turso never had
— is already installed in the `fudcourt` database (`timescaledb 2.30.1`), so the
collapse adds no infrastructure. (c) is rejected because a store nothing writes is
just a stale copy waiting to be read by mistake.

**What changes.**
- Schema: `database/schema/pg-schema.sql` is THE schema. `database/schema/schema.sql`
  (the generated SQLite dump) and `scripts/database/dump-schema.mjs` are deleted.
- Writers write Postgres: `tests/oracle/sync-live.py` (psycopg2), the Rust crate
  (`tokio-postgres`), and the web (`platform/db/client.ts`, already Postgres).
- Readers read Postgres: the Rust `/api/reconcile` service now does; the web already did.
- `assets` observations reach the `asset_history` hypertable through a database
  TRIGGER (`assets_snapshot`), not through application code, so every writer snapshots
  identically.
- Removed: `frontend/web/scripts/tools/pg-load.ts`, `scripts/verify/parity-pg.ts`,
  `fudcourt-pgload.{service,timer}`, and the Turso projection in
  `platform/db/mirror.ts` (renamed `platform/db/pg.ts`, keeping the pooled client, the
  SQLite→Postgres dialect translator and the dashboard read set).

**Evidence.** Baseline parity measured 2026-10-03 before the cutover: a read-only
table-by-table comparison of Turso against local Postgres reported `BASELINE_PARITY_OK`
— `accounts` 6/6, `assets` 16/16, `journal` 8/8, `ledger` 3/3, `trades` 0/0,
`transactions` 48/48, `venues` 12/12, `wallets` 3/3, every table byte-identical.

**Consequences.** One store, one writer, no projection lag and no prune hazard. Reads
stay on local Postgres (the ~2.8 ms path); writes lose the ~394 ms Turso round trip.
The remote managed dependency and its credential are gone, so the treasury store no
longer has an external availability or billing surface. `asset_history`/`price_history`
keep their 90-day retention, now enforced by a plain DELETE in the sync. The Rust sync
binary is still not deployed (`fudcourt-sync-rust` is not installed); it is kept
building and in parity with the Python oracle by `verify-sync.py`.

## DR-041 — The `/chainrank` and `/khala` boards are removed; both sidecar families stay API-only (2026-10-03)

**Status:** accepted, implemented.

**Context.** Two of the board surfaces the shell carried were thin reader views over
sidecar families that had already moved to Go: `ChainrankPage` (`/chainrank`,
`features/chainrank/`) and `KhalaPage` (`/khala`, `features/khala/`). Each was a
`features/*/client.ts` + `ui.tsx` pair plus a verbatim Next proxy route
(`app/(frontend)/api/{chainrank,khala}/route.ts`) whose only validator was the Go
sidecar on `:3101`. Both were the least-read pages in the set, and their web half
existed solely to re-serve a payload the sidecar already published.

**Options.** (a) Keep both boards. (b) Remove the whole chainrank + khala stack,
sidecar included. (c) Remove the **web surface** only — the boards, their nav tabs,
their feature modules and their Next proxy routes — and leave the Go families served
on `:3101`.

**Decision.** (c). The owner asked for the pages gone, not the data. The Go packages
(`backend/data/internal/research/{chainrank,khala}/`), their mux handlers
(`handleChainrank` / `handleKhala`) and the `/healthz` keys are untouched, so
`/api/chainrank` and `/api/khala` still answer on `:3101` and their live harnesses
(`verify-chainrank.py` 50/50, `verify-khala.py`) still prove the wire contract. (b) is
rejected because the acquisition is orthogonal to the board — nothing about the
upstreams changed. (a) is rejected because a reader view with no reader is upkeep
without a customer.

**What changes.**
- Deleted: `frontend/web/src/app/(frontend)/(public)/{chainrank,khala}/page.tsx`,
  `frontend/web/src/features/{chainrank,khala}/` (`client.ts`, `ui.tsx`), and
  `frontend/web/src/app/(frontend)/api/{chainrank,khala}/route.ts`.
- Routing: the `/chainrank` and `/khala` entries are gone from
  `platform/routing/public-routes.ts` and `view-routes.ts`, and both nav tabs and both
  render branches are gone from `components/layout/store-shell.tsx`.
- Limiter: `ROUTE_COST.khala` is gone (`platform/http/rate-limit-inbound.ts`), so the
  inbound table is `executor / market / markets / ticker`.
- Contract spec: the `/api/chainrank` and `/api/khala` paths and the eight schemas only
  they referenced (`Kh*`, `ChainrankStatsEnvelope`, `ChainrankListingsEnvelope`) are
  gone from `shared/contracts/openapi/fudcourt.yaml`; the TypeScript SDK is regenerated
  from it. `check-contract.py`'s two TS↔Go parity blocks become "web surface removed
  (sidecar-only)" rows — with no TS table there is no second side to compare.
- Harnesses: `verify_all_routes.py` drops its chainrank probes and its khala group F,
  `tests/design/fingerprint.py` drops both routes, `monitor.py` drops its khala probe,
  and the design token `lineHeight.snug` — whose only consumer was the khala board — is
  removed from `styles/tokens.ts` and its generated artifacts.

**Evidence.** `bash scripts/verify/verify-all.sh` → `VERIFY_ALL_OK`; the live sidecar
still answers both families on `:3101` (`/healthz` →
`{"build":"28 modes","chainrank":"2 modes","khala":"3 modes"}`); `python3
scripts/verify/check-contract.py` → `CONTRACT_OK`; `python3 -m json.tool
docs/architecture/data-categorization.json` → valid.

**Consequences.** The web shell carries two fewer board views, and the two families are
reachable only through `:3101` — the trust class DR-006/DR-013 gave them, now without a
web proxy in front. Re-adding a board means re-adding the route, the `ROUTE_COST` entry,
the nav tab and the OpenAPI paths together; the contract gate's "web surface removed"
rows are the reminder that they were deliberately taken out.

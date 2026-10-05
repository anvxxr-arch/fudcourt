# fudcourt

Personal treasury OS + CryptoRank read proxy + Payload blog — Next.js 16
monorepo (**one** Next app, `frontend/web`, serving the dashboard and the CMS blog)
plus a Go acquisition sidecar
(`backend/data`, [DR-005](docs/records/DECISIONS.md)) and a Rust service pair
(`backend/sync`, [DR-010](docs/records/DECISIONS.md)/[DR-014](docs/records/DECISIONS.md)),
run on the homeserver
(`192.168.100.6`) with an evidence-first verification stack. Every number on the board is either
exactly reconciled or shown as `—`; upstream errors fail loud (502/503),
never as fabricated rows.

**Start here → [docs/README.md](docs/README.md)** — the documentation index, grouped
by the question you arrive with: `docs/product/` (PRD, analysis, recommendations),
`docs/architecture/` (**[ARCHITECTURE](docs/architecture/ARCHITECTURE.md)**, tech stack,
schema), `docs/operations/` (PLAN, [SECRETS](docs/operations/SECRETS.md), changelog),
`docs/records/` ([DECISIONS](docs/records/DECISIONS.md)).

**Layout in one line** ([DR-018](docs/records/DECISIONS.md)): one `src/` tree in
`frontend/web` — `src/app/` routes only, `src/features/<family>/` one vertical slice per
data family, `src/platform/` shared infrastructure, `src/components/` (ui + layout) and
`src/styles/` leaves — enforced by `frontend/web/scripts/checks/check-structure.py`.

> **Hosting:** self-hosted on the homeserver — production = the systemd units
> (`fudcourt-web` :3100 — dashboard + blog, `fudcourt-data` :3101,
> `fudcourt-reconciled` :3102, `fudcourt-sync.timer`), **no
> third-party deploy target** ([DR-002](docs/records/DECISIONS.md)). Public entry:
> **https://fc.dwirijal.my.id** (Cloudflare Tunnel → loopback origin,
> mutation API fail-closed).

## Run

```bash
# from the repo root
cd backend/data && go build -o bin/fudcourt-data ./cmd/data && ./bin/fudcourt-data
                                         # CryptoRank sidecar -> :3101 (unit: infrastructure/systemd/fudcourt-data.service)
cd ../../frontend/web && bun install && bun run dev # dashboard + blog + proxy -> :3000
                                          # (prod unit: :3100, served by Bun — DR-008/DR-017)
                                          # blog: /blog (public), /blog/cms/admin (Payload)
unset NODE_ENV                           # dev/build must never inherit production
```
The board's `/api/cryptorank` is a thin proxy to the Go sidecar: it takes the
sidecar's env `FUDCOURT_DATA_URL` (default `http://127.0.0.1:3101`), so the Go service
must be up for any cryptorank mode to answer — and if it is down the route says
so (502 with the real reason), it does not fall back to a cached or fabricated
payload.
The sidecar is also the home of the **`llama`** family (DeFiLlama TVL, 3 modes,
strict `top`/`days`), the **`news`** family (Cointelegraph RSS: strict
`source`/`limit`, the RSS parse, cached on the feed URL), the **`chainrank`**
family (chainrank.fyi reads, pagination relayed verbatim) and `backend/sync` holds
the Rust port of the 5-minute balance sync. The same sidecar is the home of the **`khala`**
family — research reports from **khala.io** (Framer SSR, keyless), three modes
(`reports`/`report`/`latest`), one Go package with a plain `net/http` client; the Go side
does every validation. `khala` and `chainrank` are **API-only**: their web boards and TS
clients were removed ([DR-041](docs/records/DECISIONS.md)), so `/api/khala` and
`/api/chainrank` answer on `:3101` with no web proxy (harness `verify-khala.py` 136/0) ·
design record `/home/dwizzy/khala-probe/DESIGN.md`.

Secrets live only in git-ignored `.env` files — see [docs/operations/SECRETS.md](docs/operations/SECRETS.md)
for the inventory and rotation steps (never print a value).

## Verify
```bash
bun run verify   # = bash scripts/verify/verify-all.sh: EVERY offline gate in one pass
                 # (structure, web contract, deploy units, contracts drift + sdk drift,
                 #  go build/vet/test x3 modules, cargo build/test, hook syntax,
                 #  frontend/web typecheck + shaper fixtures)
```
The gates individually (each line runs from the cwd its `cd` leaves it in):
```bash
cd backend/data
go build -o bin/fudcourt-data ./cmd/data  # build the sidecar (go >= 1.24.1)
go test ./...                            # offline: mode-table + shaping tests
cd ../sync && cargo test --release  # offline: the Rust sync crate (parity-checked
                                      # against the repo-root path tests/oracle/sync-live.py)
cd ../../frontend/web
python3 scripts/checks/check-structure.py    # offline: DR-018 layer gate (the one gate left inside the app)
bun run test:shapers                # offline: shaper + auth + inbound rate-limit tests
bunx tsc --noEmit && bun run build  # typecheck + Next 16 build (Bun is the runner: DR-007)
cd ../..                            # back to the repo root: the repo-wide gates live in scripts/
python3 scripts/verify/check-contract.py     # offline: CR_MODES + TS-Go mode-table parity + mutation-auth guards
python3 scripts/verify/check-deploy.py       # offline: every unit ExecStart path must exist
python3 scripts/verify/verify-sync.py         # OFFLINE: sync oracle gate — Python sync-live.py vs
                                              # Rust fudcourt-sync byte-identical replay (tests/oracle fixtures)
python3 scripts/verify/verify-cryptorank.py  # LIVE: 244-check upstream harness (3-gate decoy detector)
python3 scripts/verify/monitor.py            # LIVE: deterministic smoke monitor (cron every 15m)
python3 scripts/verify/verify-khala.py       # LIVE: khala harness (136 checks; green on :3101)
python3 scripts/verify/verify-llama.py       # LIVE: DeFiLlama harness (51 checks; green on :3101/:3100)
python3 scripts/verify/verify-news.py        # LIVE: Cointelegraph RSS harness (50 checks; green on :3101/:3100)
python3 scripts/verify/verify-chainrank.py   # LIVE: chainrank harness (50 checks; green on :3101/:3100)
node scripts/database/dump-schema.mjs --check  # schema drift alarm vs database/schema/schema.sql
```
CI is five path-filtered workflows (the single `ci.yml` this line used to name was split in
Phase 9) — `web.yml` (contract/structure gates,
typecheck, shaper fixtures, build), `go.yml` (build/vet/test per Go module),
`rust.yml` (`backend/sync`), `contracts.yml` (contracts drift + generated SDK) and
`integration.yml` (the offline aggregate `scripts/verify/verify-all.sh` — the
deploy-unit guard runs there, not in `web.yml`, ordered after `cargo build` —
plus the live reconcile contract). Each ends in a required `gate` job.

## House rules

- **No API keys for CryptoRank** — and none for `khala` either, for a *different*
  reason: khala.io is static Framer HTML that answers a non-browser client with no
  challenge, so plain `net/http` is the whole path (measured; [DR-006](docs/records/DECISIONS.md)).
  The CryptoRank path keeps its browser-TLS stack — two families, two measured client
  requirements, deliberately **not** merged into one shared client.
  For CryptoRank the verified path is HTML reverse-engineering of the site's own SSR
  payload; revisit an official key only on measured RE breakage
  ([R-11](docs/product/RECOMMENDATIONS.md) standing).
- **Parity proves self-consistency, never truth** — every data family passes a
  3-gate decoy detector (nonexistent slug → 404, independent ground truth,
  cross-surface agreement) before it is wired. The `khala` family's verifier takes
  this literally: it fetches khala.io **directly** as its oracle (sitemap slug-set
  equality + page title/date parity) and never reads the adapter's own output as truth.
- **Never clamp input, never fake a zero** — bad key → local 400, honest
  upstream miss → 404 passthrough, refused data-class → loud 503 with the
  evidence.
- **A cost is measured before it is enforced** — inbound rate limits are priced
  from each route's measured worst-case payload ([DR-004](docs/records/DECISIONS.md)),
  never from a guess; the limiter fails open so a counter bug cannot become an
  outage, and every decision is visible as `X-RateLimit-*`.

# fudcourt

Personal treasury OS + CryptoRank read proxy + Payload blog — Next.js 16
monorepo (**one** Next app, `apps/web`, serving the dashboard and the CMS blog)
plus a Go acquisition sidecar
(`apps/data`, [DR-005](docs/records/DECISIONS.md)) and a Rust service pair
(`apps/reconciler`, [DR-010](docs/records/DECISIONS.md)/[DR-014](docs/records/DECISIONS.md)),
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
`apps/web` — `src/app/` routes only, `src/features/<family>/` one vertical slice per
data family, `src/lib/` + `src/server/` shared infrastructure, `src/ui/` and
`src/styles/` leaves — enforced by `apps/web/scripts/checks/check-structure.py`.

**Repository layout:** `apps/` holds every deployable (`api`, `bot`, `data`,
`executor`, `web`, `reconciler`), `contracts/` the cross-service schemas and their
gates, `db/` the DDL, `tests/` the shared fixtures and oracles, `tools/` the one
command surface, `scripts/` the verification harnesses, `infrastructure/` the
systemd units, `docs/` everything written down.

> **Hosting:** self-hosted on the homeserver — production = the systemd units
> (`fudcourt-web` :3100 — dashboard + blog, `fudcourt-data` :3101,
> `fudcourt-reconciled` :3102, `fudcourt-sync.timer`), **no
> third-party deploy target** ([DR-002](docs/records/DECISIONS.md)). Public entry:
> **https://fc.dwirijal.my.id** (Cloudflare Tunnel → loopback origin,
> mutation API fail-closed).

## Run

```bash
# from the repo root
cd apps/data && go build -o bin/fudcourt-data . && ./bin/fudcourt-data
                                         # CryptoRank sidecar -> :3101 (unit: deploy/systemd/fudcourt-data.service)
cd ../web && bun install && bun run dev # dashboard + blog + proxy -> :3000
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
family (chainrank.fyi reads, pagination relayed verbatim) and `apps/reconciler` holds
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

One command:

```bash
node tools/fud.ts verify     # every offline gate in one pass
bun run verify               # the same, through the root package.json
```

Covers: the frontend structure gate (DR-018), the web contract gate, the deploy-unit
guard, the four contract drift gates, `go build/vet/test` over the single root
module, `cargo build/test` for the reconciler, the sync oracle gate (Python vs Rust
byte-identical replay), the cross-service API conformance check, the pre-push hook
syntax check, and `apps/web` typecheck + shaper fixture tests.

The subcommands, when you want one gate rather than all of them:

```bash
node tools/fud.ts contracts      # the four contract drift gates
node tools/fud.ts deploy         # systemd unit guard (ExecStart paths, timer pairs)
node tools/fud.ts structure      # frontend DR-018 layer gate
node tools/fud.ts test go        # go test ./...
node tools/fud.ts test web       # apps/web: typecheck + shaper fixtures
node tools/fud.ts test sync      # apps/reconciler: cargo test --release
```

`tools/fud.ts` is a dispatcher, not a reimplementation: every subcommand shells out
to the script that already owns the check, so each gate has exactly one
implementation. It is plain ESM TypeScript with no imports beyond node builtins, so
it runs under `node --experimental-strip-types` (what CI has) or `bun` with no
dependency install.

The live/network harnesses stay manual on purpose — they touch upstreams and are
slow:

```bash
python3 scripts/verify/verify-cryptorank.py  # LIVE: 244-check upstream harness
python3 scripts/verify/monitor.py            # LIVE: deterministic smoke monitor
python3 scripts/verify/verify-khala.py       # LIVE: khala harness (136 checks)
python3 scripts/verify/verify-llama.py       # LIVE: DeFiLlama harness (51 checks)
python3 scripts/verify/verify-news.py        # LIVE: Cointelegraph RSS harness
python3 scripts/verify/verify-chainrank.py   # LIVE: chainrank harness (50 checks)
```

CI is five path-filtered workflows — `web.yml` (contract/structure gates, typecheck,
shaper fixtures, build), `go.yml` (build/vet/test on the single root module),
`rust.yml` (`apps/reconciler`), `contracts.yml` (contract drift + generated SDK) and
`integration.yml` (the offline aggregate `scripts/verify/verify-all.sh` — the
deploy-unit guard runs there, not in `web.yml`, ordered after `cargo build` — plus
the live reconcile contract). Each ends in a required `gate` job.

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

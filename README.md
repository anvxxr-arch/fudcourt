# fudcourt

Personal treasury OS + CryptoRank read proxy + Payload blog — Next.js 16
monorepo (`apps/web`, `apps/blog`) run on the homeserver (`192.168.100.6`) with
an evidence-first verification stack. Every number on the board is either
exactly reconciled or shown as `—`; upstream errors fail loud (502/503),
never as fabricated rows.

**Start here → [docs/README.md](docs/README.md)** — the documentation index
(PRD, schema, architecture/analysis, ranked recommendations, PLAN status board,
[DECISIONS](docs/DECISIONS.md) records, [SECRETS](docs/SECRETS.md) runbook).

## Run

```bash
cd apps/web  && npm ci && npm run dev    # board + proxy   -> :3000 (prod unit: :3100)
cd apps/blog && npm ci && npm run dev    # Payload CMS     -> :3000 (prod unit: :3001)
unset NODE_ENV                           # npm dev/build must never inherit production
```

Secrets live only in git-ignored `.env` files — see [docs/SECRETS.md](docs/SECRETS.md)
for the inventory and rotation steps (never print a value).

## Verify

```bash
cd apps/web
python3 scripts/check-contract.py   # offline: CR_MODES contract + mutation-auth guards
npm run test:shapers                # offline: 56 tests over 26 recorded upstream payloads
npx tsc --noEmit && npm run build   # typecheck + Next 16 build
python3 scripts/verify-cryptorank.py  # LIVE: 244-check upstream harness (3-gate decoy detector)
python3 scripts/monitor.py            # LIVE: deterministic smoke monitor (cron every 15m)
node scripts/dump-schema.mjs --check  # schema drift alarm vs db/schema.sql
```

CI (`.github/workflows/ci.yml`) runs the offline gates on every push: contract,
typecheck, build, shaper fixture tests, blog build.

## House rules

- **No API keys for CryptoRank.** The verified path is HTML reverse-engineering
  of the site's own SSR payload; revisit an official key only on measured RE
  breakage ([R-11](docs/RECOMMENDATIONS.md) standing).
- **Parity proves self-consistency, never truth** — every data family passes a
  3-gate decoy detector (nonexistent slug → 404, independent ground truth,
  cross-surface agreement) before it is wired.
- **Never clamp input, never fake a zero** — bad key → local 400, honest
  upstream miss → 404 passthrough, refused data-class → loud 503 with the
  evidence.

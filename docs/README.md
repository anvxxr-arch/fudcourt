# Fudcourt — Documentation

**Fudcourt** is a personal multi-chain treasury & market-intelligence OS: a Next.js
dashboard that tracks wallets, balances, reconciliation and live market boards
(cryptorank / chainrank / dexscreener / defillama / news / signals), plus a
Payload CMS blog — both in one npm-workspaces monorepo.

- Repo: `github.com/anvxxr-arch/fudcourt` · remote head at time of writing: `957836d`
- Local stack: `fudcourt-web` (`:3100`), `fudcourt-blog` (`:3001`), `fudcourt-sync.timer` (5 min)
- Hosting: **self-hosted** on the homeserver (DR-002) — no third-party deploy
  target; production = the systemd units above (`/portfolio` rewrite lives in
  `apps/web/next.config.js`)

## Documents

| Doc | Contents |
|-----|----------|
| [PRD.md](./PRD.md) | Product requirements: goals, personas, FR/NFR, scope, out-of-scope |
| [SCHEMA.md](./SCHEMA.md) | Data schemas: Turso tables, Payload/Neon tables, API envelopes |
| [TECH-STACK.md](./TECH-STACK.md) | Languages, frameworks, data stores, infra, verification tooling |
| [ANALYSIS.md](./ANALYSIS.md) | Fully comprehensive analysis: architecture, reasoning, evidence, risks |
| [RECOMMENDATIONS.md](./RECOMMENDATIONS.md) | Ranked recommendations with impact/effort |
| [PLAN.md](./PLAN.md) | Goal → subgoal → task → subtask breakdown with status |
| [DECISIONS.md](./DECISIONS.md) | Decision records (DR-xxx): context, options, gate evidence, outcome |
| [SECRETS.md](./SECRETS.md) | Secret inventory, production (self-hosted) env model, rotation runbook (SG-4.2; Vercel half retired by DR-002) |

## One-line map of the repo

```
apps/
  web/    Next.js 16.3.6 portfolio OS (12 pages, 12 API routes) + verify harnesses
  blog/   Next.js 16 + Payload CMS 3.89 (posts/media/categories/users on Neon)
```

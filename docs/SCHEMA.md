# Data Schema — Fudcourt

Two databases + one API envelope contract. Verified 2026-09-27 against remote
head `957836d`.

> ⚠️ **No `.sql` files exist in the repo.** The Turso schema lives only
> server-side (reconstructed below from the code that reads/writes it); the
> Neon schema is versioned via Payload migrations (`apps/blog/src/migrations/`).
> See RECOMMENDATIONS R-1.

## 1. Turso (apps/web) — `fud-balance-anvxxr…turso.io`

### 1.1 `transactions` — canonical ledger of money movements
Reconstructed from `apps/web/app/api/transactions/route.ts` + `[id]/route.ts`:

| Column | Type (inferred) | Notes |
|--------|-----------------|-------|
| `id` | INTEGER PK | auto; `[id]` routes parse with `parseInt` (non-numeric → 400) |
| `date` | TEXT/DATE | required on insert (with `event`) |
| `chain` | TEXT | default `'Offchain'` |
| `asset` | TEXT | default `'USDT'` |
| `event` | TEXT | required on insert |
| `amount_usd` | REAL | signed: `>= 0 → IN`, `< 0 → OUT` |
| `direction` | TEXT | `IN` \| `OUT` (derived if absent) |
| `memo` | TEXT NULL | |
| `wallet_to` | TEXT NULL | |
| `venue_id` | INTEGER/TEXT NULL | |
| `trade_id` | TEXT NULL | |
| `hash` | TEXT NULL | on-chain tx hash — required for exact reconciliation |
| `url` | TEXT NULL | |
| `source` | TEXT | default `'manual'` |

API: `GET` (filters: `limit, offset, search, chain, venue, direction, from, to`),
`POST` (single or `{bulk: true, transactions: []}`), `PUT` (bulk ids+updates),
`DELETE` (bulk ids), plus `/api/transactions/[id]` `PUT|PATCH|DELETE`.

### 1.2 `wallets`
Reconstructed from `apps/web/app/api/wallets/route.ts`:

| Column | Notes |
|--------|-------|
| `address` | **lookup key** for upsert (`UPDATE … WHERE address = ?`) |
| `label` | ordering key (`ORDER BY label` in `getAll`) |
| `alias`, `emoji`, `color`, `notes` | optional display fields |

### 1.3 `assets` — live balances (written by sync every 5 min)
Written by `scripts/sync-live.py` with the hard rule:
**failed RPC raises; it never writes `0`**. Keyed by exact wallet address +
chain; `value_usd` summed for net worth.

### 1.4 Accounting tables (read by `getAll()`)
| Table | Read shape |
|-------|-----------|
| `accounts` | `ORDER BY code` — chart of accounts |
| `journal` | `ORDER BY date DESC` — double-entry journal |
| `ledger` | `ORDER BY account_code` — postings |
| `trades` | `ORDER BY date DESC LIMIT 20` |
| `net_worth` | derived: `SELECT SUM(value_usd) FROM assets` |

## 2. Neon Postgres (apps/blog) — Payload CMS 3.89

Source of truth: `apps/blog/src/migrations/20260917_194354.ts`.

### 2.1 Collections (product tables)
| Table | Purpose | Key columns |
|-------|---------|-------------|
| `users` | admin accounts | `id, email, password, …, updated_at, created_at` |
| `posts` | articles | `id, title, slug, content, hero_image_id → media, author_id → users, _status (draft/published), updated_at, created_at` |
| `posts_tags` / `_posts_v…` | post ↔ tag relations + version history | Payload polymorphic `_rels` |
| `media` | uploads | `id, filename, …` |
| `categories` | taxonomy | `id, title, slug` |

### 2.2 Payload internal
`users_sessions` (auth), `payload_kv`, `payload_preferences(+_rels)`,
`payload_locked_documents(+_rels)`, `payload_migrations`.
Indexes: btree on `order`, `parent_id`, `slug`, FK columns, `updated_at/created_at`, `_status`.

### 2.3 Access rules (verified live)
| Endpoint | Unauthenticated result |
|----------|------------------------|
| `GET /api/posts`, `/api/categories`, `/api/media` | 200, `{docs, hasNextPage, …}` (public read) |
| `GET /api/users` | **403** (ACL enforced) |
| `GET /api/users/me` | 200 `{user: null}` |
| `POST /api/graphql` introspection | blocked by schema policy |
| `/api/graphql-playground` | 404 in production (Payload `disablePlaygroundInProduction: true`) |

## 3. API envelope contract (apps/web)

### 3.1 Success envelope (all market modes, e.g. `GET /api/cryptorank?mode=…`)

```jsonc
{
  "kind": "ecosystem",            // mode name
  "upstream": "https://cryptorank.io/ecosystems/ethereum",
  "fetchedAt": 1790547879,         // unix seconds
  "cache": "MISS" | "HIT…",
  "count": 20,                     // rows in this payload
  "upstreamTotal": 106,            // when the page states it
  "slice": "…provenance text…",    // MANDATORY honest label (what/how much/whose methodology)
  "changeSource": "direct" | "derived-from-histPrices-24H" | "unavailable",
  // payload family (exactly one set per kind):
  "rows": [ … ],                   // coin-like families
  "newsRows": [ … ], "tag": {…}, "relatedTags": [ … ],
  "converterRows": [ … ], "mediaRows": [ … ],
  "ecosystemRows": [ … ], "rwaRows": [ … ], "rwaAsset": {…},
  "quarterlyBtc": [ … ], "quarterlyEth": [ … ],
  "prediction": {…}, "predictionRows": [ … ],
  "aiOverview": {…}, "launchpoolRows": [ … ], "nodesaleRows": [ … ],
  "global": {…}, "fundingRounds": [ … ], "upcomingIco": [ … ]
}
```

Row nullability rule: **any absent upstream metric is `null` and renders `—`;
`0` is never substituted.**

### 3.2 Error contract (verified 2026-09-27)

| Status | Trigger | Example |
|--------|---------|---------|
| **400** | unknown/empty `mode`; malformed `key` (`BAD KEY`); invalid list key | `{"error":"invalid key","detail":…}` |
| **404** | honest upstream miss (unknown coin/tag/ecosystem/rwa slug) — passthrough; **newstag derives 404 from upstream's `tag:null` soft-404 marker** | `{"error":"upstream 404: no such resource"}` |
| **502** | upstream wall / helper failure, with the real `upstreamStatus` | `upstream HTTP 429` (auto-retried ×3 before this) |
| **503** | **data-integrity refusal**: `mode=funding|unlocks` (synthetic decoy class) | `CR_DISABLED_REASON` + reverify instructions |

### 3.3 Proxy routes (apps/web) — parameter contracts

| Route | Params | Modes/types |
|-------|--------|-------------|
| `/api/chainrank` | `mode` | `stats`, `listings` (else 400) |
| `/api/llama` | `mode`, `top`, `days` | `chains`, `protocols`, `historical` |
| `/api/dex` | `type`, `limit`, chain/pair args | `profiles, boosts, boosts-top, search, tokens, tokens-v1, token-pairs, orders` |
| `/api/news` | `source`, `limit≤100` | publisher RSS proxy |
| `/api/signals` | `chain`, `type`, `n` | index/detail signals proxy |
| `/api/reconcile` | — | reconciliation run |
| `/api/all` , `/api/coins` | — | aggregates |

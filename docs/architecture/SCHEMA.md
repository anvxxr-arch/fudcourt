# Data Schema — Fudcourt

Two databases + one API envelope contract. Verified 2026-09-27 against remote
head `957836d`.

> ✅ **Versioned since 2026-09-28 (R-1):** `database/schema/schema.sql` is a
> generated dump of the live Turso schema — regenerate with
> `node apps/web/scripts/tools/dump-schema.mjs`, drift-check with `--check`
> (exits 1 on mismatch; wired into the offline contract gate). The column
> tables below are the code-derived annotation layer; the Neon schema is
> versioned via Payload migrations (`apps/web/src/cms/migrations/`).

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
Written by `scripts/tools/sync-live.py` with the hard rule:
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

## 2. Neon Postgres (payload CMS, merged into apps/web) — 3.89

Source of truth: `apps/web/src/cms/migrations/20260917_194354.ts`.

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
### 3.1b `khala` envelopes (`/api/khala`, a thin proxy to the Go `fudcourt-data` sidecar)
A sibling of §3.1, using the **same flat `CrEnvelope` convention** (`services/data/internal/cryptorank/types.go`):
common fields + per-mode payload keys alongside each other, and the one-line tag rule
**optional ⇒ the key is ABSENT; nullable ⇒ a present `null`**. Three modes, frozen in
[`/home/dwizzy/khala-probe/DESIGN.md`](/home/dwizzy/khala-probe/DESIGN.md) §3 and
[DR-006](../records/DECISIONS.md). Upstream is **khala.io** (Framer static SSR); the route
validates nothing (the sidecar owns every param).

> **State (2026-09-29 ~13:00 UTC):** **served.** The sidecar's mux registers
> `/api/khala` (SG-8.3) and the `bun run build` on `:3100` carries the route — measured
> `GET /api/khala?mode=reports` → **200** on `:3101`, `:3100` and the public hostname,
> `:3101/healthz` → `{"build":"28 modes","khala":"3 modes"}`. The shapes below were
> **re-read from the landed Go types** (`shape.go`: `KhEnvelope`/`KhRow`/`KhReport`,
> `parse.go`: `KhBlock`/`KhSection`/`KhAuthor`), so this section describes the code, not
> an aspiration.

```jsonc
// GET /api/khala?mode=reports
{
  "kind": "reports",
  "upstream": "https://www.khala.io/",   // scalar string (the ROW source)
  "fetchedAt": 1790000000,               // unix seconds
  "cache": "MISS" | "HIT",
  "count": 8,
  "upstreamTotal": 8,                    // *int, omitempty; from sitemap.xml
  "slice": "homepage order, newest first — the site's complete report set; upstreamTotal from sitemap.xml (auxiliary source)",
  "rows": [
    {
      "position": 1,
      "slug": "walrus-solving-the-ai-agent-context-memory-bottleneck-verifiable-onchain-portable-programmable",
      "url": "https://www.khala.io/<slug>",
      "title": "WALRUS: SOLVING THE AI MEMORY BOTTLENECK",
      "summary": "…"
      // published / publishedISO are ABSENT KEYS here — not null (see below)
    }
  ]
  // missingSlugs absent: the homepage covered the sitemap set
}
```
```jsonc
// GET /api/khala?mode=report&key=<slug>
{
  "kind": "report",
  "upstream": "https://www.khala.io/<slug>",   // scalar string (the report URL)
  "fetchedAt": 1790000000,
  "cache": "MISS" | "HIT",
  "count": 1,
  "slice": "publishedISO derived from published; body flattened to text blocks",
  "report": {
    "slug": "…",
    "url": "https://www.khala.io/<slug>",
    "title": "WALRUS: SOLVING THE AI MEMORY BOTTLENECK",
    "metaTitle": "WALRUS: SOLVING THE AI MEMORY BOTTLENECK  - Khala Research",
    "published": "Jul 2, 2026",     // present null when the byline text is not found
    "publishedISO": "2026-07-02",   // present null in that same case
    "authors": null,                // nullable-present; each entry is {name, url} when present
    "sections": [ { "id": "key-takeaways", "level": 2, "title": "KEY TAKEAWAYS" } ],
    "body": [                       // DOM order, inline markup FLATTENED TO TEXT
      { "type": "h2", "id": "key-takeaways", "text": "KEY TAKEAWAYS" },
      { "type": "p", "text": "…" },
      { "type": "li", "text": "…" }
    ]
  }
}
```
```jsonc
// GET /api/khala?mode=latest&limit=N   (default 5, strict 1..50, never clamped)
{
  "kind": "latest",
  "upstream": "https://www.khala.io/",
  "fetchedAt": 1790000000,
  "cache": "MISS" | "HIT",
  "count": 5,
  "upstreamTotal": 8,
  "slice": "khala.io publishes research reports only; no news surface exists (/news /rss.xml /feed all 404, measured 2026-09-29) — latest IS the news surface; limit applied, 5 of 8 served; published/publishedISO resolved from 5 report pages",
  "rows": [
    { "position": 1, "slug": "…", "url": "…", "title": "…", "summary": "…",
      "published": "Jul 2, 2026", "publishedISO": "2026-07-02" }   // populated ONLY on latest
  ]
}
```
khala-specific rules (all measured — see DESIGN.md D2/D4/D5/D6/D7/D10):
- **`upstream` is a scalar string, exactly like §3.1.** `reports`/`latest` name the
  homepage (the row source); `report` names the report URL. `sitemap.xml` is an
  **auxiliary** source of `upstreamTotal`, and it is named in `slice` — not in
  `upstream`.
- **Dates are an ABSENT KEY in `reports`, and present only on `latest`.** The homepage
  carries **0** date-shaped `<p>`, so `reports` does no date lookup at all. An absent key
  says *"this mode does not report dates"*; a present `null` would claim *"we looked and
  found nothing"* — which would be a lie, because no lookup happened. Only `latest`
  (which really fetches N report pages, cached and ETag-revalidated) may populate
  `published`/`publishedISO`, and it names that work in `slice`.
- **`slice` is the honest-label surface and is populated on every mode** — there is no
  boolean `derived` field and no separate `note`: provenance lives in this one string
  (the field §3.1 already uses for slice provenance). It carries, per mode: the homepage/
  sitemap sourcing and the miss count when `missingSlugs` is set (`reports`); the
  `publishedISO`-from-`published` derivation (`report`); the verbatim honestly-no-news
  disclosure shown above plus the date-resolution count (`latest`).
- **`latest` is where the "research AND news" ask honestly lands.** khala.io publishes
  research reports only — `/news`, `/blog`, `/posts`, `/rss.xml`, `/feed(.xml)`,
  `/atom.xml`, `/newsletter`, `/subscribe` are **all real 404 (7,384 B each, measured
  2026-09-29)** and no feed URL exists in any page. So `latest` = the newest N reports
  (not "the last N days": the newest report was ~89 days old on the measurement date),
  and its `slice` says so verbatim.
- **No `bodyHtml`/`bodyText`/`bodyFormat`, and no `author`/`tags`.** The body ships as
  structured blocks, so **no third-party HTML crosses the API** — which is what removes
  the HTML-injection/sanitizer surface from every consumer. The earlier "render via
  bodyText+sections, or sanitize first, never raw `dangerouslySetInnerHTML`" caveat is
  deliberately **retired**: with no HTML string in the payload there is nothing to
  sanitize and no injection path to guard. The accepted tradeoff is that inline
  formatting (emphasis, link targets) is flattened into `text`.
- **The report date's anchor is a TEXT regex over the byline region**, not the
  `--framer-text-color:rgba(255, 255, 255, 0.6)` style attribute (a restyle rewrites
  styles routinely; the date text is the durable thing), format `Mon D, YYYY`, exactly
  one date-shaped `<p>` per report page. "Not found" ⇒ present `null`, never a guess. The
  `<!-- Published … -->` build comment is **forbidden** as a source — it is identical on
  `/`, `/about`, `/disclaimer` and every report, i.e. the site build time.
- **A 200 with no report body is a failure**, never an empty report (the `cryptorank`
  `cf-challenge` posture, house rule *empty upstream ≠ valid answer*).
- `data-framer-name` holds **stale placeholder copy** — never read card text from it.
- **Key regex `^[a-z0-9][a-z0-9-]{0,127}$`** (max 128). Measured slug lengths from the
  live `sitemap.xml`: walrus **94** (longest), surf **76**, x402 **70**, xmaquina **64**,
  bittensor-an-investment-history **61**, openclaw **46**, bittensor-olympics **35**,
  decentralized-robotics **31**. A **79-char cap was proposed and is measurably wrong** —
  it would 400 the flagship report — and `cryptorank.KeyRe`'s 64-char cap (which would 400
  five of the eight) is deliberately **not** reused.
### 3.1c `news` envelope (`/api/news`, a thin proxy to the Go `fudcourt-data` sidecar)
The Go side (`services/data/internal/news`) owns the feed table, the strict
`source`/`limit` validation, the RSS parse and the 15 s cache; the route validates
nothing ([DR-012](../records/DECISIONS.md)). Verified live 2026-09-29 by `verify-news.py`
(**50/50** on `:3101` and through `:3100`).
```jsonc
// GET /api/news?source=cointelegraph&limit=30
{
  "items": [
    {
      "title": "Bitcoin gives back gains as long-term holder supply keeps $85K out of reach",
      "link": "https://cointelegraph.com/markets/<slug>?utm_source=rss_feed&…",
      "description": "Bitcoin failed to make another run at $85,000 as sellers held the line…",  // HTML stripped, clipped to 200 runes
      "pubDate": "Tue, 29 Sep 2026 16:26:11 +0000",
      "image": "https://s3-images.ctmedia.io/media/article-covers/…",
      "source": "Cointelegraph"           // the outlet label, NOT the `source` param
    }
  ],
  "total": 30,                              // FULL parsed item count
  "upstream": "https://cointelegraph.com/rss",
  "timestamp": 1790766371000                // MILLISECONDS (Date.now() convention)
}
```
Rules (all asserted by `verify-news.py`):
- **`items` is a HEAD SLICE, `total` is the truth** — `len(items) == min(limit, total)`,
  so a 5-row body can never be read as "the feed has 5 items".
- **Six keys, always present** — an absent feed element is `""`, never `null` and never a
  missing key (Go's `news.Item` has no `omitempty`). `description` has HTML stripped and
  is clipped to 200 runes (multi-byte safe; the TS UTF-16 slice could split a pair).
- **An empty feed is a `502`**, never an honest-looking empty list; a non-2xx upstream
  keeps its REAL status; `X-Cache: MISS|HIT` is on the header and never in the body.
- **OUR params, strict 400s, never clamped**: `source` ∈ table (default `cointelegraph`)
  or `{"error":"unknown source '<s>'","detail":"expected one of cointelegraph"}`;
  `limit` integer 1..100 (default 30) or `"limit must be an integer, got '<raw>'"` /
  `"limit must be between 1 and 100, got <v>"`. An empty value is a 400, not the
  default — the port's whole point, since the original TS route turned an unknown
  source into a silent empty 200 and clamped `limit`.
### 3.1d `chainrank` envelopes (`/api/chainrank`, a thin proxy to the Go `fudcourt-data` sidecar)
The Go side (`services/data/internal/chainrank`) owns the two-mode table, the
upstream URL construction (pagination relayed VERBATIM), the 32-entry cache and
the shape check; the route validates nothing ([DR-013](../records/DECISIONS.md)). Verified
live 2026-09-29 by `verify-chainrank.py` (**50/50** on `:3101` and through `:3100`).
```jsonc
// GET /api/chainrank?mode=stats
{ "online": 0, "totalClicks": 19, "listings": 1,
  "totalUsdCents": 508, "topUsdCents": 508, "claimTopCents": 1100,
  "kind": "stats",                                  // ours
  "upstream": "https://www.chainrank.fyi/api/stats", // ours: the exact URL that produced this
  "fetchedAt": 1790702862 }                          // ours: unix seconds

// GET /api/chainrank?mode=listings&pageSize=1
{ "rows": [ { "id": "…", "key": "handle:chainrankfyi", "kind": "handle",
              "url": "https://x.com/chainrankfyi", "title": "Chainrank.fyi",
              "totalUsdCents": 508, "clicks": 19, "rank": 1, … } ],
  "page": 1, "pageSize": 1, "total": 1, "totalPages": 1,
  "kind": "listings", "upstream": "…/api/listings?pageSize=1", "fetchedAt": … }
```
Rules (all asserted by `verify-chainrank.py`):
- **Upstream's object is SPREAD, not projected** — chainrank adds row fields freely
  and a projection would drop them silently. The two fields we own (`kind`,
  `upstream`) plus `fetchedAt` are stamped on top.
- **Pagination is relayed UNTOUCHED**, and upstream's own clamping is the answer
  the board shows: `page=0|-1|abc → 1`, `pageSize=0 → 50`, `pageSize=1000 → 200`.
  No local clamp exists — that would be a body indistinguishable from upstream's
  own answer while actually being our guess.
- **A 200 missing the rendered fields is a loud `502`** (`null` is not a number,
  `rows=null` is not an array, an unknown mode has no contract). This is the
  family's spelling of *empty upstream ≠ valid answer*.
- **Write endpoints are never proxied** — `POST /api/click|presence|claim/quote|
  claim/confirm|upload` each mutate someone else's production service; they are
  documented in `lib/chainrank.ts`, absent from the route and from the sidecar's
  mux, and the verifier probes their VALIDATION gates directly against upstream.
- `X-Cache: MISS|HIT|COALESCED` — and the cache is keyed on the FULL upstream URL,
  so `pageSize=7` and `pageSize=8` are distinct entries (unlike `llama`/`news`,
  where one document is trimmed locally and every trim shares one entry).

### 3.2 Error contract (verified 2026-09-27)

| Status | Trigger | Example |
|--------|---------|---------|
| **400** | unknown/empty `mode`; malformed `key` (`BAD KEY`); invalid list key | `{"error":"invalid key","detail":…}` |
| **404** | honest upstream miss (unknown coin/tag/ecosystem/rwa slug) — passthrough; **newstag derives 404 from upstream's `tag:null` soft-404 marker** | `{"error":"upstream 404: no such resource"}` |
| **502** | upstream wall / helper failure, with the real `upstreamStatus` | `upstream HTTP 429` (auto-retried ×3 before this) |
| **503** | **data-integrity refusal**: `mode=funding|unlocks` (synthetic decoy class) | `CR_DISABLED_REASON` + reverify instructions |

`/api/khala` adds rows to this table and **no 503** — no disabled mode was measured (the
cryptorank synthetic-decoy class does not reproduce on khala.io: a bad key is a real
upstream 404, and a missing Framer CMS resource is a 403, not a 404):

| Status | Trigger | Example |
|--------|---------|---------|
| **405** | anything but `GET`/`HEAD` | `{"error":"method not allowed"}` |
| **400** | unknown/empty `mode` (the body lists the three modes); malformed `key` (empty/whitespace, or failing `^[a-z0-9][a-z0-9-]{0,127}$`); `key` absent on `mode=report` (no default); a `limit` sent to a mode that does not take one; non-integer or out-of-range `limit` (strict 1..50) — never clamped | `{"error":"unknown mode","modes":["reports","report","latest"],"got":null}` |
| **404** | honest upstream miss — a key that is not a report is a **real upstream 404** (7,384 B, `<title>Page Not Found \| Framer</title>`) passed through | `{"error":"upstream 404: no such resource","upstreamStatus":404,"upstream":"…","kind":"report"}` |
| **502** | layout drift (a 200 with no report body), a 403 S3-style `AccessDenied` from a missing Framer CMS resource, or the sidecar being unreachable | `{"error":"fudcourt-data unreachable: <reason>"}` |
`/api/chainrank` adds the shape refusal and keeps upstream's own meaning for every
status — and **no 503** (no disabled mode) and **no write path**:
| Status | Trigger | Example |
|--------|---------|---------|
| **405** | anything but `GET`/`HEAD`; upstream's own 405 passed through | `{"error":"upstream stats answered 405 (method gate)","detail":"…"}` |
| **400** | `mode` outside the table (body lists both modes) — never clamped, no page/pageSize validation (relayed) | `{"error":"unknown mode 'bogus'","detail":"expected one of stats, listings"}` |
| **429** | upstream 429, passed through | `{"error":"upstream listings rate limited (429) — too many requests in a short window","detail":"…"}` |
| **502** | upstream returned a non-JSON body, or a 200 whose body lacks the rendered fields, or the sidecar being unreachable | `{"error":"upstream stats returned an unrecognised shape"}` |
| other upstream | the real status is preserved (403/500/503 pass through with the real body prefix) | `{"error":"upstream listings HTTP 500","detail":"…"}` |

`/api/news` adds the upstream's own statuses plus the loud-empty rule — and **no 503**
(the feed has no decoy class to refuse):
| Status | Trigger | Example |
|--------|---------|---------|
| **405** | anything but `GET`/`HEAD` | `{"error":"method not allowed"}` |
| **400** | `source` outside the table (incl. the empty value); `limit` non-integer/out-of-range (strict 1..100) — never clamped | `{"error":"unknown source 'cnn'","detail":"expected one of cointelegraph"}` |
| **429** | upstream 429, passed through | `{"error":"upstream 429 from the RSS feed","detail":"…"}` |
| **502** | a transport failure, **an upstream feed with no `<item>`** (empty ≠ valid answer), or the sidecar being unreachable | `{"error":"upstream returned an empty feed","detail":"…"}` |
| other upstream | the real status is preserved (403/500/503 pass through with the real body prefix) | `{"error":"upstream 403 from the RSS feed","detail":"…"}` |

### 3.3 Proxy routes (apps/web) — parameter contracts

| Route | Params | Modes/types |
|-------|--------|-------------|
| `/api/chainrank` | `mode`, `page`, `pageSize` | `stats`, `listings` (else 400) — thin proxy to the Go sidecar, route validates nothing; pagination relayed verbatim (DR-013) |
| `/api/llama` | `mode`, `top`, `days` | `chains`, `protocols`, `historical` — thin proxy to the Go sidecar, route validates nothing |
| `/api/dex` | `type`, `limit`, chain/pair args | `profiles, boosts, boosts-top, search, tokens, tokens-v1, token-pairs, orders` |
| `/api/news` | `source`, `limit` (1..100, default 30) | publisher RSS proxy — thin proxy to the Go sidecar, route validates nothing (DR-012) |
| `/api/signals` | `chain`, `type`, `n` | index/detail signals proxy |
| `/api/khala` | `mode`, `key`, `limit`, `fresh` | `reports` (khala.io homepage order) · `report` (requires `key=`) · `latest` (takes `limit=`, default 5, 1..50) — thin proxy to the Go sidecar, route validates nothing |
| `/api/reconcile` | — | thin proxy to the **Rust** service `fudcourt-reconciled` `:3102` (DR-014); route validates nothing, adds `source: "rust"`, answers **502 + the real reason** when the service is down (never a fallback board) |
| `/api/all` , `/api/coins` | — | aggregates |

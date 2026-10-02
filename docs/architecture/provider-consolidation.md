# Provider Consolidation Map

The decision document. It takes the two audits — `cryptorank-mode-audit.md` (28 modes) and
`provider-deep-dive.md` (the seven other families) — and turns them into **target surfaces**:
which public pages survive, which merge, which are dropped, and where every unique family ends
up.

Grounded on the live tree: 14 public pages under `frontend/web/src/app/(frontend)/` and the
provider routes under `…/api/`. Snapshot 2026-10-02.

## 1. Current surface inventory

| public page | api route | provider | nature |
|---|---|---|---|
| `/` | — | internal | landing (curated) |
| `/login`, `/member` | `auth/*` | internal | auth |
| `/ticker`, `/ticker/[ticker]` | `/api/ticker`, `ticker/instrument[s]` | **internal venue sweep** | ✅ unique |
| `/tracker` | `/api/markets` | CoinGecko | 🔴 price mirror |
| `/dex` | `/api/dex` | DexScreener | 🟢 pairs |
| `/trench` | `/api/dex` | DexScreener | 🟢 pairs |
| `/signals` | `/api/signals` | data-public | 🟢 scored signals |
| `/scoreboard` | `/api/signals` | data-public | 🟢 same provider |
| `/news` | `/api/news` | Cointelegraph RSS | 🟢 news |
| `/khala` | `/api/khala` | khala.io | 🟢 research |
| `/chainrank` | `/api/chainrank` | chainrank.fyi | 🟡 pay-to-rank |
| `/llama` | `/api/llama` | DeFiLlama | 🟢 TVL/chain |
| `/cryptorank` | `/api/cryptorank` (28 modes) | cryptorank.io | 🔴 mostly dup |

> **Naming trap.** `/api/coins` is **not** CoinGecko — it is a portfolio aggregate over the
> `assets` table (`SELECT asset, SUM(value_usd) … GROUP BY asset`). CoinGecko lives at
> `/api/markets`. Do not confuse the two when renaming.

## 2. Duplication map

```
CoinGecko  /api/markets ─────────────── supersedes ─┐
                                                    ├─ CryptoRank coins,gainers,losers,
                                                    │  converter,coin,chain,tag,ecosystem
DeFiLlama  /api/llama   ─────────────── supersedes ─┤  CryptoRank blockchains, ecosystems(tvl)
Cointelegraph /api/news ─────────────── supersedes ─┘  CryptoRank news,newstag
DexScreener /api/dex    ── overlaps CoinGecko on DEX pairs (adds per-pair liq/txns/fdv)
data-public /api/signals ── unique (scored/vetoed signals)
Khala       /api/khala   ── unique (research reports)
ChainRank   /api/chainrank ── unique (pay-to-rank board)
CryptoRank unique modes  ── launchpool,nodesale,rwa,prediction,media,aioverview,quarterly,funding-slice
```

Three price/tvl/news mirrors collapse onto three keyless, stable providers. CryptoRank keeps
only the eight modes nothing else serves — and those are page-1 truncated.

## 3. Target: 14 pages → 5 surfaces

```
┌─ MARKETS ────────────────────────────────────────────────┐
│  CoinGecko  /api/markets   prices, top-250 pool          │
│  DeFiLlama  /api/llama     chains, protocols, TVL        │
│  DexScreener /api/dex      pairs, orders, boosts         │
│  ← absorbs /tracker /llama /dex /trench (as tabs)        │
├─ SIGNALS (intelligence layer) ───────────────────────────┤
│  data-public /api/signals  scored/vetoed sighting feed   │
│  Khala       /api/khala    research reports              │
│  CryptoRank  enrichment    funding, unlocks, launchpool, │
│                            rwa, prediction, aioverview   │
│  ← absorbs /signals /scoreboard /khala                   │
├─ NEWS ───────────────────────────────────────────────────┤
│  Cointelegraph /api/news                                 │
│  ← absorbs /news  (CryptoRank news retired)              │
├─ TICKER ─────────────────────────────────────────────────┤
│  internal venue sweep        (unchanged, sole non-mirror)│
└─ CHAINRANK ──────────────────────────────────────────────┘
   pay-to-rank board          (kept as-is, low priority)
```

## 4. Per-page disposition

| page | verdict | action | rationale |
|---|---|---|---|
| `/cryptorank` | 🔴 **DROP page** | delete the page; keep the route as **headless enrichment** only | 11/28 modes are duplicates; no page should mirror cryptorank.io |
| `/tracker` | 🔴 **MERGE** | fold into **Markets** (CoinGecko tab) | price mirror superseded by `/api/markets` |
| `/llama` | 🟢 **MERGE** | fold into **Markets** (TVL/chain tab) | DeFiLlama is gold but belongs in Markets, not a standalone page |
| `/dex` | 🟢 **KEEP** (→ Markets tab) | keep, optionally a Markets tab | pairs + unique orders/boosts |
| `/trench` | 🟢 **KEEP** (→ Markets tab) | keep | live pair trench on the same provider |
| `/signals` | 🟢 **ELEVATE** | becomes the **Signals** hub | scored/vetoed feed = the intelligence layer |
| `/scoreboard` | 🟢 **MERGE** | make it a **Signals** tab | same provider (`data-public`), same envelope family |
| `/khala` | 🟢 **KEEP** (→ Signals tab) | keep or fold into Signals | unique qualitative research |
| `/news` | 🟢 **KEEP** | keep | Cointelegraph is the news source; retire CR news |
| `/chainrank` | 🟡 **KEEP as-is** | no change | novelty, tiny volume, zero effort |
| `/ticker` | 🟢 **KEEP** | no change | the only genuinely internal surface |
| `/`, `/login`, `/member` | — | no change | landing + auth |

Net: the ten provider pages collapse to **five surfaces** (Markets · Signals · News · Ticker ·
ChainRank), and CryptoRank leaves the page layer entirely, surviving only as headless
enrichment behind Signals.

## 5. CryptoRank demotion (28 → 15, and where the survivors go)

| CryptoRank mode | destination |
|---|---|
| `coins` `converter` `coin` `gainers` `losers` `chain` `tag` `ecosystem` | **drop** → CoinGecko (`/api/markets`) |
| `blockchains` | **drop** → DeFiLlama (`/api/llama`) |
| `ecosystems` (tvl half) | **drop** → DeFiLlama |
| `news` `newstag` | **drop** → Cointelegraph (`/api/news`) |
| `trending` `exchanges` `categories` `tags` `listings` (mixed) | **simplify** — keep only the unique part as enrichment |
| `launchpool` `nodesale` `rwa` `rwaasset` `prediction` `media` `aioverview` `quarterly` | **keep** → Signals enrichment (page-1 only) |
| `funding` `unlocks` | **refused** (leave 503) |

Result: CryptoRank the *page* dies; CryptoRank the *enricher* serves ~8 unique modes to Signals.
The "must defeat Cloudflare" dependency becomes optional and off the render path.

## 6. Migration order (small, verifiable steps)

1. **Stand up the Markets surface** from `/api/markets` + `/api/llama` + `/api/dex`; absorb
   `/tracker` + `/llama`. Verify pages 200 + envelopes unchanged.
2. **Make `/signals` the hub**; turn `/scoreboard` into a tab; fold `/khala`.
3. **Retire `/cryptorank` page**; move the 8 unique modes behind a Signals enrichment route
   (page-1-labelled).
4. **Point `/news`** at Cointelegraph only; drop the CryptoRank news mode.
5. Update `docs/architecture/source-catalog.md` + `data-catalog.md` row statuses to match.

Each step is a page/route change with a route-level check, not a data migration — no schema or
canonical-model change is implied by this map.

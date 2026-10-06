# CryptoRank Mode Audit (28 modes — uniqueness vs duplication)

Scope: the `cryptorank` acquisition family in `apps/data/internal/research/cryptorank/`,
served by the Go sidecar on `:3101` at `/api/cryptorank` and proxied by the Next route
`apps/web/src/app/(frontend)/api/cryptorank/route.ts`. Every row below was probed **live**
against the running sidecar; nothing is inferred from the mode table alone.

> **Snapshot caveat.** Counts and totals are a point-in-time read (2026-10-02, sidecar on
> `:3101`, `cache: MISS`). Upstream tables move (DeFiLlama chains were 467 on 2026-09-29 and
> 468 at capture; trending was 266 → 230). Re-run §0 to refresh; the *classification* is
> stable, the integers drift.

Companion documents: `docs/architecture/source-catalog.md` (which feeds exist),
`data-catalog.md` (per-dataset detail), `canonical-model.md` (entity names). This document is
the **per-mode disposition audit**: for each of CryptoRank's 28 modes, what it returns, how
much of upstream it actually covers, and whether a cheaper provider already serves the same
data.

## 0. Reproduce

```bash
# every mode, live (26 return 200; funding/unlocks are refused 503 by design)
MODES="home coins trending gainers losers funding unlocks categories exchanges coin listings \
blockchains chain launchpool nodesale news tags tag ecosystems ecosystem rwa rwaasset \
quarterly prediction converter media newstag aioverview"
for m in $MODES; do
  printf '%-14s ' "$m"
  curl -s -o "/tmp/cr-$m.json" -w 'HTTP %{http_code}  %{size_download}b\n' \
    --max-time 45 "http://127.0.0.1:3101/api/cryptorank?mode=$m"
done
```

## 1. How the family works (why it is the most expensive provider)

CryptoRank is **not an API** — it scrapes the `__NEXT_DATA__` SSR payload out of
`cryptorank.io` HTML pages. `api.cryptorank.io/v0/*` answers a Cloudflare managed challenge to
every non-browser client, and the market pages do the same unless the ClientHello really is
Chrome. The fetcher therefore carries a bespoke TLS stack: a **Chrome 131 fingerprint AND
HTTP/2, both required** (either alone → `403 cf-mitigated: challenge`). Source:
`apps/data/internal/research/cryptorank/fetch.go`.

Consequence: **26 live modes ride one pinned fingerprint.** When that profile goes stale,
every one of them 403s silently together — the `HardError{Kind: "cf-challenge"}` path exists
precisely to alarm on that.

## 2. Mode inventory (live)

| mode | what it returns | rows served | upstream total | coverage |
|---|---|---|---|---|
| `home` | global market aggregate + 6 funding rounds + 6 upcoming ICO | 12 | — | slice |
| `coins` | top coins by mcap (full coin row) | 100 | 100 | full |
| `trending` | trending widget | 10 | 230 | 4% |
| `gainers` | 24h gainers | 150 | 150 | full |
| `losers` | 24h losers | 150 | 150 | full |
| `categories` | one category's coins + breadth | 100 | — | page-1 |
| `exchanges` | CEX/DEX/perps volume table | 50 | — | page-1 |
| `coin` | one coin detail (fdv, supply, ath/atl, listing) | 1 | — | full |
| `listings` | recentlyAdded / mostSearched / mostVisited widgets | 60 | — | 3×20 |
| `blockchains` | chain directory (slug feed for `chain`) | 278 | 278 | full |
| `chain` | one chain's token ecosystem | 3461 | 3461 | full |
| `launchpool` | launchpool events (past/active/upcoming) | 50 | 528 | 9.5% |
| `nodesale` | node-sale events | 20 | 66 | 30% |
| `news` | news aggregator feed (links out) | 10 | — | page-1 |
| `tags` | tag taxonomy + breadth stats | 182 | 182 | full |
| `tag` | one tag's coins | 324 | 324 | full |
| `ecosystems` | ecosystem index (projects/mcap/tvl) | 20 | 106 | 19% |
| `ecosystem` | one ecosystem's coins | 30 | 1074 | 2.8% |
| `rwa` | RWA assets (tokenized price/mcap/volume) | 25 | 210 | 12% |
| `rwaasset` | one RWA detail (country, exchange, sector, industry) | 1 | — | full |
| `quarterly` | BTC 16y + ETH 12y quarterly open/close | 28 | — | full |
| `prediction` | prediction markets + platform aggregates | 20 | 48259 | 0.04% |
| `converter` | full price list (price only) | 5352 | 5352 | full |
| `media` | YouTube video aggregator | 10 | 468 | 2% |
| `newstag` | one news tag's articles | 5 | 5 | full |
| `aioverview` | upstream AI digest (market/news/funding/vesting) | 12 | — | full |
| `funding` | **REFUSED 503** — upstream serves synthetic decoy | 0 | — | — |
| `unlocks` | **REFUSED 503** — upstream serves synthetic decoy | 0 | — | — |

Row shapes are in `apps/data/internal/research/cryptorank/types.go` (`CrEnvelope` +
per-family structs). Two refusal modes carry the verbatim reason string
(`DisabledReason`, `modes.go`): upstream `/_next/data` fabricates payloads for nonexistent
slugs and prices diverge from ground truth (measured 57k–67k vs real 84.5k BTC).

## 3. Classification

Legend: **DUP** = fully served by a cheaper provider · **UNIQUE** = no cheaper source ·
**MIXED** = taxonomy/coverage is unique but the payload's data is duplicated · **REFUSED** =
deliberately off.

| verdict | modes | count |
|---|---|---|
| 🔴 **DUP** | `coins` `converter` `coin` `gainers` `losers` `blockchains` `chain` `tag` `ecosystem` `news` `newstag` | 11 |
| 🟢 **UNIQUE** | `launchpool` `nodesale` `rwa` `rwaasset` `prediction` `media` `aioverview` `quarterly` | 8 |
| 🟡 **MIXED** | `listings` `tags` `categories` `ecosystems` `exchanges` `trending` `home` | 7 |
| ⛔ **REFUSED** | `funding` `unlocks` | 2 |

### 3.1 Duplicated (11) — cheaper provider already serves it

| mode | duplicated by | evidence |
|---|---|---|
| `coins`, `gainers`, `losers`, `converter`, `coin` | CoinGecko `/coins/markets` (`/api/markets`, pool 250) | BTC price CR `$86,366.91` vs CG `$86,586` — **0.25%** apart; same data |
| `blockchains` | DeFiLlama `/v2/chains` (`/api/llama?mode=chains`) | CR lists **278** chains, DeFiLlama **468** — the free source is more complete |
| `chain`, `tag`, `ecosystem` | CoinGecko category/chain endpoints | same "coins of a category" concept, CR truncates (`ecosystem` = 30 of 1074) |
| `news`, `newstag` | Cointelegraph RSS (`/api/news`) | CR `news` links out to publishers; the RSS feed is the same class of data, keyless |

### 3.2 Unique (8) — CryptoRank is the only source

`launchpool`, `nodesale`, `rwa`/`rwaasset` (tokenized equities/bonds/commodities with a
`tokenizedPriceUsd` alongside the underlying quote), `prediction` (prediction-market
aggregates: volume, open interest, per-platform split), `media` (YouTube research-video
aggregator), `aioverview` (CryptoRank's own generated market digest), `quarterly`
(BTC/ETH quarterly returns). No other provider in this repo carries these.

### 3.3 Mixed (7) — unique framing, duplicated payload

- `listings` — `mostSearched` / `mostVisited` are CryptoRank **traffic** signals (proprietary);
  the coin rows themselves are the same `CrCoin` shape as `coins`.
- `tags` / `categories` — the taxonomy + breadth stats are CR's; the coin lists are dup.
- `ecosystems` — `projects`/`projectsChange3m` counts are unique; `tvlUsd` duplicates DeFiLlama.
- `exchanges` — CoinGecko `/exchanges` covers CEX volume; CR's `percentVolume` methodology is
  its own.
- `trending` — the concept duplicates CoinGecko trending; the ranking method differs.
- `home` — global market cap/dominance duplicates any market aggregator; the **funding-round
  slice is unique but truncated to 6 rows** (the full board is WAF-challenged).

## 4. Structural findings

1. **Only ~8 of 28 modes carry unique data.** Eleven are pure duplicates of
   CoinGecko/DeFiLlama/Cointelegraph; seven more duplicate the payload behind a unique label.

2. **Every unique mode is truncated at page 1 — upstream ignores `?page=`.**
   The SSR payload ships page 1 only, so the modes that justify the provider return a sliver:

   | mode | served | total | coverage |
   |---|---:|---:|---:|
   | `prediction` | 20 | 48,259 | **0.04%** |
   | `media` | 10 | 468 | 2% |
   | `launchpool` | 50 | 528 | 9.5% |
   | `rwa` | 25 | 210 | 12% |
   | `ecosystems` | 20 | 106 | 19% |
   | `nodesale` | 20 | 66 | 30% |

   Consequence: scraping CryptoRank **cannot produce the full dataset** for its own unique
   families. Full coverage needs `api.cryptorank.io` — the surface that is WAF-gated hardest.

3. **Blast radius.** 26 modes share one Chrome-131 TLS pin; a stale profile 403s all of them
   at once, for ~8 modes of data that (per finding 2) is already incomplete.

## 5. Disposition

| action | modes | rationale |
|---|---|---|
| **Drop** | the 11 DUP modes | 100% served by CoinGecko / DeFiLlama / Cointelegraph — keyless, stable, no CF bypass |
| **Simplify** | the 7 MIXED modes | keep the unique part (taxonomy, `mostSearched`/`mostVisited`, `projects` count), drop the duplicated coin lists |
| **Keep, label "page-1 only"** | the 8 UNIQUE modes | the only value CryptoRank adds; never present as a full dataset |
| **Keep refused** | `funding`, `unlocks` | upstream decoy; leave the 503 in place |

Net: the CryptoRank surface goes **28 → ~15 modes**, and the "must defeat Cloudflare"
dependency becomes **optional** — needed only for unique enrichment, never for prices that
CoinGecko already serves.

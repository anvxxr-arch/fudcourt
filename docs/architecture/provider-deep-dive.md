# Provider Data Deep-Dive (non-CryptoRank families)

Live-probed shapes and uniqueness verdicts for every acquisition family **other than**
CryptoRank. Companion to `cryptorank-mode-audit.md` (that provider's 28 modes) and to
`source-catalog.md` (which is a static code-walk; this document is a **live capture** of the
running sidecar on `:3101`).

Snapshot: 2026-10-02, sidecar `:3101` (Go), Next proxy `:3100`. Reproduce any block with the
`curl` in its header.

## 0. The seven families

| family | route | upstream | auth | modes |
|---|---|---|---|---|
| `llama` | `/api/llama` | `api.llama.fi` | keyless | chains, protocols, historical |
| `markets` | `/api/markets` | `api.coingecko.com/api/v3` | keyless (demo tier) | 1 (pool of 250) |
| `dex` | `/api/dex` | `api.dexscreener.com` | keyless | 8 types |
| `signals`/`scoreboard` | `/api/signals` | `data-public.vercel.app` | keyless | index, feed, page, scoreboard |
| `news` | `/api/news` | `cointelegraph.com/rss` | keyless | 1 feed |
| `khala` | `/api/khala` | `khala.io` | keyless | reports, report, latest |
| `chainrank` | `/api/chainrank` | `chainrank.fyi` | keyless | stats, listings |

**None of these needs a Cloudflare-bypass fingerprint** — every one answers a plain HTTP
client. That single fact is the whole argument of the consolidation map (see
`provider-consolidation.md`).

---

## 1. DeFiLlama — `api.llama.fi` (keyless)

`curl "http://127.0.0.1:3101/api/llama?mode=chains"`

- **`chains`** → **468 rows**, `{gecko_id, gasTokenGeckoId, tvl, tokenSymbol, cmcId, name, chainId}`.
  Upstream sends **unsorted**; the sidecar sorts `tvl desc`. Ethereum `tvl` = `$54,525,363,475`.
- **`protocols`** → upstream total **8,464**; sidecar trims to head 50 (upstream body is 8.9 MB).
  Row: `{name, slug, category, tvl, change_1d, change_7d, mcap, chains[], url, logo}`.
  Row0 = `Binance CEX`, `tvl $180.9 B`.
- **`historical`** → **3,293** daily points `{date, tvl}`; `?days=N` takes the **last N** (upstream
  is oldest-first).

**Verdict: KEEP — gold standard.** Keyless, stable, deepest chain/TVL coverage in the repo.
It is the correct source for chain lists and TVL, and it **supersedes** CryptoRank `blockchains`
(278) and the `tvlUsd` half of CryptoRank `ecosystems`.

**Caveat:** `protocols` is 8.9 MB upstream — do not pull it on a hot path; the trimmed head is
what the route serves.

---

## 2. CoinGecko — `api.coingecko.com/api/v3` (keyless, demo tier)

`curl "http://127.0.0.1:3100/api/markets?limit=3"`

- One pooled upstream call: `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=24h`.
- Envelope: `{coins[250], total:250, limit, offset, hasMore, timestamp, pool:250, upstreamTotal:250, derived:"local search/sort/pagination over CoinGecko top 250 by market cap"}`.
- Coin row: `{symbol, baseAsset, quoteAsset, name, image, lastPrice, priceChangePercent, highPrice, lowPrice, volume, quoteVolume, marketCap, rank, count}`.
- Row0 = `BTC $86,586`, `mcap $1,739,315,580,661`.

**Verdict: KEEP — the consolidated price layer.** One cached fetch of the top-250 pool then
**local** search/sort/paginate means every price query is served without a new upstream call.
It **supersedes** CryptoRank `coins` `gainers` `losers` `converter` `coin` `chain` `tag`
`ecosystem` (all price/coin lists; measured 0.25% apart on BTC).

**Caveat:** fixed pool of **250** — a coin outside the top 250 is not in the envelope. That is
the one gap vs CryptoRank `converter` (5,352 symbols), but converter is price-only and available
from CoinGecko `/simple/price` on demand.

---

## 3. DexScreener — `api.dexscreener.com` (keyless, rate-limited)

Eight types, each with its own upstream path:

| type | upstream | rows | note |
|---|---|---|---|
| `profiles` | `/token-profiles/latest/v1` | 30 | `{address, chain, symbol, icon, header, description, links, amount, totalAmount, url}` |
| `boosts` | `/token-boosts/latest/v1` | 30 | same shape, paid promotion |
| `boosts-top` | `/token-boosts/top/v1` | 30 | same shape, paid promotion |
| `search` | `/latest/dex/search?q=` | 30 | **no chain filter upstream** — 16 chains seen; local filter + `chainsSeen` |
| `tokens-v1` | `/tokens/v1/{chain}/{addr}` | pairs | **200 with `[]`** for an invalid address → rejected locally 400 |
| `tokens` | `/latest/dex/tokens/{addr,…}` | 30 | up to **30** comma-separated addresses |
| `token-pairs` | `/token-pairs/v1/{chain}/{addr}` | 30 | pairs for one token |
| `orders` | `/orders/v1/{chain}/{addr}` | 10 | `{chainId, tokenAddress, type, status, paymentTimestamp}` — **paid-promo orders** |

Pair row: `{chainId, dexId, url, pairAddress, labels, baseToken, quoteToken, priceNative, priceUsd, txns, volume, priceChange, liquidity, fdv, marketCap, pairCreatedAt, info}`.

**Verdict: KEEP — pairs + a unique paid-promotion surface.** `orders` / `boosts` are
DexScreener-proprietary (who paid to promote what); no other provider here has it. Pair data
overlaps CoinGecko for DEX pairs but adds per-pair `liquidity`, `txns` and `fdv`.

**Caveats (already handled in code):** bursts → `429 Cloudflare 1015`; routed through the
shared limiter/cache. Search is capped at 30 and has no server-side chain filter; invalid
addresses must be rejected before the upstream call.

---

## 4. data-public.vercel.app — the signal feed (keyless)

`curl "http://127.0.0.1:3100/api/signals?type=feed&limit=3"`

- **`index`** ≈ **2.8 MB**, **`feed`** ≈ **368 KB**, envelope
  `{v, chain, page, pages, pageRows:500, generatedAt, windowH:24, solDelayMin, counts:{rows,rh,sol,surfaced,runs,revivals}, rows[]}`.
- Row: `{ts, kind(vetted|gradspike), mint, symbol, name, image, url, decision, score, mcap, price, liq, ageMin, source(paid|volume|signal), vetoes[], volTrend, nameReuse, persistCount, sightings}`.
  Example row0: `poot/pootcoin`, `decision:"vetoed"`, `score:20.5`, `source:"paid"`,
  `vetoes:["liquidity $1 < $9,000", "SCAM pattern: 0.0d-old launch…", "sells dominating…"]`.
- **`scoreboard`** ≈ 6 KB, `{v, kind, generatedAt, cohortDays:3, chains:{solana, robinhood}}`.

**Verdict: KEEP — ELEVATE. This is the crown jewel.** It is *not* raw market data: it is already
a **scored, vetted, and vetoed** token-sighting product with explicit reasons (`vetoes[]`),
a provenance tag (`source`), and cluster/RH-vs-SOL counters. This maps directly onto a
canonical `Signal` entity (`canonical-model.md`) and is the natural seed of the intelligence
layer — no other provider gives decisions, only numbers.

**Caveat:** `index` is 2.8 MB — page it (`feed` + `page`), never fetch `index` on a render path.

---

## 5. Cointelegraph RSS — `cointelegraph.com/rss` (keyless)

`curl "http://127.0.0.1:3101/api/news?limit=3"`

- ~30–100 items, `{title, link, description, pubDate, image, source}` (~340 KB XML upstream).
- **Verdict: KEEP — cheap news.** Class-duplicate of CryptoRank `news` (both are aggregator
  feeds), but this one is keyless and needs no fingerprint. If news is kept, keep **this** one.

---

## 6. Khala — `khala.io` (keyless)

`curl "http://127.0.0.1:3101/api/khala?mode=latest"`

- Modes: `reports`, `report`, `latest`. `latest` → **5 of 8** reports,
  `{position, slug, title, summary, url, published, publishedISO}`.
- Khala publishes **research reports only** — `/news`, `/rss.xml`, `/feed` all **404**
  (measured 2026-09-29). `latest` *is* the news surface. Dates resolved by fetching each report
  page (disk-cached, ETag-revalidated).
- **Verdict: KEEP — unique qualitative research.** 8 deep-dive reports, not news; complements
  the quantitative feeds. Small but orthogonal.

---

## 7. ChainRank — `chainrank.fyi` (keyless)

`curl "http://127.0.0.1:3101/api/chainrank?mode=stats"`

- **`stats`** → `{online:0, totalClicks:22, listings:1, totalUsdCents:508, topUsdCents:508, claimTopCents:1100}`.
- **`listings`** → paginated verbatim, row `{id, key, kind, url, handle, title, description, logoUrl, totalUsdCents, clicks, ownerAddress, lastPaidAt, createdAt, rank}`.
- **Verdict: KEEP as a novelty.** A pay-to-rank leaderboard (money ≠ merit, by design). Tiny
  volume (1 listing, $5.08) and pure fun; no consolidation pressure, but low priority.

---

## 8. Cross-provider overlap (summary)

| data | duplicated by | keep |
|---|---|---|
| chain list + TVL | CryptoRank `blockchains` (278) **⊂** DeFiLlama `chains` (468) | **DeFiLlama** |
| coin prices / lists | CryptoRank `coins/gainers/losers/converter/coin/chain/tag/ecosystem` **⊂** CoinGecko markets | **CoinGecko** |
| news feed | CryptoRank `news` ≈ Cointelegraph RSS | **Cointelegraph** |
| DEX pairs | CoinGecko (basic) **⊂** DexScreener (per-pair liquidity/txns/fdv) | **DexScreener** |
| paid promotions | — | **DexScreener** (unique) |
| alpha signals / scores | — | **data-public** (unique) |
| research reports | — | **Khala** (unique) |
| pay-to-rank board | — | **ChainRank** (unique) |

**Headline:** unlike CryptoRank (11/28 modes pure duplicates), the other seven providers are
almost entirely **unique or gold-standard**. The consolidation should lean on them and trim
CryptoRank, not the reverse. The map is in `provider-consolidation.md`.

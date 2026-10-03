# CoinMarketCap — Data-Type Inventory (endpoint map + the keyless path)

Recon for the **eighth** `fudcourt-data` acquisition family. Captured live
**2026-10-03** by probing `https://api.coinmarketcap.com/data-api/v3` directly,
alongside the candidate sweep that chose this provider over three alternatives.

## 1. Two surfaces

| | Official Pro API | Dashboard backend (**this family**) |
|---|---|---|
| Base URL | `https://pro-api.coinmarketcap.com` | `https://api.coinmarketcap.com/data-api/v3` |
| Auth | `X-CMC_PRO_API_KEY` header — **issued, billed per credit** | **none at all** |
| Docs | `coinmarketcap.com/api/documentation/v1/` | reverse-engineered from the dashboard's own XHR |
| Envelope | `{"status":{...},"data":{...}}` | `{"status":{...},"data":{...}}` |

The documented host and the dashboard host are **different products**, not two
transports for one dataset: the pro API needs a human-issued key with a credit
quota, and the dashboard backend takes no credential whatsoever. Only the second
is reachable without procurement, so only the second is wired. **The pro API is
deliberately NOT wired** — it would need a key this repo does not have and must
not silently acquire.

## 2. Why this is the THIRD distinct keyless mechanism

Three families now read a "keyless" upstream, and they are keyless for three
*different* reasons. Keeping them apart is the point — a reader must not assume
one scheme covers all three.

| family | host | what the gate actually is | what the client does |
|---|---|---|---|
| `coinglass` | `capi.coinglass.com` | an **encrypted body** (`AES-128-ECB` + gzip, rotating `v` header) | **decrypts** |
| `coinank` | `api.coinank.com` | a **request header** computed in the browser bundle | **computes a signature** |
| `coinmarketcap` | `api.coinmarketcap.com` | **nothing** | **plain GET, no credential** |

## 3. Endpoint probe matrix (live, 2026-10-03)

Kept only if it returned real, non-empty data.

| mode | path | shape | result |
|---|---|---|---|
| `listing` | `/cryptocurrency/listing?start&limit` | array `data.cryptoCurrencyList` | **200**, 101 rows at `limit=100` |
| `global` | `/global-metrics/quotes/latest` | **object** `data` | **200**, object (no array) |
| `marketPairs` | `/cryptocurrency/market-pairs/latest?slug&start&limit` | array `data.marketPairs` | **200**, 100 rows for `bitcoin` |
| `exchanges` | `/exchange/listing?start&limit` | array `data.exchanges` | **200**, 100 rows |

## 4. The failure modes are quiet — each handled explicitly

CoinMarketCap does not use HTTP status codes to refuse. **Every refusal below
arrives with HTTP 200**, which is why the status object is carried verbatim and
read by the adapter.

| probe | upstream answer | what the family does |
|---|---|---|
| `marketPairs` with no `slug` | 200, `status.error_code="400"`, a raw validation string | **400** locally — names the fix, never forwards |
| unknown slug | 200, `error_code="500"`, `"The system is busy, please try again later!"` | **502 `upstream refused`** carrying code+message |
| `limit=abc` / `limit=-1` | 200, `error_code="500"`, same "busy" message | **400** locally — refused before the fetch |
| **`limit=0`** | 200, `error_code="0"`, `{"cryptoCurrencyList":[],"totalCount":"8138"}` | **400** locally — see §5 |
| `limit=99999` | 200, **9,643,042 bytes** | **400** locally — bounded at the door |
| `?bogus=1` (unknown param) | 200, the ordinary listing — **the param is IGNORED** | **400 `unexpected param`** — see §6 |

## 5. The `limit=0` trap (why the bounds are LOCAL)

`limit=0` is the hazard this family exists to refuse. Upstream answers it with a
**success** envelope — `error_code "0"` — carrying an **empty list** next to
`totalCount:"8138"`. Nothing in that response distinguishes *"you asked for zero
rows"* from *"this market has no coins"*. A pass-through endpoint would render it
as a confident empty board.

The bounds are therefore enforced **locally** and never sent upstream:

```
limit in [1, 1000]      (default 100)   -- the dashboard's own page size
start in [1, 100000]    (default 1)
```

Out-of-range or non-integer values are a local **400 `invalid param`**, and the
body's `detail` names the accepted range and the reason, generated from the same
constants the validator uses so the two cannot drift.

## 6. Params upstream IGNORES (why the scoping matrix is enforced here)

`?bogus=1` on the listing returns the ordinary listing — upstream does not reject
an unrecognised query param. A pass-through that accepted anything would report
success for a request it did not honour, so the param-scoping matrix is enforced
in the handler: a param the mode does not accept (an unknown name, **or a known
param sent to the wrong mode**) is **400 `unexpected param`**.

| mode | accepts |
|---|---|
| `listing` | `mode`, `start`, `limit`, `fresh` |
| `global` | `mode`, `fresh` (no pagination) |
| `marketPairs` | `mode`, `slug`, `start`, `limit`, `fresh` |
| `exchanges` | `mode`, `start`, `limit`, `fresh` |

## 7. Envelope

```
{kind, upstream, fetchedAt, auth, [slug], [start], [limit],
 [upstreamCode], [upstreamMsg], [upstreamCount], data, derived}
```

- `data` is upstream's `data` **verbatim** — the family invents no second
  vocabulary for data it did not author.
- `auth` is always the same sentence: `keyless dashboard endpoint, no credential,
  no signature`.
- `upstreamCount` is present **only for an array** payload, and **ABSENT** for the
  object payload (`global`) — a `0` there would assert a count upstream never
  published.
- `start`/`limit` are echoed only by the paginated modes; `slug` only by
  `marketPairs`.
- Cache is **header-only** (`X-CMC-Upstream`, `X-CMC-Cache`, `Cache-Control:
  public, max-age=30`), never a body key — the same shape as the CoinGlass and
  CoinAnk siblings.

## 8. Candidates that died in the sweep

Three other keyless dashboards were probed first and dropped rather than shipped:
`api.coinalyze.net` (401 — needs a key), `api.coinstats.app` (404 on the
dashboard path), `coincodex.com/api` (blocked). CoinMarketCap's
`data-api/v3` was the only one that answered real data with no credential.

## 9. Verification

```
python3 scripts/verify/verify-coinmarketcap.py    # 70 pass / 0 fail / 0 skip
```

The verifier is an **oracle**, not a mirror: it fetches
`api.coinmarketcap.com/data-api/v3` **directly** and compares row counts against
the adapter's response, so the adapter is never the source of truth about
upstream.

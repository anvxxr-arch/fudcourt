# apicalls

Standalone Go port of the CryptoRank read proxy that used to run as
`apps/web/scripts/oracle/cr_fetch.py` (curl_cffi subprocess) + `apps/web/lib/shapers.ts`
(TypeScript shapers) + `apps/web/app/api/cryptorank/route.ts` (HTTP surface).

It is **field-for-field compatible** with the TypeScript route, so the two can be
diffed against the same goldens and cut over without a client change. The precise
guarantee, because "byte-for-byte" would be an overclaim:

* every field name and value matches (26/26 fixture parity: semantic deep-equal
  against the frozen TS envelopes, plus a canonical re-marshal byte compare);
* numbers render identically (both use shortest round-trip; `100` stays `100`);
* strings escape identically -- HTML characters are **not** escaped, as in
  `JSON.stringify` (see [JSON escaping](#json-escaping));
* absent-vs-null is preserved (TS `undefined` keys are omitted, TS `null` keys are
  present as `null`);
* **JSON key order is NOT guaranteed.** The Go body uses struct/field order
  (identical between two Go responses, so it is deterministic); the TS body uses
  object-literal insertion order. The frozen goldens are key-*sorted* by their
  generator, so neither whole-body byte equality nor golden-vs-live byte equality
  is what the tests assert. Consumers must not depend on key order.
* one framing difference: the Go body ends with a single `"\n"` after the JSON
  value (`Encoder.Encode`), i.e. one trailing newline. A body is otherwise the
  same bytes for the same values.

It binds loopback only. The public ingress is still the Cloudflare tunnel to the
Next app; `apicalls` is a sidecar, not an origin.

## Run

```sh
cd services/data
go build -o bin/apicalls ./cmd/apicalls
APICALLS_ADDR=127.0.0.1:3101 ./bin/apicalls
```

| env | default | meaning |
| --- | --- | --- |
| `APICALLS_ADDR` | `127.0.0.1:3101` | listen address (loopback only by design) |
| `APICALLS_CACHE_DIR` | `~/.cache/crfetch` (the Python helper's dir; the deploy unit sets `~/.cache/apicalls` — see below) | on-disk fetch cache |
| `APICALLS_TTL` | `60` | per-route cache TTL in seconds; `?fresh=1` forces TTL 0 for that request |
| `APICALLS_LLAMA_TTL` | `15` | in-process TTL in seconds for the llama family (read at startup; `top`/`days` share one upstream entry) |
| `APICALLS_NEWS_TTL` | `15` | in-process TTL in seconds for the news feed (read at startup; keyed on the FEED URL, so every `limit` shares one read) |
| `APICALLS_CHAINRANK_TTL` | `15` | in-process TTL in seconds for the chainrank reads (read at startup; keyed on the full upstream URL) |

### Cache directories: keep the oracle's cache separate

`APICALLS_CACHE_DIR` must **not** point at the Python helper's `~/.cache/crfetch`
in production. `verify-cryptorank.py` is only worth having because it is an
independent second client: if it and the Go service share a cache directory, a run
where the oracle "confirms" a payload can be reading bytes the Go side wrote --
self-confirmation instead of a cross-check. Separate caches (the unit sets
`~/.cache/apicalls`) keep that second fetch real.

The volume argument for sharing is moot once Go is the only serving path: after
the cutover `/api/cryptorank` is a pure proxy, so the Python helper only runs
inside `verify-cryptorank.py` / `record-fixtures.ts` (operator-driven), not on
page mount. The `~/.cache/crfetch` default only matters for a deliberate
side-by-side comparison, where sharing HITs is the *unwanted* behaviour anyway.

The toolchain is pinned in `go.mod` (`go 1.24.1`) because both dependencies
declare it. The workstation's `go 1.23.3` with `GOTOOLCHAIN=auto` uses the cached
`go1.24.1`; **the deploy image must ship Go >= 1.24.1 or allow the toolchain
download**.

## HTTP contract (frozen)

* `GET /api/cryptorank?mode=<mode>[&key=<slug>][&fresh=1]` -> `200`, same field
  names and values as the TS route's
  `envelope(mode, helperOut, {key, upstream})`. Headers: `X-CR-Upstream`,
  `X-CR-Cache: MISS|HIT`, `Cache-Control: public, max-age=30`,
  `Content-Type: application/json`.
* `GET /healthz` -> `200 {"ok":true,"build":"28 modes","khala":"3 modes","llama":"3 modes","news":"1 feeds","chainrank":"2 modes"}`.
  `build` stays the cryptorank count (every existing gate asserts that string); each
  further family reports its own key rather than being folded into it.
* `GET /api/khala?mode=<reports|report|latest>[&key=<slug>][&limit=1..50][&fresh=1]`
  -> the khala research-report envelope (DR-006): `X-KH-Upstream`, `X-KH-Cache`,
  `Cache-Control: public, max-age=30`. Strict 400s for an unknown mode, a missing/invalid
  `key` on `mode=report`, a bad `limit`, and any param a mode does not accept.
* `GET /api/llama?mode=<chains|protocols|historical>[&top=1..200][&days=1..3288]`
  -> the DeFiLlama envelope: `{kind,rows,upstream,fetchedAt,upstreamTotal,derived}` with
  `X-Cache: MISS|HIT` (15s in-process TTL + single-flight). `top`/`days` are OUR params:
  strict 400s (`"<name> must be an integer, got '<raw>'"` / `"<name> must be between 1 and
  <max>, got <v>"`), never clamped.
* `GET /api/chainrank?mode=<stats|listings>[&page=<n>][&pageSize=<n>]`
  -> chainrank.fyi's own envelope with `kind`/`upstream`/`fetchedAt` stamped on,
  `X-Cache: MISS|HIT|COALESCED` (15s in-process TTL + single-flight, keyed on the
  FULL upstream URL). Pagination is relayed UNTOUCHED into that URL: upstream
  clamps `page<1` to 1 and caps `pageSize` at 200, and relaying its own answer is
  the point — a local clamp would be indistinguishable from upstream's. A 200
  whose body lacks the rendered fields (any `null`/string stat, `rows` not an
  array) is a loud 502. Write endpoints (`/api/click|presence|claim/*|upload`)
  are deliberately NOT served here.
* `GET /api/news?source=<cointelegraph>[&limit=1..100]`
  -> the RSS envelope `{items,total,upstream,timestamp}` with `X-Cache: MISS|HIT` (15s
  in-process TTL + single-flight, keyed on the FEED URL, so two different `limit`s share
  one upstream read). `total` is the FULL parsed item count while `items` is the `limit`
  head. `source`/`limit` are OUR params: strict 400s (`"unknown source '<s>'"` with
  `detail: "expected one of cointelegraph"`, `"limit must be an integer, got '<raw>'"`,
  `"limit must be between 1 and 100, got <v>"`), never clamped and never coerced into an
  empty 200. An empty feed is a loud `502`, not an empty list.
* Errors use the TS field names exactly:
  * `400` unknown mode -- `{"error":"unknown mode","modes":[...28...],"got":<mode|null>}`
  * `400` invalid key -- `{"error":"invalid key","detail":...,"mode":...,"key":...}`
    (`rwaasset` needs `<plural-type>/<slug>` in `bonds|commodities|etfs|stocks`)
  * `400` invalid exchange / launchpool / nodesale list -- `{"error":"invalid <x> list","detail":...,"allowed":[...],"mode":...,"key":...}`
  * `404` upstream miss -- `{"error":"upstream 404: no such resource","mode":...,"key":<key|null>,"upstreamStatus":404}`
  * `404` newstag soft-404 -- `{"error":"upstream ships tag:null for this slug (soft-404) -> no such tag",...}`
  * `502` wall/error -- `{"error":<real upstream or transport text>,"upstreamStatus":<code|null>,"upstream":...,"kind":<mode>}`
  * `503` disabled mode -- `{"error":<CR_DISABLED_REASON>,"kind":...,"disabled":true,"upstream":...,"reverify":...}`

Input is never clamped and no payload is ever synthesised: a missing expected
upstream slice raises the same ~18 loud refusals the TS shapers raise, and the
route reports a `502` rather than an empty envelope.

### JSON escaping

Responses are written with HTML escaping **off**, matching `JSON.stringify`:
`<`, `>` and `&` stay literal instead of becoming `\u003c`, `\u003e`, `\u0026`.
This is load-bearing for the prose/URL fields (news and media titles, aioverview
summaries, ecosystem descriptions, tag and coin names -- the recorded ecosystem
fixture alone carries 59 such characters).

`json.Encoder.SetEscapeHTML(false)` at the top level is necessary but **not
sufficient**: values that pass through a nested `MarshalJSON` were already
encoded by `json.Marshal` inside that method, and the outer encoder's `compact`
pass can only add escapes, never remove them. Every nested marshaler in
`internal/cryptorank` therefore encodes with escaping off too, and
`internal/paritytest` drives the **real HTTP writer** over all 26 recorded
fixtures, failing if either half regresses (it asserts the served body contains no
`\u003c`/`\u003e`/`\u0026` while 10 of the fixtures do contain raw `<` or `&`).

## Why this exists: the two-dependency stack

`api.cryptorank.io/v0/*` answers a Cloudflare managed challenge to **every**
non-browser TLS client, and so do the market pages unless the ClientHello really
is Chrome. Two things are required **together** -- a Chrome 131 TLS fingerprint
and HTTP/2. Either alone still gets `403` with `cf-mitigated: challenge`.

Measured on 2026-09-29 in `/home/dwizzy/apicalls-probe` (`RESULTS.txt`, and
re-measured by this service's live test):

| variant | TLS stack | proto | status | bytes |
| --- | --- | --- | --- | --- |
| A/B plain `crypto/tls` + Chrome headers (+ h2 SETTINGS) | Go | h2 | 403 | 5979 |
| C1 uTLS `HelloChrome_131`, HTTP/1.1 only | uTLS | h1 | 403 | 6022 |
| C2 uTLS `HelloChrome_131` + h2 | uTLS | h2 | **200** | 738673 |
| D `tls-client` `profiles.Chrome_131` | fhttp+utls | h2 | **200** | 738673 |
| Python `curl_cffi` `impersonate=chrome131` (baseline) | BoringSSL | - | **200** | - |

```go
require (
    github.com/bogdanfinn/tls-client v1.16.0 // the curl_cffi analogue
    github.com/bogdanfinn/fhttp v0.6.9       // ordered headers + h2 transport
)
```

`fhttp` is a direct dependency because tls-client speaks it; there is no
`net/http` transport behind it. Header **order** was measured *not* to matter
(variant C2b, no `HeaderOrderKey`, still 200), but a Chrome-like order is kept
for durability.

Two behavioural details that are load-bearing and easy to lose in a port:

* **Redirects must be followed.** `curl_cffi`'s `requests.get` follows them, and
  the Python helper depends on it: `/news/tag/<unknown>` answers `307 -> 200`
  with `tag:null`, which is the soft-404 marker the route turns into a local
  `404`. A client with `WithNotFollowRedirects` reports `502 upstream 307`
  instead (measured).
* **The disk cache is the politeness mechanism.** `~/.cache/crfetch` with a 60s
  TTL is what keeps request volume low; it is reimplemented here (atomic
  tmp+rename writes, buildId cached separately with an hourly TTL and a
  refresh-once-on-404).

## Alarmable-failure rule

A Cloudflare wall is a **hard, alarmable** failure, never "no data". If the
pinned `profiles.Chrome_131` ever goes stale, every fetch starts returning the
challenge page; if that page were parsed as an empty payload the board would
render zeros and nobody would notice.

* `403` + `cf-mitigated: challenge` -> `\*cryptorank.HardError{Kind:"cf-challenge"}`
  with a distinct error string, reported as `502`.
* A `200` body containing `Just a moment` and no `__NEXT_DATA__` -> the same
  hard error (a challenge interstitial served with a 200).
* A transport failure -> `\*cryptorank.HardError{Kind:"transport"}` with the real
  error text.
* Every hard failure is logged as `apicalls: ALARM <kind> <url>: ...`.

A `429` is *not* a hard failure: it is the transient burst limiter, so the same
fetch is retried up to 3 attempts with `3s x (attempt+1)` backoff before a real
verdict is returned (the TS route's policy).

Other reliability work beyond the Python original:

* **Single-flight per cache key** -- a board mount firing 9 modes makes one
  upstream request per route, not nine. `fresh=1` (ttl 0) deliberately bypasses
  single-flight: a fresh request must never be satisfied by an in-flight cached
  fetch.
* **TTL is a per-call argument, not fetcher state** -- `Fetcher.Fetch(ctx, route,
  target, ttl)`. It used to be a `SetTTL` field on the fetcher, which meant two
  concurrent requests with different `fresh` values could interleave and a
  `fresh=1` request could be served a stale `HIT` (or an ordinary request could
  bypass the cache). The value now travels with the call.
* **Cache writes use a unique temp name** (`<name>.<random>.tmp` + rename, same
  directory so the rename stays atomic). The Python helper's fixed `.tmp` path
  breaks once fresh requests can write the same key concurrently: two writers
  raced the rename and one failed with `no such file or directory`.
* **Configurable cache dir** via `APICALLS_CACHE_DIR`.

## Verify

```sh
cd services/data

# 1. build + vet + tests
go build ./... && go vet ./... && go test ./...

# 2. fixture parity: 26/26 modes deep-equal to the frozen TS output
go test ./internal/cryptorank/ -run TestParity -v
#    reads ../../apps/web/scripts/fixtures/<mode>.json.gz (raw HelperOut) and
#    ../../apps/web/scripts/fixtures/expected/<mode>.json (TS envelope() output,
#    generated by apps/web/scripts/tools/dump-envelopes.ts). Comparison is semantic
#    (unmarshal + deep-equal) and additionally reports any key present on one
#    side only.

# 3. served-bytes parity: the REAL HTTP writer over all 26 fixtures
#    (catches encoder-level divergence the in-memory compare cannot see)
go test ./internal/paritytest/ -v

# 4. live smoke: real upstream, 5 requests, spaced 2s
./scripts/smoke-apicalls.sh

# 5. live stack proof + the loud challenge arm (2 upstream requests)
APICALLS_LIVE=1 go test ./internal/cryptorank/ -run TestLive -v -timeout 180s
```

The parity oracle is only as good as its fixtures: `expected/` is produced by
`apps/web/scripts/tools/dump-envelopes.ts` from the recorded upstream payloads, so if
the TS shapers change, regenerate both before trusting a green run.

## Layout

```
cmd/apicalls/         HTTP surface (frozen contract), retry policy, error mapping
internal/cryptorank/     port of lib/cryptorank.ts: 28 modes, key rules, refusals
internal/cryptorank/     port of scripts/oracle/cr_fetch.py: TLS client, allowlist,
                      __NEXT_DATA__ extraction, disk cache, single-flight
internal/cryptorank/     port of lib/shapers.ts: 23 shape functions + envelope()
                      + parity_test.go (the TS golden oracle)
internal/httpx/       JSON response writer (HTML escaping off, JSON.stringify-like)
internal/paritytest/  served-bytes oracle: drives the real writer over every fixture
internal/khala/       khala.io research reports (DR-006): plain net/http, HTML
                      extractor, disk cache, 3 modes; fixtures in testdata/
internal/llama/       DeFiLlama TVL: plain net/http, JSON pass-through with the
                      sort/trim that the TS route used to do, in-process 15 s TTL
                      cache + single-flight, 3 modes
internal/news/        Cointelegraph RSS (DR-012): plain net/http, the RSS parse the
                      TS route used to do (six-key projection, HTML-stripped
                      200-rune descriptions), in-process 15 s TTL cache +
                      single-flight keyed on the feed URL, 1 feed
internal/chainrank/   chainrank.fyi reads (DR-013): 2 modes, pagination relayed
                      verbatim into the upstream URL AND the cache key, explicit
                      32-entry ceiling with oldest-first eviction, shape check
```

The mode table keeps `--data-route` support (`/funding-rounds`, `/token-unlock`,
`/ico/<key>`) **only** so the decoy detector in
`apps/web/scripts/verify/verify-cryptorank.py` can still probe upstream; `funding` and
`unlocks` remain `503`-refused and are never served from this service.

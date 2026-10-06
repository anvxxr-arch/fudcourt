# shared/contracts/schemas — canonical JSON Schemas

Draft 2020-12 schemas for the concepts this repository **already has or already consumes**. Nothing
here is invented: every file names the code it describes, and a concept with no implementation gets
either an honest `null`-able field or no file at all (`macro/` is deliberately absent — see
[What is deliberately missing](#what-is-deliberately-missing)).

Read [`docs/architecture/canonical-model.md`](../../../docs/architecture/canonical-model.md) first:
it is the prose model these files are the machine-readable form of, and it carries the evidence for
every claim restated here.

> **Status.** `macro/` is absent, and `markets/price.json` still describes an entity with **no id
> producer** (see `canonical-model.md` §1.4, D-CANON).
>
> **Update — four of those five now have a producer.** `assets/asset.json`, `assets/chain.json`,
> `assets/token.json` and `markets/venue.json` are backed by
> `apps/api/internal/markets/reference`, which mints `asset_id`/`chain_id`/`token_id`/`venue_id`
> and publishes the `(provider, provider_id) → canonical_id` table as
> **`contracts/data/reference.json`**. That artifact is the machine-readable instance of these
> four schemas; the schemas stay the normative *shape*, and `markets/instrument.json`'s
> `instrument_id` and `markets/price.json` remain unproduced.

---

## 1. Layout

```
schemas/
  common/            the carriers every other file composes: no domain nouns
  accounts/          wallets, venue accounts, balances, equity
  assets/            asset / token / chain
  markets/           venue, instrument, ticker, price, candle
  trading/           execution, order, fill, position + plan/request/risk
  finance/           ledger entry, transaction, treasury, valuation, exposure
  defi/              protocol, pool
  research/          provider-shaped market rows + news/report documents
  signals/           signal, scoreboard
  error-envelope.json, event-envelope.json   (pre-existing, untouched)
```

Every directory **in this tree** exists because at least one concept in it is implemented or
consumed today, and no directory **in this tree** is empty. (Neither claim is about `events/`,
which is not a child — see the next paragraph.)

**`events/` is not in this tree.** The event catalogue (`catalog.json`, `event.schema.json`) is a
**sibling** of `schemas/` under `contracts/` — it is [`../events/`](../events/), not
`schemas/events/`, and it is a different contract (see §3). `schemas/event-envelope.json` is the
only event artifact that lives here.

## 2. Layer of each file

Layers are the ones defined in `canonical-model.md` §1: RAW → PARSED → NORMALIZED → **CANONICAL** →
ENRICHED → DERIVED → PRODUCT VIEW. A schema's layer is *what kind of thing it describes*, not where
it is computed.

### 2.1 `common/` — carriers (L2/L4 boundary types)

| File | Layer | What it is |
|---|---|---|
| [`decimal.json`](common/decimal.json) | boundary type | The exact decimal string every money/price/quantity/percentage/ratio is carried as. Cites the four `big.Rat` packages and the executor `internal/decimal`. |
| [`money.json`](common/money.json) | boundary type | Decimal string in the unit the field names. Signedness is the field's contract (`ledger.Entry.Amount` is signed; `treasury.Movement.Amount` is a positive magnitude). |
| [`quantity.json`](common/quantity.json) | boundary type | Decimal string count of units; grid rounding is down-only (`RoundQuantityDown`). |
| [`price.json`](common/price.json) | boundary type | Decimal string price; a computed price is rounded to the instrument grid (`RoundPrice`), a venue price is verbatim. |
| [`percentage.json`](common/percentage.json) | boundary type | Decimal string **0–100**. Names the exact incident it prevents (`assets.share_pct` vs `VenueQuote.change24h`). |
| [`ratio.json`](common/ratio.json) | boundary type | Decimal string **0–1** (take-profit fraction, funding rate). |
| [`count.json`](common/count.json) | boundary type | Integer count/rank/index. Cites the `*float64` ranks/counts that violate it. |
| [`identifier.json`](common/identifier.json) | **CANONICAL** | Opaque canonical id + the three invariants (not a symbol, not a provider id, stable). |
| [`symbol.json`](common/symbol.json) | NORMALIZED | A symbol is a **spelling** (`BASE/QUOTE` canonical; `exchange_symbol` is the venue's). |
| [`time.json`](common/time.json) | boundary type | `$defs` for the five time meanings, with the legacy deviations called out. |
| [`provenance.json`](common/provenance.json) | PRODUCT VIEW | The honesty block: `source_id`, `observed_at`, `received_at`, `cache`, `derived`, `count`/`total`/`slice`/`missing`. |
| [`source.json`](common/source.json) | system | Where a fact came from + its sensitivity class. |

### 2.2 Domain files

| File | Layer | Owner today (package) | Canonical id? |
|---|---|---|---|
| [`accounts/wallet.json`](accounts/wallet.json) | CANONICAL | `backend/api [removed: accounts/wallets]` | address is the key in SQL today |
| [`accounts/exchange-account.json`](accounts/exchange-account.json) | CANONICAL | `backend/api accounts/exchange` (+ executor store) | minted uuid |
| [`accounts/balance.json`](accounts/balance.json) | CANONICAL | `backend/workers/executor` / `backend/api [removed: finance/ledger]` | via account+asset |
| [`accounts/account-equity.json`](accounts/account-equity.json) | CANONICAL | `backend/workers/executor` | via account |
| [`assets/asset.json`](assets/asset.json) | **CANONICAL** | **`apps/api/internal/markets/reference`** (new) | `asset_id` minted; instance in `contracts/data/reference.json` |
| [`assets/token.json`](assets/token.json) | **CANONICAL** | **`apps/api/internal/markets/reference`** (new) | `token_id` minted over `chain/address`; instance in `reference.json` |
| [`assets/chain.json`](assets/chain.json) | **CANONICAL** | **`apps/api/internal/markets/reference`** (new) | `chain_id` minted; instance in `reference.json`; `apps/reconciler/src/chains.rs` is still a separate private table |
| [`markets/venue.json`](markets/venue.json) | **CANONICAL** | **`apps/api/internal/markets/reference`** (new) | `venue_id` minted; instance in `reference.json`; the three inline allowlists are now redundant |
| [`markets/instrument.json`](markets/instrument.json) | CANONICAL | `backend/api [removed: markets/instruments]` | **`instrument_id`, no minter** |
| [`markets/ticker.json`](markets/ticker.json) | CANONICAL | `backend/api [removed: markets/overview]` | via instrument+venue |
| [`markets/price.json`](markets/price.json) | CANONICAL | **absent** | schema only |
| [`markets/candle.json`](markets/candle.json) | CANONICAL | `backend/api [removed: markets/overview]` | via instrument+interval+open_time |
| [`trading/execution.json`](trading/execution.json) | CANONICAL | `backend/workers/executor` | minted uuid |
| [`trading/order.json`](trading/order.json) | CANONICAL | `backend/workers/executor` | minted `fud_…` |
| [`trading/fill.json`](trading/fill.json) | CANONICAL | `backend/workers/executor` | dedup key `(account, trade)` |
| [`trading/position.json`](trading/position.json) | CANONICAL | `backend/workers/executor` (+ derived in `[removed: finance/portfolio]`) | key `(instrument, side)` |
| [`trading/execution-plan.json`](trading/execution-plan.json) | CANONICAL | `backend/workers/executor` | via execution |
| [`trading/order-request.json`](trading/order-request.json) | CANONICAL | `backend/workers/executor` | via `fud_…` |
| [`trading/sizing-definition.json`](trading/sizing-definition.json) | CANONICAL | `backend/workers/executor` | n/a |
| [`trading/execution-event.json`](trading/execution-event.json) | DERIVED | `backend/workers/executor` | `evt_…` / bigserial |
| [`trading/risk-profile.json`](trading/risk-profile.json) | CANONICAL | `backend/workers/executor` | `user_id` |
| [`finance/ledger-entry.json`](finance/ledger-entry.json) | CANONICAL | `backend/api [removed: finance/ledger]` | natural key |
| [`finance/ledger-account.json`](finance/ledger-account.json) | CANONICAL | **absent** (SQL only) | `code` |
| [`finance/treasury-account.json`](finance/treasury-account.json) | CANONICAL | `backend/api [removed: finance/treasury]` | `account_id` |
| [`finance/allocation.json`](finance/allocation.json) | CANONICAL | `backend/api [removed: finance/treasury]` | via account |
| [`finance/movement.json`](finance/movement.json) | CANONICAL | `backend/api [removed: finance/treasury]` | `id` |
| [`finance/transaction.json`](finance/transaction.json) | PRODUCT VIEW | `backend/api [removed: finance/transactions]` | SQL surrogate |
| [`finance/valuation.json`](finance/valuation.json) | **DERIVED** | `backend/api [removed: finance/portfolio]` | n/a |
| [`finance/exposure.json`](finance/exposure.json) | **DERIVED** | `backend/api [removed: finance/portfolio]` | n/a |
| [`defi/protocol.json`](defi/protocol.json) | NORMALIZED | `backend/data internal/research/llama` | provider slug |
| [`defi/pool.json`](defi/pool.json) | NORMALIZED | **absent** (TS `DexPair`) | provider pair address |
| [`research/coin.json`](research/coin.json) | NORMALIZED | `backend/data internal/research/cryptorank` | provider key |
| [`research/global-stats.json`](research/global-stats.json) | NORMALIZED | same | n/a |
| [`research/chain-stats.json`](research/chain-stats.json) | NORMALIZED | same | provider slug |
| [`research/exchange-row.json`](research/exchange-row.json) | NORMALIZED(+DERIVED rank) | same | provider key |
| [`research/category.json`](research/category.json) | NORMALIZED | same | provider slug |
| [`research/chainrank-listing.json`](research/chainrank-listing.json) | NORMALIZED | `backend/data internal/research/chainrank` | provider id |
| [`research/news-article.json`](research/news-article.json) | NORMALIZED | `backend/data internal/research/{news,khala}` (+cryptorank) | **none** |
| [`research/report-body.json`](research/report-body.json) | NORMALIZED | `backend/data internal/research/khala` | report slug |
| [`research/prediction-market.json`](research/prediction-market.json) | ENRICHED (in-payload join) | `backend/data internal/research/cryptorank` | provider id |
| [`signals/signal.json`](signals/signal.json) | PRODUCT VIEW | **absent** (Next route only) | provider `(id, mint)` |
| [`signals/scoreboard.json`](signals/scoreboard.json) | **DERIVED** (provider/browser) | **absent** | n/a |

## 3. Relation to `events/`

`events/` and these schemas are **different contracts and neither subsumes the other**:

| | `events/` (`catalog.json`, `event.schema.json`) + `schemas/event-envelope.json` | `schemas/<domain>/*.json` |
|---|---|---|
| Describes | something that **happened** | something that **is** |
| Ids | 28 stable `event_type` ids (PascalCase) + SCREAMING_SNAKE aliases | entity ids (`*_id`) |
| Versioning | `event_version` starts at 1; additive changes keep it, breaking bumps it | none — these are the current shape |
| Drift gate | `contracts/scripts/check-contract.mjs` (c) pins catalogue ↔ `event.schema.json`, and (a) pins `ExecutionStatus`/`ChildOrderStatus`/`ExecutionEventName` ↔ `apps/web/src/lib/executor.ts` and the OpenAPI enums | **not** covered by a gate yet (see §5) |
| Extra keys | payload is free-form and additive by policy | objects are **closed** (`additionalProperties: false`) where the value set is closed, so an unknown key is a schema error, not an extension |

Two deliberate refusals to duplicate:

1. **No event enum is re-listed here.** `trading/execution.json#/$defs/event_name` is a
   `string` that *points at* `events/events.json`; re-enumerating 28 ids in a second file would
   create exactly the drift surface the existing gate exists to prevent.
2. **No payload schemas.** Per-event payload keys are documented as **observed evidence** in the
   catalogue (`payload_policy`), not as a closed contract — so a schema here would be stricter than
   the contract it claims to describe.

## 4. Conventions used by every file in this tree

- **`$id`s** are `https://fudcourt.local/contracts/schemas/<path>`, matching the existing
  two envelopes byte-for-byte in style.
- **Time field names carry their semantics**: `occurred_at`, `observed_at`, `received_at`,
  `recorded_at`, `updated_at` — resolved in `common/time.json`.
- **Honest nullability**: an unreported value is `null`, or the field is absent. It is **never `0`**
  and never a borrowed value. This is the repo's own rule, restated wherever a field could violate
  it (every `"NEVER 0"` / `"never a fabricated zero"` phrase in this tree cites the code that
  states it).
- **Closed objects** (`additionalProperties: false`) are used where the value set is closed — the
  enum-backed types (execution/order status, market type, side, sizing modes, venue kinds) and the
  fixed-shape entity records. Open maps are explicit and named: window-keyed provider maps, and
  `research/chainrank-listing.json`'s `partial` pass-through.
- **`$ref` across directories** is relative and used for real composition (`../common/decimal.json`,
  `instrument.json#/$defs/market_type`), never for a same-file alias.
- **Enums that are frozen elsewhere are not re-spelled.** `ExecutionStatus`, `ChildOrderStatus` and
  the event ids appear here only as prose pointers to the file that owns them.

## 5. What is deliberately missing

| Concept | Why there is no schema |
|---|---|
| **MacroSeries / MacroObservation** | No code, no provider, no table, no route, no feature directory. Case-insensitive greps for `macro`, `fred`, `cpi`, `inflation`, `macroeconomic`, `yield`, `dxy`, `tbill` over `backend`, `apps/web/src`, `shared`, `database`, `tests` return zero substantive matches. Writing `macro/` would describe a system that does not exist. |
| **A `reference.json` schema** | The registry artifact (`contracts/data/reference.json`) is generated and self-describing (`document_version`, `id_rule`, `salt`), but it is a **data** file, not a schema, and it lives under `data/` not `schemas/`. Describing it here would duplicate the entity schemas it instantiates. |
| **An `instrument_id` producer** | `markets/instrument.json` remains the one CANONICAL schema whose id the registry does **not** mint. Recorded, not silently closed (`canonical-model.md` O4). |
| **Payload schemas for events** | See §3 (2). |
| **Credential / secret shapes** | Deliberately not published: the sealed envelope and the revealed secret are server-side-only by contract (`[removed: access/credentials/envelope.go]` — "SERVER-SIDE ONLY: it must never be serialized to a client, written to a log or put in a URL"). `accounts/exchange-account.json` carries the masked handle only. |
| **Candle/price/pool *stores*** | No table exists for any of them (`price_history` has DDL but no writer). The schemas exist because the shapes are consumed; no schema claims persistence. |
| **A `sizing_value` unit fix** | Recorded as an open question (`canonical-model.md` O5), not silently resolved by picking a unit. |

## 6. Verification

```sh
# contract drift gate (must still print CONTRACTS_OK)
node shared/contracts/scripts/check-contract.mjs
# every file is valid JSON
python3 -c "import json,glob;[json.load(open(f)) for f in glob.glob('shared/contracts/schemas/**/*.json',recursive=True)]"
```

These schemas are **not** wired into a generator or a route yet: `events/` remains the event source
of truth, and `openapi/fudcourt.yaml` remains the HTTP contract. The same is true of the reference
registry: `contracts/data/reference.json` has a producer
(`apps/api/internal/markets/reference/cmd/emit`) and a drift test
(`TestReferenceArtifactIsCurrent`), but **no HTTP route and no consumer** yet. Extending
`contracts/scripts/check-contract.mjs` to validate these files is Phase 7/8 work
(`canonical-model.md` §9.1); nothing in this directory changes behaviour today.

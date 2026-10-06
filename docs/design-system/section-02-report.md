# FUDCourt UI/UX Plan — Section 02 Report

**Section:** Foundations & Atoms
**Status:** complete
**Verification:** `VERIFY_ALL_OK` (the repo's own gate), plus the six design-system gates below

---

## Deliverables

| # | Deliverable | Where |
|---|---|---|
| 1 | Canonical token pipeline | `src/styles/tokens.ts` + `scripts/design/emit-tokens.ts` |
| 2 | Light/dark semantic theme layer | `src/styles/theme.css` + `src/ui/foundations/color.ts` |
| 3 | Typography foundation | `src/ui/foundations/typography.ts` + `src/styles/typography.css` |
| 4 | Spacing / radius / density / elevation | `src/ui/foundations/spacing.ts` |
| 5 | Motion + reduced-motion foundation | `src/ui/foundations/motion.ts` + `src/styles/motion.css` |
| 6 | Accessibility foundation | `src/ui/foundations/accessibility.ts` + `src/styles/accessibility.css` |
| 7 | Layout / grid foundation | `src/ui/foundations/layout.ts` |
| 8 | Typography atoms | `src/ui/atoms/typography/` |
| 9 | Visual + status atoms | `src/ui/atoms/visual/`, `src/ui/atoms/status/` |
| 10 | Action atoms | `src/ui/atoms/actions/` |
| 11 | Generic form atoms | `src/ui/atoms/form/` |
| 11b | Financial input atoms | `src/ui/atoms/form/financial.tsx` |
| 12 | Financial formatting core | `src/ui/atoms/financial/format.ts` |
| 13 | Financial display atoms | `src/ui/atoms/financial/` |
| 14 | Market atoms | `src/ui/atoms/market/` |
| 15 | Blockchain atoms | `src/ui/atoms/blockchain/` |
| 16 | System atoms | `src/ui/atoms/system/` |
| 17 | Table primitives | `src/ui/atoms/table/` |
| 18 | Visualization atoms + Sparkline | `src/ui/atoms/visualization/` |
| 19 | Layout primitives | `src/ui/atoms/layout/` |
| 20 | Public API barrel | `src/ui/index.ts` |
| 21 | Hardcoded-style guardrails | `scripts/checks/check-design-system.py` |
| 22 | Atom documentation | `docs/design-system/atoms.md` |
| 23 | Architectural review | `docs/design-system/foundations-atoms-review.md` |

Supporting: `docs/design-system/current-ui-audit.md` (the pre-existing-UI audit the section
opened with) and `docs/design-system/fudcourt-foundations-atoms-spec.md` (the frozen spec).

---

## Verification

```
tsc --noEmit                        0 errors
bun run test:shapers                325 pass, 0 fail (19 files)
next build                          0 errors
node tools/fud.ts verify            VERIFY_ALL_OK
check-design-tokens.py              DESIGN_TOKENS_OK (364 files, 6 exemptions)
check-design-system.py              DESIGN_SYSTEM_OK (21 files, 6 scale exemptions)
emit-tokens.ts --check              TOKENS_OK (284 vars)
check-structure.py                  STRUCTURE_OK (359 files, DR-018 layers)
```

Of the 337 tests, **67 are new**: 22 theme-parity and contrast tests, 45 atom tests (33 + 12 financial input).

---

## The five review focuses, and what they caught

The plan named five areas a reviewer should focus on. Each is covered by tests, and three of
them found real defects.

### 1. Financial formatting corruption — 23 tests

Negative zero, large values, tiny precision, null, NaN, Infinity, and the parse inverse.

**Caught:** `formatPrice(-0)` rendered `0.00000000`. The adaptive digit count was computed
from the pre-normalized value, so zero fell into the sub-cent branch. A position that is
exactly flat would have read as a loss with eight meaningless decimals.

**Caught:** the compact thresholds produced `1.2B` where `1.23B` was intended and `789M`
where `789.0M` was intended. The rule is now one fractional digit minimum, two maximum.

### 2. Light/dark semantic drift — 13 tests

Key-set parity, resolution in both themes, genuine difference between them, and the WCAG
ratios asserted against **every surface of each theme** rather than only the page background.

**Caught:** `brand-critical` existed in both critical ramps but in neither semantic map, so
it was unreachable through the public API. The parity test found it; it is now in both maps.

**Caught:** the critical foregrounds cleared 7:1 on the page background but fell to
6.0–6.7:1 on the raised surface. A critical value is frequently rendered inside a card, so
both sets were retuned to clear the target on every surface.

**Caught:** `warning-muted` measured 2.99:1 against the light background — a hair under the
3:1 indicator boundary. Adjusted to `#AF823B` (3.28:1).

### 3. Colour-only financial meaning — 9 tests

**Caught:** the chart `CATEGORICAL` palette initially reused `positive-muted`,
`negative-muted`, `warning-muted` and `info-muted`. A chart's fifth series would have read
as a loss. The palette is now drawn from the brand orange and neutral ramps only, and a test
asserts no categorical colour collides with a market semantic.

Every directional state carries a non-colour cue: `Delta` renders `↑ +2.41%`, `PnL` is
always signed, `Confidence` states Low/Medium/High, `Latency` states Good/Degraded/Critical,
`ExecutionStatus` exposes a label for all 15 canonical states, `SortIndicator` puts the
direction in the glyph **and** in `aria-sort`.

### 4. Realtime layout movement — 5 tests

Financial numerics are Geist Mono with tabular figures, asserted on rendered markup. The
realtime flash is a semantic 200ms flash, not a count-up. `transition: all` is refused by the
gate. `Button` preserves its width while loading — asserted.

### 5. Atomic boundary leakage — 2 tests + 1 build gate

No `fetch`, `XMLHttpRequest`, `WebSocket`, `axios`, `ccxt` or `node:http(s)` anywhere in the
design system. No import of `@/features`, `@/app` or `@/server`.

**Caught by the repo's structure gate, not by the tests:** the system atoms imported
`ExecutionStatus` and `ChildOrderStatus` from `@/lib`, which DR-018 forbids — `src/ui/` is a
presentational leaf and may import only `@/ui` and `@/styles`. The vocabulary is now declared
in `src/ui/atoms/system/lifecycle.ts` and proven equal to the engine's three ways: a
type-level mutual-assignability pin, a runtime cross-check against the engine's
`EXECUTION_TRANSITIONS` table, and a cross-check against the frozen contract schema's
`execution_status` and `child_order_status` enums.

That last one also surfaced a **wrong contract access** in the test itself — the enum lives
at `.enum`, not on the `$def` — which had been silently throwing a `TypeError`.

---

## The gap the final audit closed

The task list claimed Task 14 complete. It was not. The nine financial **input** atoms —
`AmountInput`, `PriceInput`, `PercentInput`, `QuantityInput`, `CurrencyInput`,
`LeverageInput`, `RiskInput`, `StopLossInput`, `TakeProfitInput` — were never written. The
barrel exported the financial **display** atoms and the generic form controls, and nothing in
between, and no gate asserted the inventory, so the omission was invisible to every check that
ran: the build passed, the tests passed, the token gates passed.

A Definition-of-Done audit that walks the plan's REQUIRED ATOM INVENTORY against the barrel
one name at a time found it. That audit is now the thing that catches this class of defect.
A gate that only asks "does the build pass" cannot notice an atom that was never written.

The atoms are implemented as one private shell with nine named wrappers, because each name
carries a product decision the generic cannot: the value read back is `number | null` (never a
string, never `NaN`), a negative is **refused** rather than clamped to zero (clamping would
turn a typo into a real order), bounds are defaults a caller may widen, precision is applied
on commit rather than per keystroke, and paste strips grouping separators and a leading
currency symbol. Twelve tests cover the contract.

Three failed on the first run and all three were the tests' fault: React renders `inputMode`
camelCase in static markup, `readOnly` renders as `readOnly=""`, and the sign policy is a
commit-time policy — rendering must show what the caller stored, because a controlled value
must never be silently rewritten under them.

## One failure no test caught

`space-0.5` is unparseable as a CSS custom property name: the bundler's tokenizer reads
`--fc-space-0.5` and fails on the dot. The contrast suite was green, the token gate was
green, and `next build` still failed.

The step is named `space-half`. Recorded in the spec with its reasoning.

Worth stating plainly: a design system whose values cannot be emitted is not shippable, and
the build is the only gate that catches that class of defect.

---

## Scope honoured

The plan's stop conditions and exclusions were respected. Not built, by design: Molecules,
Organisms, Templates, Pages, `AssetSelector`, `MarketSelector`, `SearchField`, `FilterBar`,
`TableToolbar`, `Pagination`, `BulkActionBar`, `ColumnVisibility`, full `DataTable`
orchestration, `OrderTicket`, `OrderForm`, `RiskControl`, `PortfolioCard`, `MetricCard`,
`MarketCard`, `PositionCard`, `Watchlist`, navigation and breadcrumb composition, Command
Palette, modal workflows, execution flows, feature redesigns, page redesigns.

The legacy `src/ui/*.tsx` primitives are untouched — 23 files still on the HIG palette, 10
new modules on the FUDCourt generation, both emitted into the same `:root` from one source
file. `git diff HEAD -- src/ui/*.tsx` is empty.

---

## Risks carried forward

1. **No chart engine.** The visualization atoms are SVG and label primitives. A Molecule
   phase must either adopt an engine or compose these by hand. The vocabulary is stable
   either way.
2. **No responsive CSS.** `Grid`'s `responsive` prop emits per-breakpoint custom properties
   but no stylesheet consumes them yet, so a grid stays at its `columns` count.
3. **Fonts are self-hosted, Latin subset only.** A localisation phase needs the rest.
4. **Migration debt.** The legacy primitives and `src/lib/format.ts` remain live for existing
   pages. The new formatting core is generic and presentation-layer; the domain formatters
   carry product decisions (e.g. `fmtVolume` renders `0` as `—` because the Yahoo feed sends
   0 for unpublished volume) and must not be replaced by it.

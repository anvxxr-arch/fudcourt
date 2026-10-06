# FUDCourt Foundations & Atoms — Architectural Review

Section 02 of the FUDCourt UI/UX plan. Reviewed against the plan's stated stop conditions,
the approved spec, and the five review focuses.

**Verdict: complete.** Every deliverable in the plan's scope is implemented, gated and
tested. Three values were adjusted away from the spec's first draft, each because an
automated contrast or parse test proved the spec wrong; all three are recorded in the spec
with their reasoning rather than silently changed.

---

## 1. What was built

| Layer | Files | Gate |
|---|---|---|
| Tokens | `src/styles/tokens.ts` (additive FUDCourt generation) | `check-design-tokens.py` |
| Emitter | `scripts/design/emit-tokens.ts` → `globals.css` + `tailwind.tokens.json` | `emit-tokens.ts --check` |
| Stylesheets | `src/styles/{theme,typography,motion,accessibility}.css` | `check-design-tokens.py` |
| Foundations | `src/ui/foundations/{color,typography,spacing,layout,motion,accessibility}.ts` | `check-design-system.py` |
| Atoms | `src/ui/atoms/{typography,actions,form,visual,status,financial,market,blockchain,system,table,visualization,layout}` | `check-design-system.py` |
| Public API | `src/ui/index.ts` — one entry point | boundary test |
| Tests | `tests/design-system-tests.ts` (22), `tests/design-system-atom-tests.ts` (33) | `bun run test:shapers` |
| Guardrail | `scripts/checks/check-design-system.py` | `check:design` |
| Docs | `docs/design-system/{current-ui-audit,fudcourt-foundations-atoms-spec,atoms}.md` | — |

### Verification (all green)

```
tsc --noEmit                        0 errors
bun run test:shapers                323 pass, 0 fail (19 files)
next build                          0 errors
check-design-tokens.py              DESIGN_TOKENS_OK (363 files, 6 exemptions)
check-design-system.py              DESIGN_SYSTEM_OK (21 files, 6 scale exemptions)
emit-tokens.ts --check              TOKENS_OK (284 vars)
```

---

## 2. The five review focuses

### 2.1 Financial formatting corruption

**Covered.** 17 formatting tests plus 6 rendering tests.

The four rules that make this correctness-critical rather than cosmetic, all asserted:

- **Negative zero normalizes.** `formatPrice(-0)` is `0.00`, never `-0`. A position that is
  exactly flat must not read as a loss. The same holds for `formatPnL` and `formatPercentage`.
- **Absent is never zero.** `null`, `undefined`, `NaN`, `Infinity` and `-Infinity` all render
  `—` across all eleven formatters. `parseFinancialInput` follows the same contract: empty,
  whitespace, a bare sign, a bare dot and a non-finite result all resolve to `null`.
- **Precision is explicit.** `formatPrice(1, { precision: 4 })` is `1.0000`. Adaptive mode
  derives digits from magnitude (2dp ≥ 1, 4dp ≥ 0.01, 8dp below), and zero renders at the
  base 2dp rather than the 8dp a naive magnitude rule would give it.
- **Sign display is explicit.** `formatPercentage(2.41, { signed: true })` is `+2.41%`;
  `formatPrice(2.41)` is `2.41` with no manufactured `+`.

Large values are covered by the compact thresholds: `1.23B`, `45.0B`, `789.0M`, `12.3K`,
`1.0K`, and the sign survives compaction (`-1.23B`). `roundTo` corrects the binary
floating-point epsilon so a displayed `1.01` and a stored `1.01` agree.

**One real bug was found and fixed by these tests.** `formatPrice(-0)` rendered
`0.00000000`: the adaptive digit count was computed from the pre-normalized value, so zero
fell into the sub-cent branch. The compact rule also produced `1.2B` where `1.23B` was
intended, and `789M` where `789.0M` was intended. Both are fixed; the tests are the reason
they were caught.

### 2.2 Light/dark semantic drift

**Covered.** Four parity tests plus nine contrast tests.

- `lightSemantic` and `darkSemantic` share an identical key set, asserted at runtime.
- Every semantic role resolves in both themes to a real colour.
- The two themes are genuinely different, not one map twice: the surface, text and border
  families are asserted to differ.
- The critical foregrounds are theme-specific and asserted to differ.

**A real gap was found by the parity test.** `brand-critical` existed in both critical ramps
but in neither semantic map, so it was unreachable through the public API. Added to both.

### 2.3 Colour-only financial meaning

**Covered.** Every directional state carries a non-colour cue.

- `Delta` renders `↑ +2.41%` / `↓ −1.08%` — arrow **and** sign.
- `PnL` is always signed, so a gain and a loss are distinguishable without colour.
- `Trend` always renders its arrow.
- `ExecutionStatus` exposes a human label for all 15 canonical states.
- `MarketStatus` and `HealthStatus` say what they mean in words.
- `Confidence` states Low / Medium / High; `Latency` states Good / Degraded / Critical.
- `StatusDot`'s label is mandatory and renders visually-hidden.
- `SortIndicator` puts the direction in the glyph **and** in `aria-sort`.
- `Sparkline` puts the direction in its accessible name.

**A real violation was found and fixed.** The chart `CATEGORICAL` palette initially reused
`positive-muted`, `negative-muted`, `warning-muted` and `info-muted`. A chart's fifth series
would have read as a loss. The palette is now drawn from the brand orange and neutral ramps
only, and a test asserts no categorical colour collides with a market semantic.

### 2.4 Realtime layout movement

**Covered.** Financial numerics are Geist Mono with tabular figures, asserted on the rendered
markup of `Price`, `Delta`, `PnL`, `Quantity`, `Timestamp`, `BlockNumber`, `GasValue` and the
blockchain hashes.

The realtime flash is a **semantic** flash: 200ms, then back to neutral. The plan's "never
animate live trading numbers like slot-machine wheels" is honoured by construction — there
is no count-up animation, no digit-by-digit transition, and no `transition: all` anywhere in
the atom layer (the gate refuses it).

`Button` preserves its width while loading: the label stays mounted and invisible, so the
button's intrinsic width does not change and nothing next to it moves. Asserted.

### 2.5 Atomic boundary leakage

**Covered.** Two source-scanning tests over `src/ui/foundations`, `src/ui/atoms` and
`src/styles`.

- No `fetch(`, `XMLHttpRequest`, `WebSocket`, `axios`, `ccxt` or `node:http(s)` import.
- No import of `@/features`, `@/app` or `@/server`.
- No atom resolves a symbol to a logo, calls a provider or reads a registry. `AssetIcon`,
  `ChainIcon` and `Avatar` render only what they are handed.

The same two rules are enforced at build time by `check-design-system.py`, so a violation
fails the gate rather than waiting for a test run.

---

## 3. Deviations from the spec, with reasoning

Three values moved. In each case an automated test proved the spec's first draft wrong, and
the plan states the tests are authoritative.

### 3.1 `warning-muted`: `#B8893E` → `#AF823B`

Measured **2.99:1** against the light background — a hair under the 3:1 large-indicator
boundary. Adjusted to `#AF823B` (3.28:1 on the light background, 3.45:1 on white). Every
other muted value already cleared the boundary on every surface.

### 3.2 The critical foregrounds, tuned per theme

The spec's first draft cleared 7:1 on the page background but fell to 6.0–6.7:1 on the
raised surface. A critical value is frequently rendered inside a card, so the target was
applied to **every surface of the theme**, not merely the canvas. Both sets were retuned:

| Token | Light | Dark |
|---|---|---|
| `positive-critical` | `#285A42` | `#7CB399` |
| `negative-critical` | `#7C3E3E` | `#D29999` |
| `warning-critical` | `#674C23` | `#C7A166` |
| `info-critical` | `#33546E` | `#8BACC6` |
| `brand-critical` | `#833C0D` | `#EE9154` |

### 3.3 `space-0.5` → `space-half`

The plan writes the 2px step as `space-0.5`. A CSS custom property whose name contains a dot
(`--fc-space-0.5`) is not parseable — the bundler's CSS tokenizer reads `0.5` as a number and
fails the build. The step is named `space-half` (`--fc-space-half`), the same value under a
name every CSS parser accepts.

**This one was found by the build, not by a test**, which is worth recording: the contrast
suite was green and the token gate was green, and `next build` still failed. A design system
whose values cannot be emitted is not shippable, and the build is the only gate that catches
it.

---

## 4. Two gate rules that needed the aggregate reasoning

The dead-token alarm exists to catch an invented token with no consumer. Applied naively to
a design system it produces noise, because a frozen scale ships complete.

**A ramp is a frozen palette, not a menu of choices.** The plan fixes every step of the
orange and neutral ramps and the market semantics; the semantic layer decides which steps are
in use. A ramp step no semantic role currently names is still the approved colour for the
role that will need it. The ramp is vouched for by the semantic layer that consumes it.

**The semantic layer is the public vocabulary.** The plan fixes its full key set, and the
parity test asserts the key set is complete and identical in both themes — that is the
contract that matters. Vouching for each role individually would demand a second mention of
every key.

Both exemptions are written into the gate with their reasoning, not silenced. The alarm still
fires for a token invented outside the frozen families — which is what it is for.

---

## 5. The legacy coexistence

The audit's finding stands and was honoured: **no migration of existing pages is in scope**,
and the legacy `src/ui/*.tsx` primitives are untouched.

- 23 legacy files still import the legacy HIG palette (`color`, `space`, `radius`, …).
- 10 new modules import the FUDCourt generation.
- Both palettes are emitted into the same `:root` and `.dark` blocks from one source file.
- `git diff HEAD -- src/ui/*.tsx` is empty.

The one genuine near-duplicate pair — `sparkline.tsx` (legacy) vs the new `Sparkline` atom —
is handled by keeping the legacy file untouched and documenting it as migration debt, exactly
as the audit prescribed.

---

## 6. What is deliberately absent

Molecules, Organisms, Templates, Pages, and every composition the plan lists as out of scope:
`AssetSelector`, `MarketSelector`, `SearchField`, `FilterBar`, `TableToolbar`, `Pagination`,
`BulkActionBar`, `ColumnVisibility`, full `DataTable` orchestration, `OrderTicket`,
`OrderForm`, `RiskControl`, `PortfolioCard`, `MetricCard`, `MarketCard`, `PositionCard`,
`Watchlist`, navigation and breadcrumb composition, Command Palette, modal workflows,
execution flows, feature redesigns, page redesigns.

`SelectTrigger` is the closed control only; the listbox it opens is a Molecule. The chart
primitives are SVG and label vocabulary, not a chart engine — no Recharts, D3 or Visx is
installed, and adding one for this phase would be scope the plan does not authorise.

---

## 7. Risks carried forward

1. **No chart engine.** The visualization atoms are primitives. A Molecule phase must either
   adopt an engine or compose these into charts by hand. The vocabulary is stable either way.
2. **No responsive CSS.** `Grid`'s `responsive` prop emits custom properties per breakpoint
   but no stylesheet consumes them yet, so a grid stays at its `columns` count. A page phase
   that needs real reflow must add that stylesheet.
3. **Fonts are self-hosted, Latin subset only.** The product is English-first; a localisation
   phase would need the additional subsets.
4. **Migration debt.** The legacy primitives and `src/lib/format.ts` remain the live
   implementation for existing pages. The new formatting core is generic and presentation-
   layer; the domain formatters carry product decisions (e.g. `fmtVolume` renders `0` as `—`
   because the Yahoo feed sends 0 for unpublished volume) and must not be replaced by it.

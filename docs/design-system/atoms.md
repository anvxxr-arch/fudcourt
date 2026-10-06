# FUDCourt Design System — Atoms

The atomic layer of the FUDCourt design system. One entry point: `@/ui`.

```
atoms -> foundations -> tokens
```

An atom consumes a **semantic** token. It never names a primitive, never hand-writes a
colour, never performs a network request, and never imports a feature, the route tree or
server code. Atoms render the state they are handed.

Two gates keep that true, and both are wired into `bun run check:design`:

| Gate | What it refuses |
|---|---|
| `scripts/checks/check-design-tokens.py` | a raw colour, a raw scale value, an invented token with no consumer |
| `scripts/checks/check-design-system.py` | a network call, a layer escape, `transition: all`, a raw scale value in the atom layer |

---

## Foundations

Read by the atoms; a page may compose them directly. Full detail in
[`fudcourt-foundations-atoms-spec.md`](./fudcourt-foundations-atoms-spec.md).

| Module | Exports |
|---|---|
| `foundations/color.ts` | `resolve`, `theme`, `themes`, `cssVar`, `tint`, `semanticRoles`, `primitive` |
| `foundations/typography.ts` | `typeScale`, `variant`, `variantClass`, `numeric`, `tabular`, `monoVariants`, `sansVariants` |
| `foundations/spacing.ts` | `space`, `radius`, `levels`, `dims`, `rhythm`, `defaultDensity` |
| `foundations/layout.ts` | `breakpoints`, `productGrid`, `editorialGrid`, `workspaceGrid`, `mq`, `mqBelow`, `mqBetween` |
| `foundations/motion.ts` | `presets`, `presetClass`, `reducedMotionQuery` |
| `foundations/accessibility.ts` | `contrastTargets`, `focusRing`, `srOnly`, `nonColorCues`, `livePoliteness`, `keyboardKeys` |

### The density contract

Density is a **dimension provider**, not a component fork. There are no
`CompactTable` / `DefaultTable` / `ComfortableTable` implementations.

```tsx
import { dims, type Density } from '@/ui';

function Row({ density }: { density: Density }) {
  const d = dims(density); // { control, row, field, gap, pad }
  return <tr style={{ height: d.row }} />;
}
```

### Elevation is border-first

Levels `0`–`2` carry **no shadow**. Hierarchy comes from surface + border + spacing. Only
`3` (floating) and `4` (overlay) draw a shadow, and that shadow is the elevation token, not
a hand-written `box-shadow`.

---

## Typography atoms

| Atom | Element | Notes |
|---|---|---|
| `Text` | `<p>` / `<span>` | `size` `lg\|md\|sm`, `tone`, `inline` |
| `Heading` | `<h1>`–`<h6>` | `as` sets the outline, `size` sets the weight — independent on purpose |
| `Label` | `<label>` / `<span>` | associates through `htmlFor` |
| `Caption` | `<p>` / `<span>` | `body-sm` at the muted tone. Never mono |
| `Code` | `<code>` / `<kbd>` / `<samp>` | Geist Mono + tabular |
| `DataValue` | `<span>` / `<div>` / `<td>` | Geist Mono + tabular. The financial numeric |

**The mono rule.** Geist Mono is for financial and technical numerics **only**. A narrative
number in article text does not get mono — `body-*` stays sans.

---

## Action atoms

| Atom | Variants | Sizes |
|---|---|---|
| `Button` | `primary` `secondary` `ghost` `outline` `destructive` `success` `warning` `info` `buy` `sell` `link` | `xs` 28 `sm` 32 `md` 40 `lg` 48 `xl` 56 |
| `IconButton` | same | square at the size's height, `radius-md` |
| `Link` | `default` `muted` `brand` | `sm` `md` `lg` |
| `CopyButton` | wraps `Button` | confirms through a live region, not a colour swap |

**Loading preserves width.** The label stays mounted and invisible; only the spinner is
added. A button that changes width when it starts loading moves everything next to it.

**`buy` ≠ `success`, `sell` ≠ `destructive`.** A buy is a brand-coloured action that
increases a position. `intensity` (`muted` | `vivid`) picks which market colour it uses.

---

## Form atoms

| Atom | Control | Notes |
|---|---|---|
| `Input` | `<input>` | `numeric` switches the value to the data family |
| `Textarea` | `<textarea>` | `resize: vertical` only |
| `Checkbox` | `<input type=checkbox>` | native input carries the semantics, sibling draws the box |
| `Radio` | `<input type=radio>` | mutual exclusion is the caller's shared `name` |
| `Switch` | `<input type=checkbox role=switch>` | `radius-full` track, knob travels at `fast` |
| `Slider` | `<input type=range>` | arrow keys, Home/End and the announcement are the platform's |
| `SelectTrigger` | `<button aria-haspopup=listbox>` | the closed control only — the popover is a Molecule |

State model: `default` `hover` `focus` `filled` `disabled` `read-only` `error` `warning`
`success` `loading`. Sizes `sm` 32 `md` 40 `lg` 48.

---

## Visual atoms

| Atom | Notes |
|---|---|
| `Icon` | Lucide-style component reference, 1.75px stroke, `icon-md` default |
| `AssetIcon` | supplied URL or the ticker initial. **No fetching** |
| `ChainIcon` | supplied URL or the chain initial. **No RPC, no explorer API** |
| `Avatar` | `radius-full`. Supplied URL or the name initial |
| `Divider` | border-first. `label` turns it into a section separator |
| `Surface` | `level` 0–4. Border-first: 0–2 get a border and no shadow |
| `Scrim` | the dim layer behind a dialog |

`IconComponent` is the shape `lucide-react` exports, so a caller that later adopts it passes
its icons straight in. No icon library is installed in this repo.

---

## Status atoms

| Atom | Notes |
|---|---|
| `Badge` | `radius-full`. `icon`/`glyph` carries the non-colour cue |
| `Tag` | `radius-sm`, removable. A real `<button>` for the remove control |
| `StatusDot` | the `label` is **mandatory** and renders visually-hidden |
| `Spinner` | label renders visually-hidden, so a screen reader hears "Loading" |
| `Skeleton` | `aria-hidden` — the caller's live region says "busy" |
| `Progress` | real `role="progressbar"` with value attributes |

---

## Financial atoms

All render in Geist Mono with tabular figures. That is the answer to "financial numerics must
not shift width unpredictably when digits update".

| Atom | Formats | Notes |
|---|---|---|
| `Price` | adaptive or explicit precision | `flash` runs the realtime flash keyframe once |
| `Currency` | amount + ISO code | the code is never localized |
| `Quantity` | asset amount | optional unit |
| `Percentage` | rate or share | `signed` adds `+` |
| `Delta` | change + direction | renders `↑ +2.41%` |
| `PnL` | profit or loss | always signed |
| `Ratio` | leverage, multiple | trailing `×` |
| `Yield` / `APR` / `APY` | rate | |
| `MarketCap` / `Volume` | compact by default | `1.23B`, `45.0B`, `789.0M` |
| `DataNumber` | caller-formatted | the escape hatch, still mono + tabular |

### The formatting core

`@/ui/atoms/financial/format` — pure functions, no React, importable from a server
component. Every financial display atom formats through here, so a price rendered `331.74`
in one table and `331.740000` in another is impossible by construction.

Four rules make it correctness-critical rather than cosmetic:

1. **Negative zero is normalized.** `-0` prints as `0`, never `-0`. A position that is
   exactly flat must not read as a loss.
2. **Null/undefined/NaN/Infinity are absent, never zero.** An absent metric is `—`.
3. **Precision is explicit.** A caller passes the digits it wants; `adaptive` derives them
   from magnitude (2dp ≥ 1, 4dp ≥ 0.01, 8dp below).
4. **Sign display is explicit.** `+` on a positive delta is a choice, not a default.

`parseFinancialInput` is the inverse and follows the same contract: empty, whitespace,
grouping separators and a non-finite result all resolve to `null`.

---

## Market atoms

| Atom | Notes |
|---|---|
| `AssetSymbol` | ticker + name; the name is the accessible name |
| `AssetPair` | `BASE / QUOT`E with the separator muted |
| `Trend` | direction + magnitude. The arrow is always present |
| `Timeframe` | a representation primitive, not a selection group |
| `Confidence` | the band is a **word**: Low / Medium / High |
| `MarketStatus` | `open` `closed` `delayed` `stale` `halted` `pre` `post` |

**No fetching.** None of these calls a provider, reads a registry or resolves a symbol to a
logo.

---

## Blockchain atoms

| Atom | Notes |
|---|---|
| `WalletAddress` | truncates for display, full value in the `title` and the a11y tree |
| `TransactionHash` | same contract |
| `BlockNumber` | grouped by default, tabular |
| `GasValue` | figure + unit, unit muted |

**Truncation is presentation-only.** The underlying value is never mutated, never re-cased,
never stripped of its prefix. A value shorter than the budget renders whole — truncating
`0xabc` would be inventing characters.

---

## System atoms

| Atom | Notes |
|---|---|
| `Timestamp` | `time` `date` `datetime` `relative`; `now` is injectable for deterministic tests |
| `Duration` | `compact` `long` `clock` |
| `Latency` | the band is a **word**: Good / Degraded / Critical |
| `HealthStatus` | `healthy` `degraded` `down` `unknown`, with a `subject` |
| `ExecutionStatus` | the canonical 15-state lifecycle from `executor-lifecycle.ts` |
| `ChildOrderStatus` | the canonical 10-state child lifecycle from `executor-request-defs.ts` |

`ExecutionStatus` imports the canonical vocabulary rather than re-declaring it, so a state
added to the engine cannot silently fail to render. An unrecognised state renders the
`Unknown` treatment rather than throwing — a forward-compatible engine must not crash a
dashboard.

---

## Table atoms

The atomic table layer only. `TableToolbar`, `FilterMenu`, `Pagination`, `BulkActionBar`,
`ColumnVisibility` and full `DataTable` orchestration are **not** here.

| Atom | Notes |
|---|---|
| `Table` | `density` reads `dims(density).row` |
| `TableHeader` / `TableBody` / `TableFooter` | `sticky` permitted on the header |
| `TableRow` | `state`: default/hover/selected/active/disabled/loading/warning/critical |
| `TableCell` | `kind` sets the default alignment |
| `ColumnHeader` | `sortable` makes it a real `<button>` with `aria-sort` |
| `SortIndicator` | direction in the glyph **and** in `aria-sort` |
| `RowSelector` | tri-state through the DOM node's `indeterminate` |
| `ResizeHandle` | a real `<button>`; reports the delta, owns no state |

### Alignment defaults are meaningful

`text` `entity` `status` `date` → left · `numeric` → **right** · `actions` → right ·
`checkbox` → center. A column of prices that is not right-aligned cannot be scanned down its
decimal point.

---

## Visualization atoms

Visual character: **Institutional Minimal**. Subtle grid, muted axis, no glow, no aggressive
gradient, no decorative point markers everywhere, no rainbow categorical palette.

| Atom | Notes |
|---|---|
| `ChartAxis` | muted scaffolding; the title is the accessible name |
| `ChartGrid` | `border-subtle`, 1px, no dashes |
| `ChartLegend` | every entry carries its **label** |
| `ChartTooltip` | values in Geist Mono + tabular |
| `ChartCursor` | a guide, never a value |
| `ChartMarker` | used sparingly; the label is the accessible name |
| `ChartLabel` / `ChartAnnotation` | `role="note"` with a name |
| `ChartReferenceLine` | dashed by construction so it is never mistaken for data |
| `ChartReferenceArea` | the semantic role at low alpha |
| `ChartSeriesIndicator` | legend + live value + direction cue |
| `Sparkline` | sm 64×24 / md 96×32 / lg 128×40, opt-in tooltip |

`SERIES_STYLE` encodes how each kind is drawn, so a **forecast is dashed and dimmed** and
cannot be read as a measurement.

`CATEGORICAL` is a separate palette from the semantic market colours: a chart's fifth series
must not be mistaken for a loss.

There is no chart engine in this repo, so these are SVG and label primitives a Molecule
composes. Complete charts are not implemented here.

---

## Layout atoms

| Atom | Notes |
|---|---|
| `Container` | `product` `editorial` `workspace` |
| `Grid` / `GridItem` | 12-column default; `responsive` is opt-in per prop |
| `Stack` | column; `divided` marks a settings-list stack |
| `Inline` | row |
| `Cluster` | a wrapping row of small equal-weight items |
| `Spacer` | `flex` fills, which is the "push to opposite ends" idiom |
| `ScrollArea` | a real scroll container; the fade is `aria-hidden` |
| `StickyRegion` | hierarchy from surface + border, not a shadow |

Responsive behaviour is **opt-in per prop, never automatic**: a layout that silently reflows
at a breakpoint is a layout that breaks a caller's assumptions.

---

## Accessibility contract

WCAG 2.2 AA globally, AAA for the critical financial foregrounds. Enforced by
`tests/design-system-tests.ts`, which asserts the ratios against **every surface of each
theme**, not merely the page background.

Five rules that are easy to get wrong and are therefore explicit:

1. **Meaning is never colour-only.** A positive delta carries an arrow and a sign; a failure
   carries an icon and a word. `nonColorCues` is the vocabulary.
2. **Focus is never removed.** `focusRingClass` is the replacement — 2px, 2px offset, ≥3:1
   against both theme backgrounds.
3. **Screen-reader-only keeps content in the tree.** `display: none` would remove it.
4. **Disabled is not merely dimmed.** `disabledClass` removes it from the tab order and
   stops a stray click.
5. **Forced colors get borders back.** `forcedBorderClass` restores a system-colour boundary.

No custom keyboard mechanics are introduced: the app's primitives are real
`<button>`/`<input>`/`<select>` elements, so native keyboard behaviour is already correct and
a second implementation would be a second thing to keep correct.

---

## What is deliberately absent

Molecules, Organisms, Templates, Pages, and every composition listed in the plan as
out of scope: `AssetSelector`, `MarketSelector`, `SearchField`, `FilterBar`, `TableToolbar`,
`Pagination`, `OrderTicket`, `OrderForm`, `RiskControl`, `PortfolioCard`, `MetricCard`,
`MarketCard`, `PositionCard`, `Watchlist`, navigation and breadcrumb composition, Command
Palette, modal workflows, execution flows, feature redesigns, page redesigns.

The legacy `src/ui/*.tsx` primitives are left untouched. They are the pre-existing
generation this one supersedes; migrating their call sites is a separate change.

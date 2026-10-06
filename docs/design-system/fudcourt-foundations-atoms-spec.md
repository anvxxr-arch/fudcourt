# FUDCourt Foundations + Atoms — frozen design spec

This document is the **frozen contract** for the FUDCourt design system. It is a faithful
transcription of the approved plan; no new visual decisions are introduced here. Where the plan
leaves an implementation detail open, this spec records the decision made and marks it
`[decision]` so a reviewer can tell contract from choice.

Companion documents:

- [current-ui-audit.md](current-ui-audit.md) — the baseline this was designed against
- [atoms.md](atoms.md) — per-atom contracts (written after implementation)
- [foundations-atoms-review.md](foundations-atoms-review.md) — the architectural review

---

## 1. Principles

### Product personality

```
Institutional: 80%
Degen personality: 20%
```

Target character:

```
Financial Intelligence OS
serious
premium
precise
data-first
calm
high-information
non-casino
non-neon
```

Degen identity may appear later through microcopy, mascots, empty states and community
experiences. It must NOT dominate core financial UI.

### Design architecture

```
Primitive Tokens
        ↓
Semantic Tokens
        ↓
Component Tokens
        ↓
Atoms
        ↓
Molecules     ← NOT IMPLEMENTED HERE
        ↓
Organisms
        ↓
Patterns
        ↓
Pages
```

Hybrid: token-first architecture + Atomic Design vocabulary.

- Atoms consume **semantic** tokens.
- Atoms MUST NOT hardcode primitive colour values unless the primitive itself is being defined.

### Repository location

`$WEB_ROOT = apps/web` (see the audit). Design-system work lives under:

```
src/ui/
src/styles/
scripts/design/
```

Canonical long-term frontend architecture:

```
$WEB_ROOT/src/
├── app/
├── features/
├── ui/
├── lib/
└── server/
```

### Dependency direction

Allowed:

```
atoms → foundations → tokens
atoms → existing primitive wrappers
```

Forbidden:

```
atoms → features
atoms → app
atoms → server
atoms → business APIs
```

Atoms remain environment-independent whenever possible. **No atom performs a network request.**

### Dependencies

Prefer existing dependencies. Do not add a second icon library, class utility, form library,
chart library, animation library or formatting library. No dependency may be added merely for one
trivial atom.

`[decision]` No icon library is installed in the baseline, so the design system ships an `Icon`
atom with a Lucide-compatible API surface and a small internal glyph set rather than adding a
dependency for one atom. Plus Jakarta Sans and Geist Mono are loaded via self-hosted
`@fontsource` packages, which fit the repo's offline build posture.

---

## 2. Colours

### Brand orange

| Token | Value |
|---|---|
| `orange-50` | `#FFF4EC` |
| `orange-100` | `#FFE5D1` |
| `orange-200` | `#FFC79E` |
| `orange-300` | `#FFA267` |
| `orange-400` | `#F57E35` |
| `orange-500` | `#E86A17` |
| `orange-600` | `#C95710` |
| `orange-700` | `#9F430D` |
| `orange-800` | `#79340F` |
| `orange-900` | `#5F2C10` |
| `orange-950` | `#341507` |

Canonical brand: `orange-500 = #E86A17`.

Orange represents **brand/action**. It MUST NOT represent warning.

### Warm graphite

| Token | Value |
|---|---|
| `neutral-0` | `#FFFFFF` |
| `neutral-50` | `#FAF9F7` |
| `neutral-100` | `#F3F1EE` |
| `neutral-200` | `#E6E2DE` |
| `neutral-300` | `#D3CEC8` |
| `neutral-400` | `#AAA39B` |
| `neutral-500` | `#817A73` |
| `neutral-600` | `#625C56` |
| `neutral-700` | `#48433E` |
| `neutral-800` | `#312E2B` |
| `neutral-850` | `#272421` |
| `neutral-900` | `#1E1C1A` |
| `neutral-925` | `#181614` |
| `neutral-950` | `#11100F` |
| `neutral-1000` | `#090908` |

Do not substitute zinc/slate/gray Tailwind colours inside design-system components.

### Market semantic colours

| Semantic | Muted | Vivid |
|---|---|---|
| positive | `#3F8F68` | `#22C55E` |
| negative | `#B85C5C` | `#EF4444` |
| warning | `#AF823B` | `#F59E0B` |
| info | `#4E7FA8` | `#3B82F6` |

Use **muted** semantics for: portfolio, research, economy, analytics, historical data, summary
surfaces.

Use **vivid** semantics only for: live ticks, orderbook, execution state, urgent market signals,
critical alerts.

**Never encode meaning using colour alone.**

> **Contrast adjustment (authoritative).** The plan states that automated contrast tests are
> authoritative and that a value failing its target is adjusted rather than the test relaxed.
> Two values were adjusted at implementation time, both recorded here so the spec and the
> tokens agree:
>
> - `warning-muted` `#B8893E` measured **2.99:1** against the light background — a hair under
>   the 3:1 large-indicator boundary. Adjusted to `#AF823B` (3.28:1 on the light background,
>   3.45:1 on white). Every other muted value already cleared the boundary on every surface.
> - The critical foregrounds below were tuned per theme so that each clears **7:1 on every
>   surface of its own theme**, not merely on the page background. A critical value rendered
>   inside a card must be as legible as one rendered on the canvas.

### AAA critical foreground tokens

Critical financial text targets approximately 7:1 contrast. Theme-aware.

Light:

| Token | Value |
|---|---|
| `positive-critical` | `#285A42` |
| `negative-critical` | `#7C3E3E` |
| `warning-critical` | `#674C23` |
| `info-critical` | `#33546E` |
| `brand-critical` | `#833C0D` |

Dark:

| Token | Value |
|---|---|
| `positive-critical` | `#7CB399` |
| `negative-critical` | `#D29999` |
| `warning-critical` | `#C7A166` |
| `info-critical` | `#8BACC6` |
| `brand-critical` | `#EE9154` |

Automated contrast tests are authoritative. If the actual rendered theme background drops contrast
below target, the **critical variant** is adjusted — not the approved base palette.

---

## 3. Themes

### Light baseline

```
background         neutral-50
surface-primary    neutral-0
surface-secondary  neutral-100
surface-raised     neutral-0
text-primary       neutral-950
text-secondary     neutral-600
text-muted         neutral-500
border-default     neutral-200
border-strong      neutral-300
```

### Dark baseline

```
background         neutral-1000
surface-primary    neutral-950
surface-secondary  neutral-925
surface-raised     neutral-900
text-primary       neutral-50
text-secondary     neutral-400
text-muted         neutral-500
border-default     neutral-850
border-strong      neutral-700
```

### Required semantic aliases (identical names in both themes)

```
background

surface-primary
surface-secondary
surface-raised
surface-overlay

text-primary
text-secondary
text-muted
text-disabled
text-inverse

border-subtle
border-default
border-strong
border-focus

brand-primary
brand-hover
brand-pressed
brand-subtle
brand-border
brand-foreground

positive
positive-subtle
positive-strong
positive-live
positive-critical

negative
negative-subtle
negative-strong
negative-live
negative-critical

warning
warning-subtle
warning-strong
warning-critical

info
info-subtle
info-strong
info-critical
brand-critical

focus-ring
selection

scrim
```

Light and dark themes MUST expose the same semantic token names.

`[decision]` Muted/vivid market colours map to semantic roles as follows: `positive` = muted
positive, `positive-live` = vivid positive, `positive-strong` = the vivid value used for
emphasis, `positive-subtle` = a low-alpha tint of the muted value for surface fills. The same
shape applies to negative, warning and info. Critical foregrounds are the AAA text colours above.

`[decision]` The `.dark` class remains the theme switch (already shipped in `layout.tsx`), with
`prefers-color-scheme` as the pre-hydration fallback. The new semantic tokens are emitted into
both the `:root` block and the `.dark` block by the same generator.

---

## 4. Typography

Primary UI font: **Plus Jakarta Sans**.
Financial/technical font: **Geist Mono**.

Plus Jakarta Sans is used for: headings, navigation, buttons, body, labels, articles,
descriptions.

Geist Mono is used for: price, PnL, percentage, balance, quantity, market cap, volume, wallet
address, transaction hash, block number, latency, technical IDs, order values.

All frequently-changing financial numerics:

```css
font-variant-numeric: tabular-nums;
```

### Type scale

| Variant | Size / line-height | Weight | Family |
|---|---|---|---|
| `display-xl` | 48/56 | 700 | sans |
| `display-lg` | 40/48 | 700 | sans |
| `heading-xl` | 32/40 | 650 | sans |
| `heading-lg` | 24/32 | 650 | sans |
| `heading-md` | 20/28 | 600 | sans |
| `heading-sm` | 16/24 | 600 | sans |
| `body-lg` | 16/26 | 400 | sans |
| `body-md` | 14/22 | 400 | sans |
| `body-sm` | 13/20 | 400 | sans |
| `label-lg` | 14/20 | 600 | sans |
| `label-md` | 13/18 | 600 | sans |
| `label-sm` | 12/16 | 600 | sans |
| `data-display` | 32/40 | 600 | mono |
| `data-lg` | 20/28 | 550 | mono |
| `data-md` | 14/20 | 500 | mono |
| `data-sm` | 12/18 | 500 | mono |
| `data-xs` | 11/16 | 500 | mono |

Reuse existing font loading if present. Do not load duplicate copies of either font.

`[decision]` No font loader exists in the baseline, so the fonts are self-hosted through
`@fontsource` packages and imported once from the design system's stylesheet entry. Geist Mono is
NOT applied to narrative numbers in ordinary article text automatically — only to the financial
variants listed above.

---

## 5. Spacing

8pt-first with 4px micro increments.

| Token | Value |
|---|---|
| `space-0` | 0 |
| `space-half` | 2px |
| `space-1` | 4px |
| `space-2` | 8px |
| `space-3` | 12px |
| `space-4` | 16px |
| `space-5` | 20px |
| `space-6` | 24px |
| `space-8` | 32px |
| `space-10` | 40px |
| `space-12` | 48px |
| `space-16` | 64px |
| `space-20` | 80px |
| `space-24` | 96px |

`2px` is exceptional. Primary layout rhythm: 8, 16, 24, 32, 48, 64.

> **Key-name adjustment.** The plan writes the 2px step as `space-0.5`. A CSS custom
> property whose name contains a dot (`--fc-space-0.5`) is not parseable — the bundler's CSS
> tokenizer reads `0.5` as a number and fails the build. The step is therefore named
> `space-half` (`--fc-space-half`), which is the same value under a name every CSS parser
> accepts. No other step is affected.

---

## 6. Radius

| Token | Value |
|---|---|
| `radius-xs` | 4px |
| `radius-sm` | 6px |
| `radius-md` | 8px |
| `radius-lg` | 12px |
| `radius-xl` | 16px |
| `radius-full` | 9999px |

`radius-full` is appropriate for: avatar, status dot, small metadata badge.

Do not make every control pill-shaped.

---

## 7. Elevation

Primary hierarchy mechanism: **surface + border + spacing**, NOT shadow.

Levels: `0 canvas`, `1 surface`, `2 raised`, `3 floating`, `4 overlay`.

Rules:

```
normal card/panel → no shadow
sticky region → surface/border hierarchy
popover → subtle shadow allowed
dialog → subtle shadow + scrim
```

Do not produce nested shadow cards.

`[decision]` The two permitted shadows are emitted as named elevation tokens (`elevation-floating`,
`elevation-overlay`) rather than raw `box-shadow` strings at call sites, so the "no unapproved
shadow" guard has something concrete to check.

---

## 8. Density

Supported density contracts: `compact`, `default`, `comfortable`. FUDCourt default: `default`
(balanced).

```
trading table → compact
portfolio → default
research → comfortable where useful
```

`[decision]` Density is a **dimension provider**, not a component fork. Consumers read
`density.control.md` / `density.row.compact` etc. There are no `CompactTable` /
`DefaultTable` / `ComfortableTable` implementations.

---

## 9. Grid

Three layout families.

**Product Grid**: 12 columns, 24px default gutter, 24–32px desktop page padding.

**Editorial Grid**: reading column 680–760px, support rail 280–320px, wide breakout up to
~1200px.

**Workspace Grid**: full width, 16px minimum external padding, 8–12px working panel gaps,
resizable-region compatible.

Breakpoints (layout pressure, not device names):

| Token | Value |
|---|---|
| `xs` | 480 |
| `sm` | 640 |
| `md` | 768 |
| `lg` | 1024 |
| `xl` | 1280 |
| `2xl` | 1440 |
| `3xl` | 1600 |

---

## 10. Motion

Philosophy: minimal, utility-first, fast, predictable, non-distracting.

Durations:

| Token | Value |
|---|---|
| `instant` | 80ms |
| `fast` | 120ms |
| `base` | 160ms |
| `slow` | 220ms |
| `panel` | 280ms |

Easing:

| Token | Value |
|---|---|
| `standard` | `cubic-bezier(0.2, 0, 0, 1)` |
| `enter` | `cubic-bezier(0, 0, 0.2, 1)` |
| `exit` | `cubic-bezier(0.4, 0, 1, 1)` |

Realtime tick: semantic flash 150–250ms, then neutral.

Never animate live trading numbers like slot-machine wheels.

Support:

```css
@media (prefers-reduced-motion: reduce)
```

`[decision]` Semantic motion presets are `interactive`, `overlay`, `navigation`, `realtime`,
`panel`. `transition-all` is not the design-system default — each preset names the properties it
animates.

---

## 11. Accessibility

Global target: **WCAG 2.2 AA**. Critical financial information: **AAA where technically
reasonable**.

Critical examples: entry price, mark price, liquidation price, stop loss, take profit, margin,
leverage, position size, max loss, balance, PnL, exposure, order state, execution failure, stale
market data, provider failure.

Targets:

```
normal critical text ≥ 7:1
large critical text  ≥ 4.5:1
UI boundaries        ≥ 3:1
focus indicator      ≥ 3:1
```

Meaning may NEVER rely exclusively on colour, position or animation.

Keyboard support must include where applicable: Tab, Shift+Tab, Arrow keys, Enter, Space, Escape,
Home, End.

Never remove browser focus indication without providing an equivalent or better replacement.

---

## 12. Iconography

Visual style: Lucide-style outline.

```
grid       24×24
stroke     1.5–2px
linecap    round
linejoin   round
```

Sizes: 12, 14, 16, 18, 20, 24, 32. Default application size 16–20px.

Custom icons are allowed only for domain concepts inadequately represented by generic icons
(candlestick, orderbook, depth, liquidity, open interest, funding, liquidation, TWAP, risk
exposure, margin, drawdown, gas, bridge, validator, yield curve, etc.).

Do not build a giant custom icon pack during this phase.

---

## 13. Atom taxonomy (in scope)

### Typography
`Text`, `Heading`, `Label`, `Caption`, `Code`, `DataValue`

### Actions
`Button`, `IconButton`, `Link`, `CopyButton`

### Form — generic
`Input`, `Textarea`, `Checkbox`, `Radio`, `Switch`, `Slider`, `SelectTrigger`

### Form — financial inputs
`AmountInput`, `PriceInput`, `PercentInput`, `QuantityInput`, `CurrencyInput`, `LeverageInput`,
`RiskInput`, `StopLossInput`, `TakeProfitInput`

### Visual
`Icon`, `AssetIcon`, `ChainIcon`, `Avatar`, `Divider`, `Surface`, `Scrim`

### Status
`Badge`, `Tag`, `StatusDot`, `Spinner`, `Skeleton`, `Progress`

### Financial
`Price`, `Currency`, `Quantity`, `Percentage`, `Delta`, `PnL`, `Ratio`, `Yield`, `APR`, `APY`,
`MarketCap`, `Volume`, `DataNumber`

### Market
`AssetSymbol`, `AssetPair`, `Trend`, `Timeframe`, `Confidence`, `MarketStatus`

### Blockchain
`WalletAddress`, `TransactionHash`, `BlockNumber`, `GasValue`

### System
`Timestamp`, `Duration`, `Latency`, `HealthStatus`, `ExecutionStatus`

### Table
`Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableRow`, `TableCell`, `ColumnHeader`,
`SortIndicator`, `RowSelector`, `ResizeHandle`

### Visualization
`ChartAxis`, `ChartGrid`, `ChartLegend`, `ChartTooltip`, `ChartCursor`, `ChartMarker`,
`ChartLabel`, `ChartAnnotation`, `ChartReferenceLine`, `ChartReferenceArea`,
`ChartSeriesIndicator`, `Sparkline`

### Layout
`Container`, `Grid`, `GridItem`, `Stack`, `Inline`, `Cluster`, `Spacer`, `ScrollArea`,
`StickyRegion`

---

## 14. Scope exclusions

Explicitly out of scope — DO NOT implement:

```
Molecules
Organisms
Templates
Pages

AssetSelector
MarketSelector
SearchField composition
FilterBar
TableToolbar
Pagination composition
OrderTicket
OrderForm
RiskControl composition
PortfolioCard
MetricCard
MarketCard
PositionCard
Watchlist
Navigation composition
Breadcrumb composition
Command Palette
Modal workflows
Execution flows
Feature redesigns
Page redesigns
```

Do not opportunistically refactor `src/features/*`, `src/app/*`, server APIs, backend, routing,
data fetching, business logic or provider integrations unless a tiny compatibility change is
strictly required to compile.

Do not migrate every existing page to the new design system in this plan.

---

## 15. Review focus (highest-risk failure classes)

### 1. Financial formatting corruption

Test: negative zero, large values, tiny decimal precision, null, NaN, Infinity.
Expected: stable deterministic output, no misleading financial display.

### 2. Light/Dark semantic drift

Every semantic token must exist in both themes. Expected: identical semantic API, different
primitive mappings.

### 3. Colour-only financial meaning

Positive/negative/error/delayed states must expose non-colour meaning. Expected examples:
`↑ +2.41%`, `Failed + icon`, `Delayed + status label`.

### 4. Realtime layout movement

Financial numerics must not shift width unpredictably when digits update. Expected: Geist Mono,
tabular-nums.

### 5. Atomic boundary leakage

No atom may fetch market data, wallet data, exchange data, portfolio data or API health. Atoms
render state passed to them.

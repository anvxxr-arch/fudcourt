# Design system

One source of truth for every visual value in `frontend/web`, two generated artifacts, and two
gates that fail when either drifts. Decision record:
[DR-037](../records/DECISIONS.md). This document is the operating manual; the records file holds
the reasoning. The read-only baseline it was built against is
[design-inventory.md](design-inventory.md) (value→token mapping, scale histograms, orphan audit).

## Why this exists

The same design value used to live in three places that could diverge, and had:

| Source | What it held | Failure it caused |
|---|---|---|
| `frontend/web/src/styles/tokens.ts` (`C`) | the flat hex table the React tree styles itself from | the real rendered colour |
| `frontend/web/src/app/(frontend)/globals.css` (`:root`) | a SEPARATE set of HSL intents | a second, silently different colour |
| `frontend/web/tailwind.config.js` (`theme.extend`) | nothing — `{}` was empty | no utility class could reach a token at all |

Measured before this change: all seven comparable pairs had drifted. `--background: hsl(160 38% 5%)`
renders `#08120e` while `C.bg` is `#07110f`; `--primary: hsl(153 74% 61%)` renders `#52e5a3` while
`C.accent` is `#3ddc97`; foreground, card, border, destructive and muted had drifted the same way.
The `body` rule used the HSL intents, so the page background and every `C`-styled panel were already
two different colours. On top of that, feature UIs hand-rolled raw hex (`#ffd166`, `#ff9f43`,
`#04140f`, rgba overlays), magic font sizes, paddings and radii — the migration gate counted 1280
hard-scale/colour sites at landing, shrinking as the migration sessions land.

## The model

```
frontend/web/src/styles/tokens.ts          ← SSOT: the only place a design value is written
        │
        │  bun scripts/design/emit-tokens.ts   (deterministic; --check = drift gate)
        ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  src/app/(frontend)/globals.css                              │
   │    :root { --fc-… }   (between the @generated sentinels)     │
   │  tailwind.tokens.json                                        │
   │    colors / spacing / borderRadius / fontSize / fontFamily    │
   └──────────────────────────────────────────────────────────────┘
        │                                   │
        ▼                                   ▼
   inline styles (var(--fc-…), via tokens.ts)   Tailwind theme.extend → utility classes
```

**Cutover state (Apple HIG generation).** The token system follows the Apple Human Interface
Guidelines: semantic backgrounds/labels/separators with a `.dark` flip, HIG accent ramps, the SF
stack, the HIG type scale, an 8pt spacing grid, continuous-corner radii, a 44pt touch target, HIG
motion, and `prefers-reduced-motion` support. The gate reports
`DESIGN_TOKENS_OK (files=257 exemptions=6)` with zero offender lines and zero dead tokens.
`shared.ts` remains the home of the domain palettes and the shared view types/helpers; `styles/`
is still a leaf layer. The pixel change this generation is INTENTIONAL (green accent -> blue,
dark-green chrome -> system backgrounds) — the first generation's value-for-value proof served its
purpose and is retired.

`tokens.ts` is a **leaf module**: no imports, no JSX, `as const` on every object except `darkColor`
(which is typed `{ [K in keyof typeof color]: string }` so a light key without its dark twin is a
compile error; it is consumed by the emitter into the `.dark` block, never referenced at call
sites). It exports `color`, `darkColor`, `space`, `radius`, `fontSize`, `fontWeight`, `lineHeight`,
`letterSpacing`, `zIndex`, `fontFamily`, `motion` and `target`. Every px-keyed scale is keyed by
its own value (`space[12] === 12`, `fontSize[13] === 13`), so reading a call site tells you the
pixel value without opening the token file.

### Var scheme

Emitted by `emit-tokens.ts`, consumed by `tailwind.tokens.json` and by hand-written CSS:

| Token | Custom property | Rendered |
|---|---|---|
| `color.bgBase` | `--fc-color-bgBase` | `#FFFFFF` (`:root`), `#000000` (`.dark`) |
| `color.scrim` | `--fc-color-scrim` | `rgba(0, 0, 0, 0.35)` (`:root`), `rgba(0, 0, 0, 0.6)` (`.dark`) |
| `space[12]` | `--fc-space-12` | `12px` |
| `radius.circle` | `--fc-radius-circle` | `50%` (keyword — rendered verbatim) |
| `fontSize[13]` | `--fc-font-size-13` | `13px` |
| `fontWeight.bold` | `--fc-font-weight-bold` | `700` (unitless, verbatim) |
| `lineHeight.normal` | `--fc-line-height-normal` | `1.6` (unitless, verbatim) |
| `letterSpacing.wide` | `--fc-letter-spacing-wide` | `1` (unitless, verbatim) |
| `zIndex.modal` | `--fc-z-index-modal` | `100` (unitless, verbatim) |
| `motion.normal` | `--fc-motion-normal` | `200ms` (verbatim) |
| `target.min` | `--fc-target-min` | `44px` |
| `fontFamily.mono` | `--fc-font-mono` | `ui-monospace, monospace` |
| `fontFamily.sans` | `--fc-font-sans` | `-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', Inter, ui-sans-serif, system-ui, sans-serif` |

The rule: `--fc-color-<name>`, `--fc-space-<n>`, `--fc-radius-<key>`, `--fc-font-size-<n>`,
`--fc-font-weight-<name>`, `--fc-line-height-<name>`, `--fc-letter-spacing-<name>`,
`--fc-z-index-<name>`, `--fc-motion-<name>`, `--fc-target-<name>`, `--fc-font-mono`,
`--fc-font-sans`. px values render as `Npx`; unitless values (weights, line heights, letter
spacings, z-index) are emitted verbatim so CSS applies its normal numeric semantics;
string-valued entries (`radius.circle`, `motion.ease`) render as written. Every `color` key also
renders a `.dark` override from `darkColor`. The block closes with a `prefers-reduced-motion`
rule that collapses transitions/animations to `0.01ms`. The hand-written `body` rule uses
`--fc-color-bgBase` / `--fc-color-labelPrimary`, the SF stack, and `font-variant-numeric:
tabular-nums` for figures.

### Token set (`tokens.ts`)

| Export | Keys |
|---|---|
| `color` (+ `darkColor` flip) | `bgBase, bgSecondary, bgTertiary, bgElevated, labelPrimary, labelSecondary, labelTertiary, separator, blue, green, red, orange, labelOnAccent, scrim` |
| `space` | `0, 4, 8, 12, 16, 20, 24, 32, 40` |
| `radius` | `0, 8, 10, 12, 16, 20, circle ('50%')` |
| `fontSize` | `11, 12, 13, 15, 17, 20, 22, 28, 34` (HIG largeTitle 34 … caption2 11) |
| `fontWeight` | `regular 400, medium 500, semibold 600, bold 700` |
| `lineHeight` | `tight 1.3, normal 1.6, loose 1.7` |
| `letterSpacing` | `none 0, xs 0.4, sm 0.5, wide 1, wider 2` |
| `zIndex` | `modal 100` |
| `fontFamily` | `mono, sans` (SF stack + tabular-nums on `body` for figures) |
| `motion` | `quick 100ms, normal 200ms, deliberate 250ms, slow 350ms, ease cubic-bezier(0.32, 0.72, 0, 1)` |
| `target` | `min 44` (HIG 44pt minimum tappable target) |
| `alpha(hex, a)` | a function, not a scale: derives a tint from a token (`alpha(color.blue, 0.08)`); never called with `color.scrim` (used verbatim) |

Every key has real consumers in the tree today (the counts are in
[design-inventory.md](design-inventory.md) §A.1–A.2), so **no invented tokens**. "I need a tint of
an existing token" is not a reason to add one — that is `alpha(color.x, a)` below, which derives the
tint from the token instead of minting a near-duplicate of it.

### How the migrated code uses a token

Prefer the token module in TS/TSX — it is typed, so `color.bg` is a compile error:

```ts
import { color, fontSize, space, radius } from '@/styles/tokens';

<div style={{ background: color.surface, border: `1px solid ${color.border}`,
              padding: space[16], borderRadius: radius[8], fontSize: fontSize[13] }}>
```

Tailwind classes are for layout containers and are backed by the same tokens through
`theme.extend` — `bg-surface`, `p-16`, `rounded-14`, `text-13`. Never introduce a raw value in a
component; the migration gate fails on it.

### Tints: `alpha(token, a)`, never an inline `rgba()`

`color` is a flat hex set with no alpha channel, so a tint is derived with the module's `alpha()`
helper. It is the ONLY sanctioned way to make one:

```ts
import { alpha, color } from '@/styles/tokens';

background: alpha(color.accent, 0.08)     // 'rgba(61, 220, 151, 0.08)'
border: `1px solid ${alpha(color.negative, 0.35)}`
```

`alpha(hex, a)` accepts only a 6-digit `#rrggbb` — anything else (`#fff`, an `rgba()` string, a
token NAME rather than its value) **throws at the call site** rather than rendering a transparent
box — and clamps `a` to `[0, 1]`. An `rgba()`/`rgb()` literal in a component is a hard gate
violation: the same tint spelled inline had already drifted once (`#ff6b6b` vs
`rgba(255,80,80,…)`, both meaning "negative at low alpha"), and with `alpha()` there is no
legitimate inline rgb() left. `rgba(0,0,0,0.8)` is therefore not permitted anywhere — it is
`color.overlay`.

## Normalization table (the ONLY permitted value changes)

Everything else in this document is value-for-value. The table below is the one deliberate
exception: values the audit found in the tree that have no exact token and that the migration is
permitted to align to the nearest scale step. Each is a **one-line pixel change** and must be
called out in the migration commit that makes it — it is alignment, not a rename, and any value
change NOT in this table is a bug.

| from | to |
|---|---|
| `fontSize` 9 / 10 / 14 / 16 / 18 / 24 / 32 / 40 (pre-HIG scale) | `fontSize[11]` / `fontSize[11]` / `fontSize[15]` / `fontSize[17]` / `fontSize[17or20]` / `fontSize[22]` / `fontSize[28]` / `fontSize[34]` |
| `borderRadius` 4 / 6 / 14 (pre-HIG scale) | `radius[8]` / `radius[8]` / `radius[16]` |
| `space` 5 / 6 / 10 / 14 / 18 / 28 / 30 (pre-HIG scale) | `space[4]` / `space[8]` / `space[8]` / `space[12]` / `space[16or20]` / `space[32or24]` / `space[32]` |
| `fontWeight.heavy` 800 | `fontWeight.bold` 700 |
| green accent `#3ddc97` / dark-green chrome | HIG `color.blue` `#007AFF` / semantic backgrounds (intentional re-theme) |
| `fontFamily` `'monospace'`, `'ui-monospace, monospace'` | `fontFamily.mono` |
| `fontFamily` `'system-ui, sans-serif'` | `fontFamily.sans` |
| `#4ade80`, `#3fb950`, `#22c55e`, `#06d6a0` | `color.positive` |
| `#f87171` | `color.negative` |
| `#fbbf24` | `color.warn` |
| `#06281c`, `#06120e`, `#07110f` used as TEXT | `color.textOnAccent` |
| `#fff` | `color.textInverse` |
| `rgba(255,80,80,a)` | `rgba(255,107,107,a)` (negative's triple) |
| blog greys `#666` / `#888` / `#999` / `#222` | `color.textMuted` / `color.border` |
| `zIndex: 100` | `zIndex.modal` |

## Generated artifacts and the drift alarm

`emit-tokens.ts` writes exactly two artifacts and nothing else:

1. the `:root` block inside `frontend/web/src/app/(frontend)/globals.css`, delimited by

   ```
   /* @generated design-tokens:start — bun scripts/design/emit-tokens.ts */
   /* @generated design-tokens:end */
   ```

   Text outside the sentinels (the `@tailwind` directives, the hand-written `body` rule) is never
   touched. If the sentinel pair is absent the emitter appends a block; if exactly ONE sentinel is
   present it fails rather than guess where the block belongs.
2. `frontend/web/tailwind.tokens.json`, which `tailwind.config.js` reads into `theme.extend`. The
   config therefore contains zero raw design values.

`tailwind.config.js` reads that JSON through an **absolute path anchored at `__dirname`**:

```js
const tokens = JSON.parse(
  require('fs').readFileSync(require('path').join(__dirname, 'tailwind.tokens.json'), 'utf8'),
);
```

The bare `require('./tailwind.tokens.json')` is **banned**: Tailwind loads config files through its
own loader (and Next/Turbopack re-bundles them), so a relative specifier resolves against the
loader's base rather than this file's directory and can throw `MODULE_NOT_FOUND` during
`next build`. `__dirname` is always the directory holding `tailwind.config.js`.

Determinism is part of the contract: values are emitted in the declaration order of `tokens.ts`,
there is no timestamp, seed, random or environment input, and `--check` re-renders and compares
**byte-for-byte**. Emission run twice is byte-identical (verified: `globals.css`
`md5 3fba01e8eaa7c4d7035b931ff5ac9e79`, `tailwind.tokens.json`
`md5 5a794ff17e77e765796cd79a39d916f9`). The drift gate is therefore real and not decoration:

```
cd frontend/web
bun scripts/design/emit-tokens.ts            # regenerate
bun scripts/design/emit-tokens.ts --check    # TOKENS_OK | TOKENS_DRIFT (+diff, exit 1)
bun run check:design                          # the python migration gate + the --check above
```

A hand-edit to either artifact, or an edit to `tokens.ts` that was not re-emitted, prints
`TOKENS_DRIFT` plus a unified diff and exits 1. `--check` also fails when the sentinels are missing
or when exactly one is present. A successful run reports, e.g.
`TOKENS_OK (14 colors, 9 space, 9 font-size, 60 vars total)`.

## The gates

`frontend/web/scripts/checks/check-design-tokens.py` (offline, Python stdlib only) prints one line
per violation and a machine-readable summary:

```
DESIGN_FAIL: files=152 colors=18 scales=109 deadtokens=6
```

**Hard rules** over `src/**/*.{ts,tsx}`:

- **color-literal** — hex, `rgb(`/`rgba(`/`hsl(`/`hsla(`, or a CSS named colour used as a style
  value. Only the CSS keywords `transparent` / `currentColor` / `inherit` are permitted. There is
  **no rgb() exception**: a tint is `alpha(color.x, a)` (see above), never an inline `rgba()`.
  A named colour counts only if it is on the CSS Colour Level 4 **whitelist**: `fill: 'FILLED'`
  (an event/status pair in `src/platform/executor/engine.ts`) is not a colour and is not reported.
- **scale-literal** — a numeric literal (or non-`var()`/non-zero string) in `fontSize`,
  `borderRadius`, `lineHeight`, `letterSpacing`, `zIndex`, `fontWeight`; and a string literal in
  `fontFamily` / `font` other than `'inherit'`. Literal `0` is always allowed;
  `borderRadius: '50%'` must be `radius.circle`.
- **dead-token** — every exported token must be referenced outside `tokens.ts` and the generated
  artifacts. A reference is `parent.key`, `parent['key']`/`parent["key"]`, or a bare
  `var(--fc-…)`; because the match is textual and position-independent, a token used INSIDE a
  template literal counts (`` `${space[8]}px ${space[10]}px` `` and `` `${alpha(color.negative, 0.08)}` ``
  both keep `space[8]`/`space[10]`/`color.negative` alive). **Exempt: `0`-valued scale entries** (`space[0]`, `radius[0]`, `letterSpacing.none`) —
  they are scale ANCHORS, not choices, and a migration legitimately deletes the last `0` literal
  the day it normalises the scale.

**Hard rules** over `src/**/*.{css,scss}`: raw hex / `rgb(` / `hsl(` outside the generated block,
with the SAME `color_exempt()` exemption list the ts/tsx rules use (so the Payload admin
stylesheet is exempt here for the same reason its components are).

**Soft report (never fails the build)** over `src/**/*.{ts,tsx}`: numeric and string literals in
`padding*`, `margin*`, `gap*`, `top|left|right|bottom` and `width|height|min*|max*`.

```
DESIGN_SOFT: total=711 padding=307 margin=224 gap=69 position=0 size=111
DESIGN_SOFT top-5 padding: '5px 6px'x51, '6'x43, '10'x39, '6px 6px'x39, '6px 8px'x34
```

**Known gap, recorded rather than implied:** those values are a LAYOUT SYSTEM, not a design token
rename. The audit ([design-inventory.md](design-inventory.md) §A.2) found 426 padding sites over 46
distinct values (`'5px 6px'` alone appears 51 times); deciding whether `'5px 6px'` should become
`space[4] space[6]` or stay as an optical correction to an 11px line is a visual redesign that needs
its own review, not a mechanical substitution. They are therefore counted and printed so the debt
stays visible, and are deliberately NOT a build failure.

### Allowlist (raw colours only), and why

| Entry | Justification |
|---|---|
| `frontend/web/src/styles/tokens.ts` | the SSOT itself — where the raw values are written down |
| `frontend/web/src/styles/tokens.ts` | keeps the DOMAIN palettes `CHAIN_COLOR` and `COLOR_PRESETS`: brand/provider colours (chain identity) and the user's own wallet swatches. Data the user picks at runtime, not chrome. The legacy `C` table that also lived here was **deleted** at the cutover (see below) |
| `frontend/web/src/features/*/palette.ts` | **new convention**, matched with `fnmatch` (NOT dict membership — a literal-key lookup would exempt only a file named `*`). When a family genuinely owns a provider/brand palette (chain badges, venue brand colours) it moves to a sibling `palette.ts` named for what it is, instead of being inlined into `ui.tsx`. One file per family; a family with no such palette must not create the file to dodge the gate. The gate FAILS if the glob matches no file, so the entry cannot go inert |
| `frontend/web/src/cms/**` | the Payload CMS surface; `seed.ts` embeds an inline SVG placeholder uploaded as CMS media |
| `frontend/web/src/app/blog/(payload)/**` | the Payload admin/login surface and its own stylesheets. **Not** the whole of `src/app/blog/**`: `blog/page.tsx` and `blog/[slug]/page.tsx` are product chrome and are NOT exempt |

Scale rules are exempted in `src/styles/tokens.ts` only. The gate fails if an exempted exact path
disappears OR if a glob entry matches nothing, so neither the list nor a convention can rot silently.

**The gate is GREEN.** Current verdict: `DESIGN_TOKENS_OK (files=257 exemptions=6)` — zero
offender lines, zero dead tokens. While the migration was in flight it printed
`DESIGN_FAIL: files=… colors=… scales=… deadtokens=…` counting the remaining work; a green run
*before* the migration would have meant the gate was broken, not that the tree was clean, and it
did catch two defects in itself, each fixed with a failure proof: `fill: 'FILLED'` (an
event/status pair in `src/platform/executor/engine.ts`) was read as a CSS named colour, and the
CSS rule ignored the directory exemptions, which left `src/app/blog/(payload)/custom.scss` falsely
red. The named-colour rule is therefore a WHITELIST of the CSS Colour Level 4 names, and both rules
consult one `color_exempt()`. Do not work around it — no per-file silences and no widened property
list; the honest fix is the call site.

**What the gate cannot catch, stated rather than implied.** A token whose *value* is wrong is a
review question, not a textual one. A token consumed ONLY through a Tailwind utility class (`p-12`,
`bg-accent`) leaves no source mention — those names are derived from `tailwind.tokens.json` at build
time — so it would read as dead; if utility-class-only consumption becomes the house style, teach
the gate the utility names rather than silence the alarm. A renamed import (`import { color as c }`)
also reads as dead.

## The atom shelf: `src/ui/`

The presentational shelf holds ATOMS — the smallest reusable leaves. The shelf now lives at
`frontend/web/src/ui/`: the primitives (`Button`, `Input`, `Select`, `Modal`, `Label`, `Card` in
`primitives.tsx`) plus the atoms the feature migrations consolidated:

- `badge.tsx` (`Badge`), `banner.tsx` (`Banner`), `breadcrumb.tsx`, `card.tsx` (`Card` — the
  economy/trade data-module card: a titled `h2` panel), `change-chip.tsx` (`ChangeChip`),
  `checkbox.tsx` (`Checkbox`), `data-table.tsx` (`DataTable`), `feedback.tsx` (`Loading`/`ErrorState`),
  `field.tsx` (`Field`), `meter.tsx` (`Meter`), `navbar.tsx`, `notice.tsx` (`Notice`),
  `page-chrome.tsx` (`PagePanel` / `PagePanelLink`), `page-header.tsx` (`PageHeader` — the one
  shared page header the economy/trade modals both carried verbatim; the prior "NO page-chrome atom"
  call stays for the broader page shell, which still differs per surface), `perm.tsx` (`Perm` —
  tri-state ✓/✕/— with `tone="risk" | "capability"`), `row.tsx` (`Row`), `site-nav.ts`,
  `sparkline.tsx` (`Sparkline`), `stat.tsx` (`Stat`), `status-pill.tsx` (`StatusPill`), `table.tsx`,
  `toolbar.tsx`, `value.tsx` (`Value`).

Shelf rules, enforced by the DR-018 layer gate
(`frontend/web/scripts/checks/check-structure.py`):

- an atom may import **itself only** and `@/styles/**` — never `features/`, `platform/`, `app/` or
  another `components/` shelf; `components/layout/` is the documented exception: composing
  features is its whole job;
- an atom takes props and owns no data access, no store and no route knowledge;
- an atom styles itself from tokens (`color`, `space`, `radius`, `fontSize`) — an atom with a raw
  literal is exactly what the migration gate exists to catch;
- new atoms go on a named shelf; a file dropped directly at `src/components/` fails the structure gate.

Entrance motion: the shelf consumes two hand-written classes from
`frontend/web/src/app/(frontend)/globals.css` — `.fc-fade-in` / `.fc-fade-in-slow` — whose durations
and easing are read from the emitted motion tokens via
`var(--fc-motion-deliberate)` / `var(--fc-motion-slow)` / `var(--fc-motion-ease)`, so the classes
stay in step with `tokens.ts` rather than repeating the values. `src/app/(frontend)/layout.tsx`
wraps `{children}` in `.fc-fade-in`; `Card` (`ui/card.tsx`) eases in with `.fc-fade-in`; `Stat`
(`ui/stat.tsx`) and `Meter` (`ui/meter.tsx`) use the slower `.fc-fade-in-slow`. The
`@media (prefers-reduced-motion: reduce)` guard emitted at the bottom of the token block already
collapses both to `0.01ms`, so the classes need no separate reduced-motion handling.

Two shelf members landed with the shell/admin pass: `ui/meter.tsx` (`Meter` — a part-to-whole
composition bar: one stacked flex track of token-hued segments plus a legend; the caller supplies
raw parts and zero-magnitude values are skipped, so an empty bucket never paints a sliver) and
`ui/page-chrome.tsx` (`PagePanel` / `PagePanelLink` — the one chrome shared by the app router's
route-level `loading.tsx` / `error.tsx` / `not-found.tsx` slots).

**Adoption pass (deferred-list round).** The executor overview (`/executor` reads `ExecutorOverview`,
`/executor/history` keeps the full table), the public market board (`MarketHub` no longer carries its
own `SectionNav` — the `StoreShell` tab strip is the one tab strip), `/economy` snapshots label themselves
differently from the detail pages, and the home surface re-renders summary rows + `Meter` + `Sparkline`
with links to the live boards rather than restating the detail tables. Executor fill is a `Meter`
(filled/remaining), and the quote boards now carry a `Trend` column from the same Yahoo chart payload
(`MarketQuote.trend`), so `Sparkline` reads the already-served data instead of a second fetch.

**Decision: there is NO page-chrome atom.** A shared page shell was attempted for the three page
surfaces (member, admin, login) and then **deleted rather than kept as indirection**: each needed
something a shared shell could not express value-for-value — different wrappers, different
widths, different scroll behaviour — so a common component would have needed props for all three
differences and would have been a rename of the markup rather than a shared atom. The three page
shells are therefore tokenized **in place**: they use `color`/`space`/`fontSize` directly (which is
what the gate measures) and each keeps the structure its own surface needs. That is the rule for
future cases: an atom is extracted when two call sites are genuinely the same thing, not when they
merely look similar.

## The HIG re-theme rule

This generation INTENTIONALLY moves pixels: green accent -> HIG blue, dark-green chrome ->
semantic system backgrounds, off-scale steps -> the nearest 8pt/HIG-type/radius step. Concretely:
- every call site references a token (the gate proves it: no raw literals, no dead tokens);
- px scales stay keyed by their own value, so `fontSize[13]` still reads as 13px without opening the token file;
- the **only** value changes are the rows of the normalization table above plus the HIG palette itself — any value change NOT covered there is a bug;
- the first generation's value-for-value proof served its purpose and is retired with the re-theme.
## How to add a token

A token is a two-part change; **no invented tokens**.

1. **Prove a consumer exists.** Find the real call site(s) that will use the value — a token with no
   consumer is drift in the other direction and the dead-token alarm fails the build for it. Prefer
   reusing an existing token when a value repeats.
2. **Add the value to `frontend/web/src/styles/tokens.ts`**, in the matching scale and in the sorted
   position the other keys occupy (`space: 18`, `fontSize: 24`). Keep the object `as const`.
3. **Regenerate:** `cd frontend/web && bun run tokens`. This rewrites the `:root` block and
   `tailwind.tokens.json`. Commit both artifacts with the token change.
4. **Re-point the call site(s)** to `color.x` / `space[n]` / `fontSize[n]`, or to the Tailwind class
   the new key produces (`p-18`).
5. **Confirm:** `bun run check:design` (migration gate + `--check`) shows the new call sites gone,
   and `bunx tsc --noEmit` is clean.

Removing a token is the same in reverse: delete the consumers first (the dead-token alarm tells you
when that is done), then delete the key, then re-emit.

## Where this is wired

- `frontend/web/package.json` — `bun run tokens`, `bun run check:design`.
- `scripts/verify/verify-all.sh` — two steps immediately after `structure gate (DR-018 layers)`:
  `design-token gate` (the migration gate) and `design-token artifact drift` (the `--check`).
- `.github/workflows/web.yml` — the same two steps beside its structure-gate step.
- `scripts/githooks/pre-push` — both gates for any `frontend/web/` change, in the same idiom as the
  structure-gate block, so a raw literal cannot be pushed without CI being the thing that catches it.

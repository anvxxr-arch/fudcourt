# Current UI audit

Baseline reconnaissance for the FUDCourt Foundations + Atoms plan. Recorded **before** any
design-system change, so every claim below is a measurement of the tree as it shipped, not a
recollection of it.

## Active frontend root

`$WEB_ROOT = apps/web`.

Determined by the plan's location rule:

| Candidate | Exists | Verdict |
|---|---|---|
| `apps/web/` | yes | **active** — `package.json` present, `apps/web/bun.lock` is authoritative (root `package.json` carries no dependencies and no workspace field), `tools/fud.ts test web` targets it, `.github/workflows/web.yml` filters `apps/web/**` |
| `frontend/web/` | no | not present |

The root `package.json` is a deliberately dependency-free command surface (`tools/fud.ts`), so
there is no root workspace to consult and no second candidate to disambiguate. Implementation is
not duplicated anywhere.

## Repository shape

```
apps/web/
├── src/
│   ├── app/            112 files — routes only (Next 16 App Router)
│   ├── cms/              9 files — Payload CMS
│   ├── features/       161 files — one directory per data family
│   ├── lib/            25 files — shared infrastructure
│   ├── server/          3 files — server-only infrastructure
│   ├── styles/          1 file — tokens.ts
│   └── ui/             25 files — presentational primitives
├── scripts/
│   ├── checks/         check-design-tokens.py, check-structure.py
│   └── design/         emit-tokens.ts
├── tests/              21 suites + tests/design/fingerprint.py
└── tailwind.config.js  reads tailwind.tokens.json
```

## Existing token architecture

One source of truth already exists and is governed (decision record DR-037):

```
apps/web/src/styles/tokens.ts          ← SSOT: the only place a design value is written
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

`tokens.ts` is a **leaf module** (no imports, no JSX) exporting:

| Export | Keys |
|---|---|
| `color` (+ `darkColor` flip) | `bgBase, bgSecondary, bgTertiary, bgElevated, labelPrimary, labelSecondary, labelTertiary, separator, blue, green, red, orange, labelOnAccent, scrim` |
| `space` | `0, 4, 8, 12, 16, 20, 24, 32, 40` |
| `radius` | `0, 8, 10, 12, 16, 20, circle ('50%')` |
| `fontSize` | `11, 12, 13, 15, 17, 20, 22, 28, 34` |
| `fontWeight` | `regular 400, medium 500, semibold 600, bold 700` |
| `lineHeight` | `tight 1.3, normal 1.6, loose 1.7` |
| `letterSpacing` | `none 0, xs 0.4, sm 0.5, wide 1, wider 2` |
| `zIndex` | `modal 100` |
| `fontFamily` | `mono, sans` |
| `motion` | `quick 100ms, normal 200ms, deliberate 250ms, slow 350ms, ease cubic-bezier(0.32, 0.72, 0, 1)` |
| `target` | `min 44` |
| `alpha(hex, a)` | derives `rgba()` from a `#rrggbb` token; throws on anything else |

The current palette is the **Apple HIG generation**: semantic backgrounds/labels/separators with a
`.dark` flip, HIG accent ramps, the SF stack, the HIG type scale, an 8pt spacing grid,
continuous-corner radii, a 44pt touch target, and HIG motion. `darkColor` is typed
`{ [K in keyof typeof color]: string }`, so a light key without its dark twin is a compile error —
the light/dark parity guarantee already exists at the type level for the legacy palette.

### Var scheme

`--fc-color-<name>`, `--fc-space-<n>`, `--fc-radius-<key>`, `--fc-font-size-<n>`,
`--fc-font-weight-<name>`, `--fc-line-height-<name>`, `--fc-letter-spacing-<name>`,
`--fc-z-index-<name>`, `--fc-motion-<name>`, `--fc-target-<n>`, `--fc-font-mono`,
`--fc-font-sans`. Every `color` key also renders a `.dark` override. The block closes with a
`prefers-reduced-motion` rule collapsing transitions to `0.01ms`.

## Theme mechanism

- `tailwind.config.js`: `darkMode: 'class'`, `theme.extend` = the whole of `tailwind.tokens.json`
  (read through an absolute `__dirname`-anchored path — a bare relative `require` is banned
  because Tailwind's loader resolves against its own base).
- `src/app/(frontend)/layout.tsx` ships a pre-hydration `<script>` that reads
  `localStorage.theme`, falls back to `prefers-color-scheme`, and toggles `.dark` on
  `<html>`. So dark mode is **class-based with a system-preference fallback**, applied before
  first paint.
- `src/ui/theme-toggle.tsx` is the user-facing switch.

## Class utility

Tailwind CSS 3.4.17 with PostCSS + autoprefixer. `content: ['./src/**/*.{js,ts,jsx,tsx,mdx}']`.
No `clsx`/`cva`/`tailwind-merge` in the app's own dependency graph (`clsx` is present in
`node_modules` only as a transitive dependency of `react-datepicker`, and `date-fns` likewise).
**The house styling convention is inline `style` objects referencing token values**, not utility
class strings — see the "How the migrated code uses a token" section of
`docs/architecture/DESIGN-SYSTEM.md`.

## Icon system

**None installed.** No `lucide-react`, no icon package of any kind. `src/ui/` hand-writes glyphs
as text characters (`✕` in `primitives.tsx`'s Modal close button) and inline SVG
(`src/ui/sparkline.tsx` builds a `<path>` by hand). The plan says to use `lucide-react` if
already installed and otherwise preserve the existing system and expose a Lucide-style API. So
the design system ships its own `Icon` atom with a Lucide-compatible API surface
(`Icon` + `IconButton` taking a Lucide-style component reference) and registers a **small
internal glyph set** rather than adding a dependency for one atom. No dependency is added merely
for a trivial atom (plan §5).

## Fonts

**No font loader exists.** No `next/font`, no `@font-face`, no Google Fonts link anywhere in
`src/` or `public/`. The current stack is the SF system stack
(`-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', Inter, ui-sans-serif,
system-ui, sans-serif`) with a generic `ui-monospace, monospace` fallback for mono.

The plan requires Plus Jakarta Sans (UI) and Geist Mono (financial/data). Both are available as
self-hostable `@fontsource` packages, which fit the repo's offline-first posture (no network at
build time, no third-party CDN). They were installed during this audit and are recorded as the
font-loading strategy; the audit itself makes no functional change to the app's rendering.

## Primitive library

No Radix, no shadcn/ui, no headless component library. `src/ui/primitives.tsx` is a hand-rolled
set: `Button`, `Input`, `Select`, `Modal`, `Label`, plus a re-export of `Card`. Keyboard
behaviour is native (real `<button>`/`<input>`/`<select>` elements with the `fc-focusable`
class providing the focus ring). There is **no second a11y framework** to avoid duplicating.

## Existing UI inventory (`src/ui/`, 25 files)

| File | What it is | Reuse verdict |
|---|---|---|
| `primitives.tsx` | `Button` (3 variants × 3 sizes), `Input`, `Select`, `Modal`, `Label` | **legacy** — 3 variants cannot express the plan's 11; superseded by the atoms layer, kept for existing call sites |
| `badge.tsx` | tone chip (`accent/positive/negative/warn/attention/muted/neutral`) | **legacy** — superseded by `Badge`/`Tag`; tone vocabulary is close but not the plan's controlled union |
| `card.tsx` | titled section panel | **legacy** — a panel, not an atom; superseded by `Surface` |
| `table.tsx` | `Table`/`THead`/`TBody`/`TR`/`TH`/`TD` with measured defaults | **legacy** — the closest existing analogue to the table primitive layer; superseded by the new table primitives |
| `data-table.tsx` | thin wrapper over `table.tsx` | **legacy** |
| `sparkline.tsx` | inline SVG sparkline, em dash below 2 finite points | **legacy** — superseded by the new `Sparkline` atom (sizes sm/md/lg, opt-in tooltip) |
| `value.tsx` | label/value pair with tone + unit | **legacy** — superseded by `DataValue`/`Label` |
| `stat.tsx`, `row.tsx`, `meter.tsx`, `field.tsx`, `feedback.tsx`, `notice.tsx`, `banner.tsx` | feature-shaped compositions (stat block, key/value row, progress meter, labelled field, feedback panel, notice, banner) | **legacy** — several are Molecule-shaped; the plan does not reimplement them, and they are not removed |
| `navbar.tsx`, `breadcrumb.tsx`, `site-nav.ts`, `page-chrome.tsx`, `page-header.tsx`, `toolbar.tsx` | application chrome and navigation | **legacy** — navigation composition is explicitly out of scope |
| `status-pill.tsx`, `change-chip.tsx` | status and signed-change chips | **legacy** — superseded by `StatusDot`/`Badge`/`Delta` |
| `checkbox.tsx` | single checkbox | **legacy** — superseded by the new `Checkbox` |
| `perm.tsx` | permission-gated render | **legacy** — business logic, not an atom |
| `theme-toggle.tsx` | dark/light switch | **legacy** — app chrome |

**No duplicates of the plan's atoms exist** in the sense of two competing implementations of the
same concept with the same API: `primitives.tsx`'s `Button` and the plan's `Button` are different
generations, and the plan's scope explicitly does not migrate existing pages. The one genuine
near-duplicate pair is `sparkline.tsx` (existing) vs the new `Sparkline` atom — handled by
keeping the legacy file untouched and documenting it as migration debt.

## Existing financial formatting

`src/lib/format.ts` is the domain formatter set (market hub): `fmtPrice`, `fmtRate`, `fmtPct`,
`fmtVolume`, `fmtTime`, `fmtCurrency`, `fmtIndicator`, `compactCount`, `tone`. It is
null-tolerant (`—`, never a fabricated `0`) and pure. `src/lib/num.ts` is the text→number pair
(`num`, `numParam`) with the empty-field-is-absent rule.

These are **domain** formatters with product-specific decisions baked in (e.g. `fmtVolume`
renders `0` as `—` because the Yahoo feed sends 0 for unpublished volume). The plan's
`src/ui/atoms/financial/format.ts` is a separate, generic, presentation-layer formatting core
with explicit precision/compact/sign/locale controls. The two coexist: features keep their
domain formatters; the new atoms own generic financial presentation. Documented as a
consolidation candidate for a later phase, not silently merged here.

## Canonical execution status enums (no conflict)

The plan asks the system atoms to use existing domain terminology rather than minting a
conflicting enum. The canonical source is `src/lib/executor-lifecycle.ts` (mirrored by
`apps/executor/internal/execution/lifecycle.go`), and it is a **string union of 15 states**:

```
DRAFT · CALCULATED · VALIDATED · READY · RUNNING · PARTIALLY_FILLED · FILLED
PAUSED · CANCEL_REQUESTED · CANCELLED · FAILED · RISK_STOPPED · EXPIRED
RECONCILING · STOPPED
```

plus the 10-state child-order vocabulary (`PLANNED · SUBMITTING · OPEN · PARTIAL · FILLED ·
CANCELLING · CANCELLED · REJECTED · EXPIRED · UNKNOWN`). The plan's example list
(`pending/submitted/partial/filled/cancelled/rejected/failed`) is a **subset** of the real
vocabulary, so there is no conflict to stop for: the `ExecutionStatus` atom accepts the
canonical `ExecutionStatus` union and maps each state to a label, tone and icon, with an
explicit human-readable label for every state. No new enum is minted.

## Test commands (baseline, all green)

| Command | Result |
|---|---|
| `bun install` | clean |
| `bun run test:shapers` (268 tests) | **268 pass / 0 fail** |
| `bun run build` | **success** (full route list emitted) |
| `python3 scripts/checks/check-design-tokens.py` | `DESIGN_TOKENS_OK (files=337 exemptions=6)` |
| `bun scripts/design/emit-tokens.ts --check` | `TOKENS_OK (14 colors, 9 space, 9 font-size, 60 vars total)` |
| `python3 scripts/checks/check-structure.py` | `STRUCTURE_OK (336 files)` |
| `bunx tsc --noEmit` | clean (implied by the passing `test:shapers`, which runs `tsc -p tsconfig.shaper-tests.json` first) |

**Pre-existing failures: none.** Every gate is green at HEAD, so any red introduced by this plan
is attributable to this plan.

## Known conflicts and constraints carried into the plan

1. **The dead-token alarm.** `check-design-tokens.py` fails on (a) a raw colour literal outside
   the exempt files and (b) any exported token with **no consumer** outside `tokens.ts` and the
   generated artifacts. The plan's palette is a large ramp (11 orange + 16 neutral + 4 market
   families × 2 intensities + 5 critical foregrounds per theme) plus ~30 semantic aliases. If the
   new tokens land without consumers the gate goes red. **Resolution:** the new token surface
   lands together with `src/ui/foundations/color.ts` (Task 4) in one commit, because
   `foundations/` is inside the gate's haystack and references every semantic name; atoms then
   add consumers progressively. The legacy `color`/`darkColor`/`space`/`radius`/`fontSize` exports
   are **not renamed or removed** — 90 files import `@/styles/tokens`, ~65 of them in
   `src/features/*` and `src/app/*`, and a mass rename is exactly the migration the plan forbids.
   Legacy names stay as documented migration debt.

2. **One generated-artifact pipeline, not two.** The plan's structure sketch lists
   `src/styles/generated/tokens.css` *and* the existing sentinel block inside
   `src/app/(frontend)/globals.css`. Two parallel pipelines for the same values is the duplicate
   the plan itself forbids (§4: "modify and consolidate them instead of creating duplicates").
   **Resolution:** the existing emitter is extended and remains the single generator. Its two
   targets stay the sentinel block in `globals.css` and `tailwind.tokens.json`. No
   `src/styles/generated/` directory is created.

3. **Two palettes must coexist.** The legacy HIG palette is consumed by 90 files; the new
   FUDCourt palette is consumed by the new atoms. They are separate token families with separate
   var namespaces (`--fc-color-*` legacy vs the new semantic namespace), emitted by the same
   generator from the same source file. No existing call site changes value.

4. **No class utility for conditional composition.** The house style is inline `style` objects
   with token references. The atoms follow that convention so a second styling convention is not
   introduced, which also keeps them inside the existing gates.

5. **No chart library.** No Recharts/D3/Visx. Visualization atoms are therefore built on inline
   SVG primitives (the same technique `src/ui/sparkline.tsx` already uses), not on a chart
   engine. The plan allows this: "Financial primitives where supported by current chart engine" —
   with no engine present, the atoms expose the vocabulary as SVG/label primitives.

6. **No test framework beyond `node:test`.** The offline suites are `node --test` over
   `tsc`-compiled CommonJS output with a `@/` alias resolver. Design-system tests follow the same
   pattern: TypeScript in `apps/web/tests/`, compiled by `tsconfig.shaper-tests.json`, run by
   `node --test`. React components are exercised through `react-dom/server`'s `renderToStaticMarkup`
   (already a dependency), so no DOM emulator is introduced.

# Design Inventory & Contrast Audit (read-only baseline)

Scope: `frontend/web/src/**/*.{ts,tsx}` (excludes `node_modules`, `.next`, `.shaper-tests`).
Method: source scanning only. No application code was modified. Commands are re-runnable
from `frontend/web/`.

> **Snapshot caveat.** These counts are a point-in-time snapshot taken
> 2026-10-02 ~10:35 UTC at commit `c137929dee9b627c67e8560ee9ddc8340e890a1f` while a sibling
> migration workstream was actively editing `frontend/web/src` (it moved `#04140f` and other
> literals between files during the audit). The *distinct* colour set is stable (48 values)
> but per-value occurrence counts drift as the migration lands; re-run the A.4 commands for
> current numbers. `src/styles/tokens.ts` was untracked (new) at capture.
>
> **Post-audit removals (DR-041, 2026-10-03).** The `/chainrank` and `/khala` boards were removed
> after this capture: `features/{chainrank,khala}/`, their page routes and their Next proxies are
> gone, so the `features/chainrank/ui.tsx` and `features/khala/ui.tsx` sites listed below no longer
> exist (the counts above stay as captured — the caveat applies). The design harness probe set is
> now **15** routes, not 17.

The pinned token spec is implemented in `src/styles/tokens.ts`. This document is the
audit of what the tree actually contains against that spec; it is **findings only** —
no token value was changed here.

---

## A. Inventory

### A.1 Raw colour literals

`#07110f` etc. are matched case-insensitively and lower-cased. Counts include the token
definitions themselves (`src/styles/tokens.ts`) and the legacy `src/styles/shared.ts` `C`
object; those are call sites that will disappear/convert at cutover, not duplicates of
concept.

**48 distinct hex/rgb literals, 131 occurrences**, plus the CSS keyword `transparent`
(13 occurrences). No other CSS colour keywords are used as values.

| count | value | example sites (`file:line`) |
|---:|---|---|
| 13 | `#04140f` | components/layout/store-shell.tsx:163, components/layout/store-shell.tsx:178, components/ui/primitives.tsx:13, features/admin/members-table.tsx:139, features/executor/ui.tsx:185 |
| 10 | `#4ade80` | app/blog/[slug]/page.tsx:34, app/blog/page.tsx:30, features/admin/members-table.tsx:10, features/cryptorank/ui.tsx:1521, features/cryptorank/ui.tsx:1570 |
| 9 | `#3ddc97` | features/scoreboard/ui.tsx:19, features/signals/ui.tsx:52, features/wallets/ui.tsx:48, styles/shared.ts:5, styles/shared.ts:6 |
| 7 | `#ffd166` | features/scoreboard/ui.tsx:23, features/scoreboard/ui.tsx:175, features/scoreboard/ui.tsx:189, features/signals/ui.tsx:53, features/signals/ui.tsx:70 |
| 6 | `#ff9f43` | features/scoreboard/ui.tsx:24, features/scoreboard/ui.tsx:105, features/scoreboard/ui.tsx:181, features/signals/ui.tsx:74, features/signals/ui.tsx:327 |
| 5 | `rgba(255,80,80,0.08)` | features/dex/ui.tsx:266, features/executor/ui.tsx:214, features/llama/ui.tsx:135 |
| 5 | `rgba(255,80,80,0.35)` | features/dex/ui.tsx:266, features/executor/ui.tsx:215, features/llama/ui.tsx:135 |
| 5 | `#14f195` | features/scoreboard/ui.tsx:18, features/signals/ui.tsx:51, features/signals/ui.tsx:355, styles/shared.ts:24, styles/shared.ts:29 |
| 4 | `#fbbf24` | features/dex/ui.tsx:296, features/dex/ui.tsx:357 |
| 3 | `#666` | app/blog/[slug]/page.tsx:39, app/blog/page.tsx:26, app/blog/page.tsx:35 |
| 3 | `rgba(107,143,130,0.35)` | features/signals/ui.tsx:202, features/signals/ui.tsx:256, features/signals/ui.tsx:270 |
| 3 | `#ff6b6b` | styles/shared.ts:8, styles/shared.ts:29, styles/tokens.ts:46 |
| 3 | `#f0b90b` | styles/shared.ts:23, styles/shared.ts:25, styles/shared.ts:29 |
| 2 | `#999` | app/blog/[slug]/page.tsx:48, app/blog/page.tsx:33 |
| 2 | `#222` | app/blog/[slug]/page.tsx:50, app/blog/page.tsx:29 |
| 2 | `#888` | app/blog/page.tsx:25, styles/shared.ts:25 |
| 2 | `#fff` | components/ui/primitives.tsx:14, features/wallets/ui.tsx:73 |
| 2 | `rgba(0,0,0,0.8)` | components/ui/primitives.tsx:99, styles/tokens.ts:49 |
| 2 | `#f87171` | features/admin/members-table.tsx:9, features/dex/ui.tsx:415 |
| 2 | `#3fb950` | features/cryptorank/ui.tsx:1165, features/cryptorank/ui.tsx:1904 |
| 2 | `rgba(255,107,107,0.08)` | features/scoreboard/ui.tsx:99, features/signals/ui.tsx:291 |
| 2 | `rgba(28,58,49,0.4)` | features/scoreboard/ui.tsx:211, features/signals/ui.tsx:349 |
| 2 | `#06281c` | features/ticker/detail.tsx:244, features/ticker/ui.tsx:184 |
| 2 | `#07110f` | styles/shared.ts:2, styles/tokens.ts:37 |
| 2 | `#0d1f1a` | styles/shared.ts:3, styles/tokens.ts:38 |
| 2 | `#1c3a31` | styles/shared.ts:4, styles/tokens.ts:39 |
| 2 | `#6b8f82` | styles/shared.ts:7, styles/tokens.ts:41 |
| 2 | `#e8fff7` | styles/shared.ts:9, styles/tokens.ts:40 |
| 2 | `#8a92b2` | styles/shared.ts:23, styles/shared.ts:29 |
| 2 | `#8247e5` | styles/shared.ts:23, styles/shared.ts:29 |
| 2 | `#0052ff` | styles/shared.ts:24, styles/shared.ts:29 |
| 2 | `#28a0f0` | styles/shared.ts:25, styles/shared.ts:29 |
| 2 | `#ff0420` | styles/shared.ts:25, styles/shared.ts:29 |
| 1 | `#0b1220` | src/cms/seed.ts:103 |
| 1 | `#1e3a5f` | src/cms/seed.ts:103 |
| 1 | `#38bdf8` | src/cms/seed.ts:106 |
| 1 | `#64748b` | src/cms/seed.ts:107 |
| 1 | `#60a5fa` | features/admin/members-table.tsx:11 |
| 1 | `rgba(255,255,255,0.05)` | features/cryptorank/ui.tsx:1560 |
| 1 | `rgba(61,220,151,0.1)` | features/dex/trench.tsx:92 |
| 1 | `#06120e` | features/dex/ui.tsx:223 |
| 1 | `rgba(255,255,255,0.04)` | features/dex/ui.tsx:406 |
| 1 | `#22c55e` | features/llama/ui.tsx:25 |
| 1 | `rgba(61,220,151,0.05)` | features/signals/ui.tsx:350 |
| 1 | `rgba(61,220,151,0.08)` | features/transactions/ui.tsx:151 |
| 1 | `#06d6a0` | styles/shared.ts:29 |
| 1 | `#118ab2` | styles/shared.ts:29 |
| 1 | `#ffffff` | styles/tokens.ts:43 |
| 13 | `transparent` (keyword) | components/ui/primitives.tsx:103, features/cryptorank/ui.tsx:636, features/cryptorank/ui.tsx:702, +10 more |

#### Near-duplicates that should collapse

- **Greens:** `#3ddc97` (token), `#14f195`, `#4ade80`, `#3fb950`, `#22c55e`, `#06d6a0` —
  six values all meaning "positive/up". `#4ade80` (10×) and `#3fb950` (2×) are semantically
  identical to `color.accent`/`color.positive`; `#14f195`/`#06d6a0` overlap `COLOR_PRESETS`.
- **Reds:** `#ff6b6b` (token), `#f87171`, `#ff0420`; plus the off-token alpha pair
  `rgba(255,80,80,…)` which is a *shifted* near-red of `#ff6b6b` (255,107,107).
- **Ambers:** `#ffd166` (warn), `#ff9f43` (attention), `#fbbf24`.
- **Near-black green text-on-accent:** `#04140f` (token `textOnAccent`, 13×), `#06281c`,
  `#06120e`, and `#07110f` (the `bg` token) used as *text* on accent/active pills.
- **Whites:** `#fff` vs `#ffffff` (same value, two spellings), and `#e8fff7` (the `text` token).
- **Blog greys:** `#666`, `#888`, `#999`, `#222` — unrelated to the token palette.

All hex are already lower-case except the three `#FFF`/uppercase forms caught by the
case-insensitive scan; none are 4/8-digit hex.

### A.2 Scale histograms (value → count)

Counts are of literal values only (dynamic expressions such as
`fontSize: size === 'sm' ? 11 : …` are listed separately). Doc-comment lines in
`src/styles/tokens.ts` are excluded.

**fontSize** (468 total, 16 distinct) — token keys are `{10,11,12,13,14,16,18,20,40}`:

| value | 12 | 11 | 10 | 13 | 9 | 16 | 15 | 20 | 14 | 18 | 11.5 | 24 | 34 | 32 | 40 | 12.5 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| count | 132 | 127 | 124 | 32 | 17 | 6 | 6 | 5 | 5 | 4 | 3 | 3 | 1 | 1 | 1 | 1 |

**borderRadius** (117 total, 10 distinct) — token keys `{0,6,8,12,14,full:9999}`:

| value | 6 | 10 | 8 | `'50%'` | 4 | 14 | 12 | 999 | 3 | 2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| count | 70 | 21 | 13 | 6 | 2 | 1 | 1 | 1 | 1 | 1 |

**padding** (426 total, 46 distinct) — top rows; token `space` keys `{0,4,6,8,10,12,14,16,20,24,28,32,40}`:

| value | `'5px 6px'` | 6 | `'6px 6px'` | `'6px 8px'` | 10 | 12 | `'5px 8px'` | 8 | `'6px 5px'` | `'5px 5px'` | `'8px 10px'` | others (36 values) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| count | 51 | 43 | 39 | 37 | 33 | 21 | 17 | 17 | 13 | 13 | 12 | 93 |

**paddingTop** (12): `10`×7, `2`×3, `8`×2 · **paddingRight** (0) ·
**paddingBottom** (3): `24`,`4`,`2` · **paddingLeft** (4): `8`×2, `16`, `14`.

**margin** (85 total, 23 distinct):

| value | 0 | `'0 0 8px'` | `'4px 0 0'` | `'0 0 10px'` | `'0 0 4px'` | `'0 0 6px'` | `'0 auto'` | `'0 0 16px'` | `'2px 0 0'` | others (14 values) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| count | 22 | 16 | 8 | 8 | 7 | 4 | 2 | 2 | 2 | 14 |

**marginTop** (88): `8`×24, `4`×21, `2`×11, `10`×11, `6`×6, `16`×4, `14`×3, then
`24,32,20,30,3,1,5,12` ×1 each. **marginRight** (3): `6,12,14`. **marginBottom** (115):
`6`×42, `12`×22, `8`×19, `4`×11, `10`×9, `16`×4, `14`×3, `20`×3, `40`, `28`.
**marginLeft** (17): `6`×8, `'auto'`×3, `5`×3, `54`, `4`, `8`.

**gap** (110 total, 11 distinct) — `rowGap`/`columnGap` unused (0):

| value | 8 | 10 | 6 | 4 | 12 | 7 | 16 | 5 | 14 | 24 | 18 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| count | 50 | 20 | 17 | 10 | 3 | 2 | 2 | 2 | 2 | 1 | 1 |

**lineHeight** (7 total, 5 distinct) — token `{tight:1.3, normal:1.6}`:
`1.6`×3, `1.7`, `1.5`, `1.4`, `1.3` ×1 each.

**letterSpacing** (31 total, 4 distinct) — token `{none:0, wide:1, wider:2}`:
`0.4`×17, `0.5`×7, `2`×4, `1`×3.

**fontWeight** (155 total, 5 distinct) — token `{regular:400, bold:700}`:
`700`×82, `600`×57, `800`×11, `400`×3, `500`×2.

**fontFamily string literals** (19 total, 4 distinct) — token
`{mono:'ui-monospace, monospace', sans:'Inter, ui-sans-serif, system-ui, sans-serif'}`:
`'monospace'`×10, `'ui-monospace, monospace'`×6, `'system-ui, sans-serif'`×2, `'inherit'`×1.
(No string `font` shorthand literal exists; `font` total 0.)

Dynamic (non-literal) values not covered by the histograms:
`fontSize: size === 'sm' ? 11 : size === 'lg' ? 14 : 12`;
`fontWeight` ternaries `active ? 700 : 400` (×9 across files);
`marginLeft: (s.level - 2) * 10`; `padding: \`${space[10]}px ${space[18]}px\`` (the
migration target example); `marginTop`/`fontSize` inside doc-comment code samples.

#### Per-file top offenders (raw colour + magic numeric literals)

`magic` = count of `fontSize|borderRadius|lineHeight|letterSpacing: <number>` literals.
`rawcol` = count of `#hex|rgb()|rgba()` literals.

| rawcol | magic | total | file |
|---:|---:|---:|---|
| 30 | 0 | 30 | `src/styles/shared.ts` |
| 15 | 28 | 43 | `src/features/signals/ui.tsx` |
| 13 | 0 | 13 | `src/styles/tokens.ts` |
| 11 | 21 | 32 | `src/features/scoreboard/ui.tsx` |
| 9 | 229 | 238 | `src/features/cryptorank/ui.tsx` |
| 8 | 38 | 46 | `src/features/dex/ui.tsx` |
| 6 | 3 | 9 | `src/app/blog/page.tsx` |
| 4 | 49 | 53 | `src/features/executor/ui.tsx` |
| 4 | 6 | 10 | `src/features/admin/members-table.tsx` |

`src/styles/shared.ts` and `src/styles/tokens.ts` are the palette/token definition sites
(counts there are definitions, not usage drift). The genuine per-page drift leaders are
`src/features/cryptorank/ui.tsx` (229 magic scale literals), `src/features/executor/ui.tsx`
(49), `src/features/signals/ui.tsx` (28 magic + 15 raw colours), `src/features/dex/ui.tsx` (38).

### A.3 Value → token mapping

Mapping to the pinned spec in `src/styles/tokens.ts`. "—" means **no token exists**;
those values must not be silently minted during migration.

#### Colours → `color`

| raw value | token | note |
|---|---|---|
| `#07110f` | `color.bg` | |
| `#0d1f1a` | `color.surface` | (legacy `C.card`) |
| `#1c3a31` | `color.border` | |
| `#e8fff7` | `color.text` | (legacy `C.white`) |
| `#6b8f82` | `color.textMuted` | (legacy `C.dim`) |
| `#04140f` | `color.textOnAccent` | |
| `#ffffff` / `#fff` | `color.textInverse` | `#fff` should collapse to `#ffffff` |
| `#3ddc97` | `color.accent` = `color.positive` | |
| `#ff6b6b` | `color.negative` | |
| `#ffd166` | `color.warn` | |
| `#ff9f43` | `color.attention` | |
| `rgba(0,0,0,0.8)` | `color.overlay` | |
| `transparent` | — | CSS keyword; not a token, leave as-is |

#### Colours with **no token** (orphans)

- **Alpha variants of token colours** (not expressible with the flat hex tokens):
  `rgba(61,220,151,0.05/0.08/0.1)` (accent at α), `rgba(255,107,107,0.08)` (negative at α),
  `rgba(28,58,49,0.4)` (border at α), `rgba(107,143,130,0.35)` (textMuted at α),
  `rgba(255,255,255,0.04/0.05)` (white at α).
  The spec has no alpha channel; these need either an `alpha(color, x)` helper or explicit
  retain-as-raw. **Flag for the token owner.**
- `rgba(255,80,80,0.08)` / `rgba(255,80,80,0.35)` — near-negative `#ff5050`, a *different*
  red from `color.negative` `#ff6b6b`. No token. **Flag.**
- Additional greens: `#4ade80`, `#3fb950`, `#22c55e`, `#06d6a0` (and `#14f195` beyond its
  `COLOR_PRESETS` use). No token. **Flag.**
- Additional red: `#f87171`. No token. **Flag.**
- Additional amber: `#fbbf24`. No token. **Flag.**
- Badge/dark text greens: `#06281c`, `#06120e` (text-on-active pills, near `#04140f`). No token. **Flag.**
- `#07110f` used as **text** colour (on accent/active pills) — value *is* `color.bg`; the
  migration should map it to `color.bg`, but note the semantic mismatch.
- Blog greys `#666`, `#888`, `#999`, `#222`. No token. **Flag.**
- `#60a5fa` — member-tier role colour in `TIER_COLOR`. **DOMAIN data**, not a design token.
- `#0b1220`, `#1e3a5f`, `#38bdf8`, `#64748b` — colours inside the `src/cms/seed.ts` hero
  SVG string. **DOMAIN/asset data**, not design chrome.

#### Domain palettes — DATA, not design tokens

Per the `tokens.ts` header these are deliberately excluded; they are **domain data**:

- `CHAIN_COLOR` (`src/styles/shared.ts:22-26`): `#f0b90b` (BSC/Binance), `#8a92b2` (Ethereum),
  `#8247e5` (Polygon), `#14f195` (Solana), `#3ddc97` (Hyperliquid), `#0052ff` (Base),
  `#28a0f0` (Arbitrum), `#ff0420` (Optimism), `#888` (Fiat).
- `COLOR_PRESETS` (`src/styles/shared.ts:29`): `#3ddc97`, `#f0b90b`, `#8a92b2`, `#8247e5`,
  `#14f195`, `#0052ff`, `#28a0f0`, `#ff0420`, `#ff6b6b`, `#ffd166`, `#06d6a0`, `#118ab2` —
  user wallet-swatch choices.
- `TIER_COLOR` (`src/features/admin/members-table.tsx:6-11`): `#f87171`, `#4ade80`,
  `#60a5fa`, `C.dim` — role labels.
- Legacy `C` object (`src/styles/shared.ts`) — retained until cutover, not re-exported.

#### Numeric scales → token

| scale | values found | in token spec | **no token** |
|---|---|---|---|
| space (px) | 0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,16,18,20,24,28,30,32,40,48,54 | 0,4,6,8,10,12,14,16,20,24,28,32,40 (all used) | **1,2,3,5,7,9,11,13,18,30,48,54** |
| radius | 2,3,4,6,8,10,12,14,999,`'50%'` | 0,6,8,12,14,9999 | **2,3,4,10,999,`'50%'`** |
| fontSize | 9,10,11,11.5,12,12.5,13,14,15,16,18,20,24,32,34,40 | 10,11,12,13,14,16,18,20,40 | **9,11.5,12.5,15,24,32,34** |
| fontWeight | 400,500,600,700,800 | 400,700 | **500,600,800** |
| lineHeight | 1.3,1.4,1.5,1.6,1.7 | 1.3,1.6 | **1.4,1.5,1.7** |
| letterSpacing | 0.4,0.5,1,2 | 0,1,2 | **0.4,0.5** |
| zIndex | 100 | 100 | none |
| fontFamily | `'monospace'`,`'ui-monospace, monospace'`,`'system-ui, sans-serif'`,`'inherit'` | `mono`,`sans` | **`'monospace'`,`'system-ui, sans-serif'`,`'inherit'`** |

Notes for the migration: `'50%'` and `'inherit'` are keywords, not scale values;
`borderRadius: 999` is a *different* pill sentinel from the token's `full: 9999`
(one call site, `src/features/cryptorank/ui.tsx:1838`), and `borderRadius: '50%'`
(6×) has no numeric equivalent. fontSize 24 is used only as a display figure
(`features/treasury/*` totals) and 32/34/40 only on blog/admin headings.

### A.4 Reproduction commands

All run from `frontend/web/`. The extractor is a throwaway script (not committed);
its logic is reproduced here so the tables are re-derivable without it.

**Distinct raw colours + counts + examples (A.1):**

```bash
grep -rEno '#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)' src --include=*.ts --include=*.tsx \
  | sed 's/.*://' | tr 'A-F' 'a-f' | tr -d ' ' | sort | uniq -c | sort -rn
grep -rnE "[:{]\s*'(transparent|currentColor|white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|cyan|teal|lime|aqua|fuchsia)'\s*[,;}]" \
  src --include=*.ts --include=*.tsx
```

**Histograms (A.2):** for each property `P` in
`fontSize borderRadius padding paddingTop paddingRight paddingBottom paddingLeft margin
marginTop marginRight marginBottom marginLeft gap rowGap columnGap lineHeight letterSpacing
fontWeight fontFamily font`:

```bash
grep -rEho "P: *('[^']*'|\"[^\"]*\"|\`[^\`]*\`|[^,;}]+)" src --include=*.ts --include=*.tsx \
  | sed -E "s/^P: *//; s/ *$//" | sort | uniq -c | sort -rn
```

(The exact quote-aware token class above is required; a naive `[^,;}]+` swallows the rest
of the JSX line. Values are literals only; ternaries appear once as `X ===`.

**Per-file offenders (A.2):**

```bash
for f in $(grep -rlE '#[0-9a-fA-F]{3,8}\b|rgba?\(' src --include=*.ts --include=*.tsx); do
  a=$(grep -oE '#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)' "$f" | wc -l)
  b=$(grep -oE '\b(fontSize|borderRadius|lineHeight|letterSpacing): *-?[0-9]' "$f" | wc -l)
  printf '%6d %6d %6d  %s\n' "$a" "$b" "$((a+b))" "$f"
done | sort -k3 -rn
```

**Space-scale coverage (A.3):**

```bash
grep -rhoE '\b(padding|margin|gap)[A-Za-z]*: *[^,;}]+' src --include=*.ts --include=*.tsx \
  | grep -oE '[0-9]+px' | sort -t p -n | uniq -c
```

---

## B. Contrast audit (WCAG 2.1)

Exact sRGB relative-luminance math (`c/255`; `c<=0.03928 ? c/12.92 : ((c+0.055)/1.055)^2.4`;
`L = 0.2126R+0.7152G+0.0722B`; `ratio = (L1+0.05)/(L2+0.05)`). Script (throwaway, `/tmp`
only, not committed): `python3 /tmp/design-audit/contrast.py`. **No token value was changed.**

| pair | ratio | AA-normal ≥4.5 | AA-large/UI ≥3.0 |
|---|---:|---|---|
| text / bg | 18.32 | PASS | PASS |
| text / surface | 16.35 | PASS | PASS |
| textMuted / bg | 5.36 | PASS | PASS |
| textMuted / surface | 4.79 | PASS | PASS |
| textOnAccent / accent | 10.68 | PASS | PASS |
| accent / bg | 10.84 | PASS | PASS |
| accent / surface | 9.68 | PASS | PASS |
| negative / bg | 6.90 | PASS | PASS |
| warn / bg | 13.29 | PASS | PASS |
| attention / bg | 9.39 | PASS | PASS |
| **border / bg** | **1.55** | **FAIL** | **FAIL** |
| **textInverse / negative** | **2.78** | **FAIL** | **FAIL** |

Supplementary: `border / surface` = 1.38 (also FAIL), `textMuted / border` = 3.46.

### Failing pairs → recommended replacements

Hue and saturation held fixed (HLS), lightness moved just far enough to reach ≥4.5.
**For the token owner to approve — not applied here.**

| pair | current | ratio | proposed | new ratio |
|---|---|---:|---|---:|
| border / bg | `#1c3a31` on `#07110f` | 1.55 | `#418772` | 4.50 |
| textInverse / negative | `#ffffff` on `#ff6b6b` | 2.78 | `#333333` | 4.55 |

Notes on the two fails:

- **border/bg** is a non-text UI boundary. If the border is meant only as a decorative
  hairline (not a control boundary) it is exempt; as a *control/component boundary*
  (WCAG 1.4.11) it needs ≥3.0. The minimal same-hue/saturation lift to ≥3.0 is
  `#336959` (ratio 3.02); to ≥4.5 it is `#418772` (4.50). The owner picks the target.
- **textInverse/negative** — the fix is ambiguous. Holding H/S and lightening the *text*
  flips white to a mid-grey (`#333333`), which is not "inverse". The semantically cleaner
  fix is to keep white text and **darken the negative surface**: `negative` = `#ee0000`
  gives 4.53 with `#ffffff`. Alternatively use the existing `color.textOnAccent`
  `#04140f` as text on `#ff6b6b` → 6.80 (no token change, but changes the call site).
  Recommend the owner choose the surface-darken option and re-run.

---

## C. Fingerprint harness

`frontend/web/tests/design/fingerprint.py` (committed). Modes:

```bash
PY=/home/dwizzy/farming/.venv/bin/python   # see interpreter note below
$PY frontend/web/tests/design/fingerprint.py capture --base-url http://127.0.0.1:3211 \
  --out /tmp/design-baseline/fpS1.json
$PY frontend/web/tests/design/fingerprint.py compare --base-url http://127.0.0.1:3211 \
  --baseline /tmp/design-baseline/fpS1.json --out-json /tmp/design-baseline/fpS-compare-default.json
```

**`ROUTES` drifted; `routes --check` is the fix.** The harness only guarantees the routes its own
`ROUTES` list names, and a route the tree adds is invisible until someone edits that list. That is
exactly what happened: the rival IA rework replaced `/ticker`, `/llama`, `/dex`, `/trench`,
`/tracker` with the `/market` hub, and edited `ROUTES` to match, so the harness silently covered a
different surface than the one the migration was proven against. `routes --check` derives the app's
page routes from `frontend/web/src/app/**/page.tsx` (route groups stripped, dynamic segments kept
literal) and **fails (exit 1)** naming any page route that is neither probed nor in the file's
`EXCLUDED_ROUTES` map (each entry carries the reason it cannot be probed). Reconciled 2026-10-02 to
**15 probes** covering every page route the app serves except the 14 documented exclusions:
session-gated tier pages (`/admin`, `/member`, `/executor{,/[id],/accounts,/history,/new,/settings}`,
`/team/{balance,portfolio,reconciliation,transactions,wallets}` — they redirect to `/login` for an
anonymous harness, which has no session mechanism) and the Payload admin SPA
(`/blog/cms/admin/[[...segments]]`). Probes: `/`, `/market`, `/market/{crypto,trench,forex,stock,commodity}`,
`/market/ticker/BTC` (the concrete probe for dynamic `/market/ticker/[ticker]`), `/news`,
`/cryptorank`, `/scoreboard`, `/signals`, `/login`, `/blog`, `/blog/never-fake-rules`
(the concrete probe for dynamic `/blog/[slug]`). Per route: `wait_until="networkidle"`
+ 3000 ms settle, up to 400 probes from `document.querySelectorAll('*')` where the element has
a non-zero visible box; computed styles only, **no text content**. Deterministic key order:
`i, tag, path, fontSize, fontFamily, fontWeight, lineHeight, letterSpacing, color,
backgroundColor, borderTopWidth, borderTopColor, borderRadius, padding, margin, gap, textAlign`.
`compare` re-captures live and joins on `(tag, path)`, where `path` is a **structural address**
(`html>body[0]>div[1]>…`, each segment `tag[nth-of-same-tag-sibling]`). A flat document-order
index was proven unstable: live boards insert/remove rows, shifting every downstream index while
the tag can still coincide — measured 492 phantom diffs on `/trench` with an `i`-based join. A
baseline probe with no live counterpart at the same `(tag, path)` (or whose tag differs) is
SKIPPED; matched probes with any compared property differing are DIFFs; exits 1 iff diffs > 0;
≤50 diff lines printed as `route[i] prop: expected != actual` then
`FINGERPRINT: compared=N skipped=M diffs=D`.

**Interpreter:** the documented harness venv `~/.hermes/cache/scratch/crvenv/bin/python`
**does not exist on this host** (and neither does the `~/.hermes/cache/scratch/crvenv`
directory). `python3` (/usr/bin/python3) has no `playwright`. The interpreter used here is
`/home/dwizzy/farming/.venv/bin/python` (playwright 1.62.0, Chromium present in
`~/.cache/ms-playwright/chromium-1243`). Any of the sibling venvs with playwright also work
(`gonka24-automator`, `outlook-creator`, `tt-register`, `turnstile-solver`); the docstring in
`frontend/web/tests/dom_audit.py` still references the missing crvenv path.

---

## D. Baseline run

Full metadata: `/tmp/design-baseline/build-meta.txt`.

- `cd frontend/web && unset NODE_ENV && bunx tsc --noEmit` — exit **0**, no output
  (`/tmp/design-baseline/tsc.log`, empty).
- `cd frontend/web && unset NODE_ENV && bun run build` — exit **0**
  (`/tmp/design-baseline/build.log`). `.next/BUILD_ID` read from the build that the server
  booted = `WRMvBF2Bc8uvEwzAzz_ap`.
- Served on **Port 3210** (free at start):
  `unset NODE_ENV && bun --bun node_modules/next/dist/bin/next start -p 3210`,
  log `/tmp/design-baseline/next-3210.log`; ready in **165 ms**, HTTP **200** on `/login`.
- Capture: `/tmp/design-baseline/fingerprint.json`, `captured_at`
  `2026-10-02T10:37:40.702646+00:00` — **13 routes, 3679 probes** (per-route: `/` 400,
  `/ticker` 400, `/news` 205, `/khala` 92, `/chainrank` 68, `/llama` 400, `/dex` 262,
  `/cryptorank` 400, `/scoreboard` 281, `/signals` 400, `/trench` 362, `/tracker` 400,
  `/login` 9).
- Deployed **3100** drift (`http://127.0.0.1:3100` answered 200; unit NOT touched):
  `compare --base-url http://127.0.0.1:3100 --baseline /tmp/design-baseline/fingerprint.json`
  → `FINGERPRINT: compared=3464 skipped=215 diffs=558`, exit **1**.
  Diff dump `/tmp/design-baseline/diff-3100.json`. Of the first 50 kept diff lines,
  `color` 35, `fontFamily` 8, `fontWeight` 3, `fontSize` 2, `lineHeight` 2 — i.e. the
  deployed chrome differs from current source predominantly in colour/mono-family choices.
- The 3210 server was **killed** at the end (pid 1685109; port 3210 no longer listening).
  3100 still answers (the systemd unit was never restarted or reconfigured).

**Concurrency caveat (not verified against my own build):** while this audit ran, sibling
workstreams committed to the repository (`HEAD` moved from `c137929` at capture to
`241ae4e…` at report time), and `frontend/web/.next` was rebuilt by another process — the
`.next/BUILD_ID` on disk is now `a3V_YCByVvUkb0rxJEC38`, not the `WRMvBF2Bc8uvEwzAzz_ap`
my 3210 server booted. The 3210 capture reflects the build present at 10:37 UTC; the
worktree hash recorded at capture (`git status --porcelain | sha1sum` =
`2729039d1fc77cf4650183597070e1086e2d818f`, 16 lines) differs from the current worktree.
Any later `compare` must re-capture a fresh baseline.

---

## E. Cutover procedure (Fingerprint verification backbone)

This is the gate the token migration is judged by. Two rules govern it:

> **Any UNEXPECTED diff is a migration bug.**
> **An EXPECTED diff MUST cite the normalization-table row that authorizes it**
> (in the budget entry's `reason`). There is no third category.

### E.1 Prerequisites and interpreter

Interpreter: **`/home/dwizzy/farming/.venv/bin/python`** (playwright 1.62.0; Chromium in
`~/.cache/ms-playwright`). The `~/.hermes/cache/scratch/crvenv/bin/python` named in
`frontend/web/tests/dom_audit.py` **does not exist on this host**; `/usr/bin/python3` has no
playwright. Any sibling venv with playwright also works (`gonka24-automator`, `outlook-creator`,
`tt-register`, `turnstile-solver`).

**Serving caveat (learned the hard way):** a bare `cp -a .next /tmp/...` snapshot is not
runnable. To serve a frozen build immune to sibling rebuilds of `frontend/web/.next`, the
snapshot dir needs `node_modules` (symlink), `package.json`, `next.config.js`, `public/`, and
the app env files (`frontend/web/.env.local` plus repo-root `.env`) — without the env files
`/` and `/ticker` never reach `networkidle` and the capture records only partial DOM.
**LIVE-UNIT BUILD TRAP (do not run step 1 in place while `fudcourt-web` is live).** The
`fudcourt-web` user unit runs `next start -p 3100` with `WorkingDirectory=/home/dwizzy/fudcourt/frontend/web`
and `NODE_ENV=production`, i.e. it serves the **same** `frontend/web/.next` directory that
`unset NODE_ENV && bun run build` rewrites — and a build does NOT restart the unit. So a build
run in place swaps the served build out from under a live process: routes keep answering 200
from already-rendered HTML while a `/_next/static/chunks/*.js` the HTML still references returns
**500**, because the build replaced that file. The mismatch is provable without touching the
unit: compare the unit's `ExecMainStartTimestamp` with `.next/BUILD_ID`'s mtime
(`systemctl --user show fudcourt-web -p ExecMainStartTimestamp --value` vs
`stat -c %y frontend/web/.next/BUILD_ID`) — a BUILD_ID written *after* the unit started means the
unit is serving a build whose chunks have since been replaced. A peer workstream measured this
today on `:3100`. The rule: **run the fingerprint's build against a FROZEN COPY of the app**
(the E.7 recipe — `git archive HEAD` or a worktree snapshot, hardlinked `node_modules`, the env
files), never in `frontend/web` while the unit is live. If a build in place is unavoidable, say
so explicitly and tell the operator the unit needs a restart afterwards (the restart is the
operator's call; the fingerprint procedure never restarts or reconfigures the unit). This is a
property of the whole repo's gates — CI, `scripts/verify/verify-all.sh` and the pre-push hook all
build — not of the design system alone; the design harness merely has a reason to build at an
arbitrary time.

### E.2 The ignore-list (measured, not assumed)

Two captures of the **same build** must compare clean. Four same-build captures of the frozen
build `H3Jf_xoah_HRz03Pdpv_z` (fpS1…fpS4, see E.3) were compared pairwise (6 pairs). The **only**
unstable `(route, prop)` pairs, with total divergence across the 6 pairs, were:

| route | prop | Σ across 6 pairs | cause |
|---|---|---:|---|
| `*` (all) | `color` | `/` 77, `/ticker` 77, `/signals` 85, `/dex` 34, `/tracker` 12 | value-bound: a 24h % cell / price renders green or red by the direction of the latest tick |
| `/signals` | `fontWeight` | 90 | live status-dot active/inactive (700↔400) |
| `/signals` | `backgroundColor` | 45 | live status-dot (transparent↔`rgb(28,58,49)`) |
| `/signals` | `borderRadius` | 45 | live status-dot (`0px`↔`50%`) |
| `/trench` | `padding` | 9 | live expand/collapse row state |

Every other `(route, prop)` pair was **stable in all 6 pairs** and is compared strictly
(it may NOT be ignored). These five are the harness default `VOLATILE_PROPS`. They are content
/ state, not chrome, so no settle time removes them and they are not migration signals.

* **Default** `compare` applies the ignore-list → a same-build run reports `diffs=0`.
* **`--strict`** disables the ignore-list (every compared property, including `color`). This is
  the mode the token-migration cutover uses, **together with `--budget`**, because there colour
  is exactly what is under test and the intended re-points are authorized per-row instead of
  being skipped wholesale.

### E.3 Run sequence

```bash
PY=/home/dwizzy/farming/.venv/bin/python
cd frontend/web && unset NODE_ENV && bunx tsc --noEmit && bun run build

# 1. PRE-MIGRATION baseline. Capture it from the UNMIGRATED build with the CURRENT
#    harness (fpA.json is a legacy index-based capture and is refused — see E.4).
#    FREEZE THE BUILD FIRST (E.1 "LIVE-UNIT BUILD TRAP"): either build in a frozen copy,
#    or leave the app alone and copy the CURRENT build out with the E.1 file list. Do NOT
#    `bun run build` in place while the :3100 unit is live — the unit serves the same .next.
$PY tests/design/fingerprint.py capture --base-url http://127.0.0.1:3211 \
  --out /tmp/design-baseline/baseline.json
# 2. Build the migrated tree, serve it on a scratch port that is FREE (3211 here):
unset NODE_ENV && bun --bun node_modules/next/dist/bin/next start -p 3211 \
  > /tmp/design-baseline/next-3211.log 2>&1 &
#    poll until readiness:  curl -sf http://127.0.0.1:3211/login -o /dev/null && echo ready

# 3. Capture the migrated build:
$PY tests/design/fingerprint.py capture --base-url http://127.0.0.1:3211 \
  --out /tmp/design-baseline/fp-after.json

# 4a. Strict compare against the baseline — real chrome diff, exit 1 iff any diff:
$PY tests/design/fingerprint.py compare --base-url http://127.0.0.1:3211 \
  --baseline /tmp/design-baseline/fp-after.json   # (self-check: default mode must be diffs=0)

# 4b. Flakiness self-check: capture twice a few minutes apart and compare — MUST be diffs=0.
# 4c. Cutover compare WITH budget — only intended re-points may be EXPECTED:
$PY tests/design/fingerprint.py compare --base-url http://127.0.0.1:3211 \
  --baseline /tmp/design-baseline/baseline.json \
  --strict --budget /tmp/design-baseline/budget.json \
  --out-json /tmp/design-baseline/diff-budget.json
#    → FINGERPRINT: compared=N skipped=M expected=E unexpected=U ; exit 1 iff U>0
```

**Budget file** (`/tmp/design-baseline/budget.json`):
```json
{"expected": [{"route": "/ticker", "prop": "fontSize", "from": "11.5px", "to": "12px",
               "reason": "normalization table row ##"}],
 "rules":    [{"route": "*", "prop": "color", "reason": "palette re-point, row ##"}]}
```
Route/prop match exactly or are `*`; `from`/`to` are optional and, when present, must equal the
baseline/live values. A starting budget authorizing the four measured volatile pairs lives at
`/tmp/design-baseline/budget-volatile.json`.

### E.4 Artifacts (NOT committed) and their hashes

All under `/tmp/design-baseline/`; **none are committed** — reproduce them with E.3.

| artifact | sha256 | captured_at / notes |
|---|---|---|
| `fpA.json` | `e7319b5f98e44e81b78f86996bec6895d3f92ae22dafc6fb6db317b6f7df70db` | `2026-10-02T11:52:01Z`; **legacy `i`-based schema** (no `path` key) |
| `fpS1.json` | `26f1d646a73fb22839e1f65f1f13eeb9eb7ae0281bfa29e29cf059d2cb854516` | `2026-10-02T12:16:15Z`; current schema |
| `fpS2.json` | `14ce4b7318a4ab8efa4f3af29c66a51d65be31a8c5eae5acf59304231947c33b` | `2026-10-02T12:20:46Z`; current schema |
| `fpS3.json` | `bca42569c34cfe7dce5ba5108c37183f0aa73e84c8abce52d6ebf9588d6800df` | `2026-10-02T12:25:43Z`; current schema |
| `fpS4.json` | `8431fb9b5a44943b3a581e6112f482fdf78f3f67e50644c356da6b9acd500581` | `2026-10-02T12:35:02Z`; current schema |
| `fingerprint.json` | `—` | 2026-10-02T10:37:40Z; the section-D 3210 capture, legacy schema |

**Pre-migration baseline caveat (CORRECTION of the earlier claim).** `fpA.json` was captured
from a local rebuild at commit **`c137929`** on port 3211, **not** from the 3210 build. Because
`/tmp/design-baseline/.next` was rebuilt by a sibling workstream *between* the fpA (11:52) and
fpB (11:56) captures, the exact build id behind fpA is **UNVERIFIED** — the on-disk
`.next/BUILD_ID` was `ZQ-fp8G6CI5hKRebeGtiC` when fpA's server started (11:51:44) and
`6VjNogJh4zRiMY4qKKbpU` by 11:56. Any cutover compare MUST first re-capture a fresh baseline
with the current harness rather than trusting fpA's build identity.

**Frozen-build captures** (`fpS1`…`fpS4`) are reproducible: build id `H3Jf_xoah_HRz03Pdpv_z`,
git HEAD `34fede68e5e40cd0a40c0d96b866bdbac7a8d22e`, worktree `git status --porcelain | sha1sum`
= `5b68a2f35060ca7e3fd9aadcb12503ce4c95638a`, served from the frozen copy under
`/tmp/design-baseline/build-frozen/` (see E.1 for the required files).

### E.5 Same-build flakiness evidence

| check | result |
|---|---|
| fpS1 vs fpS2 (file-vs-file, offline) | compared=3755 skipped=4; non-color diffs=**0**; color=35 |
| fpS1 vs fpS3 | compared=3672 skipped=87; non-color = the /signals cluster + /trench padding |
| fpS2 vs fpS3 | compared=3676 skipped=83; same clusters |
| harness `compare` default (must be clean) | `FINGERPRINT: compared=3565 skipped=194 diffs=0`, exit 0 |
| harness `compare --strict` (ignore-list off) | `diffs=71`, exit 1 (the volatile pairs) |
| harness `compare --strict --budget` (volatile authorized) | `compared=3568 skipped=191 expected=86 unexpected=0`, exit 0 |

The **SKIPPED** set is entirely explained by live-data table row presence: in fpS1↔fpS2 every
skip is on `/` and `/ticker`, on `table>tbody>tr[…]` (a `<tr>` plus its cell `<div>` present in
one capture and absent in the other). No skip occurs on any static route, so no chrome probe is
silently dropped. (The stale `…skipped=74/161…` in the intermediate one-off runs reflected a
lagging row count at capture time, not a static-probe loss.)

### E.6 Interpreter and hygiene

- Harness interpreter: `/home/dwizzy/farming/.venv/bin/python`. Harness sha256 at this writing:
  `b2e8fc06f4c4eea79f73a4e17e12413aee59b3c0a4d46bc9bc145cbd880287b1` (the `routes --check`
  release; the migration-cutover hash was `5e02461b1e42f51c999ec25dca293b9b4822c97f7ff66c3d4118c739490796fa`).
  Re-check coverage with `$PY frontend/web/tests/design/fingerprint.py routes --check` (exit 1 on drift).
- Ports: scratch server on **3211** (killed at the end of this procedure); the deployed
  **3100** systemd unit is never restarted or reconfigured by this procedure.
- Nothing under `frontend/web/src/` is modified by the harness.

### E.7 Provenance-clean HEAD baseline (the authoritative pre-migration state)

The whole token migration is **uncommitted** work on top of HEAD, so the committed tree is the
pre-migration state and the only defensible baseline is built from HEAD **bytes**, not from a
working-tree snapshot (every capture in E.3/E.4 was taken from live trees that siblings rebuilt
mid-run). The reference baseline is now **`/tmp/design-baseline/baseline-head.json`**.

Recipe (writes nothing inside the repo, touches no git worktree/stash/commit):

```bash
BASE=/tmp/design-baseline/head-tree
git archive HEAD -o /tmp/design-baseline/head-tree.tar
mkdir -p "$BASE" && tar -x -C "$BASE" -f /tmp/design-baseline/head-tree.tar
cd "$BASE/frontend/web"
cp -al /home/dwizzy/fudcourt/frontend/web/node_modules node_modules   # HARDLINK, not symlink (see below)
cp /home/dwizzy/fudcourt/frontend/web/.env.local .env.local
cp /home/dwizzy/fudcourt/.env .env
unset NODE_ENV && bunx tsc --noEmit && bun run build
nohup bun --bun node_modules/next/dist/bin/next start -p 3212 > /tmp/design-baseline/next-3212.log 2>&1 &
$PY frontend/web/tests/design/fingerprint.py capture --base-url http://127.0.0.1:3212 \
  --out /tmp/design-baseline/baseline-head.json
```

Two gotchas that cost a build each: a **symlinked** `node_modules` fails Turbopack
(`Symlink [project]/node_modules is invalid, it points out of the filesystem root`) — hardlink
(`cp -al`) works and is cheap; and without the app env files `/` and `/ticker` never reach
`networkidle`. `public/` is absent from HEAD **and** from the live app — no route references a
public asset, so the 13 audited routes are unaffected.

Provenance is a **commit + tree hash**, not a worktree hash, and lives in
`/tmp/design-baseline/head-tree-meta.txt`:

| field | value |
|---|---|
| `git rev-parse HEAD` | `9c01aa32c722aa894bb659e193d91addb46f8b53` |
| `git log -1` | `9c01aa32c722aa894bb659e193d91addb46f8b53 2026-10-02T12:08:27+00:00 refactor(executor): the tracked DDL is the sole owner; store.ts reads it` |
| `git rev-parse HEAD^{tree}` | `deeed3defb19be74c1856a4f413d70e1fd614455` |
| tarball sha256 | `7cb3b561eef9b75a3a02cbf429e57793f283cdde7396b0f686ffe6da4deac836` |
| HEAD build id | `6Vit91HAQAI3IB0wk3j18` |
| tsc / build exit | `0` / `0` |
| `baseline-head.json` sha256 | `880e5074ed0a0a7763159849620bb6d0a4cc24e055cbc4bd30878e7ffdd1a5d5` |
| flakiness re-check (default compare, same HEAD build) | `FINGERPRINT: compared=3656 skipped=0 diffs=0`, exit 0 |

Per-route probes (total 3656): `/` 400, `/ticker` 400, `/news` 205, `/khala` 92, `/chainrank` 68,
`/llama` 400, `/dex` 223, `/cryptorank` 400, `/scoreboard` 281, `/signals` 400, `/trench` 378,
`/tracker` 400, `/login` 9.

**Cutover verdict rule.** The verdict is a **`--strict --budget`** compare of a build produced
from the *migrated worktree* against `baseline-head.json`:

```bash
cd <migrated worktree>/frontend/web && unset NODE_ENV && bunx tsc --noEmit && bun run build
unset NODE_ENV && bun --bun node_modules/next/dist/bin/next start -p 3213 > /tmp/design-baseline/next-3213.log 2>&1 &
$PY frontend/web/tests/design/fingerprint.py compare --base-url http://127.0.0.1:3213 \
  --baseline /tmp/design-baseline/baseline-head.json --strict \
  --budget /tmp/design-baseline/budget.json --out-json /tmp/design-baseline/diff-budget.json
#   exit 0 iff unexpected==0. ANY unexpected diff is a migration bug.
```

`--strict` is non-negotiable here: without it the five volatile pairs (E.2) are silently
ignored, but the migration also legitimately changes `color`/`backgroundColor`, so colour must be
compared and the intended changes authorized per-row in the budget instead.

**Diff classes that MUST be authorized in the budget** (each with its legitimate reason):

| diff class | routes | why legitimate | budget entry shape |
|---|---|---|---|
| normalization-table rows | wherever the migration lands them | value-for-value token substitution — the pixels must NOT change, so these should in fact be **`unexpected`**; only genuine normalizations (e.g. `#fff`→`#ffffff`) belong here | `{"expected":[{"route":"<r>","prop":"<p>","from":"…","to":"…","reason":"normalization row ##"}]}` |
| `body` background + text | **one `backgroundColor` per route** (all 13) | `globals.css` moved off the drifted HSL `:root` onto the token values, so the page canvas changes once | `{"route":"*","prop":"backgroundColor","from":"<old>","to":"<new>","reason":"globals.css :root → tokens (E.7)"}` |
| the five measured volatile pairs | `color` (`*`), `/signals` {fontWeight, backgroundColor, borderRadius}, `/trench` padding | live-data / live-state flips, not chrome (E.2) | a starter file already exists: `/tmp/design-baseline/budget-volatile.json` |

Every budget entry's `reason` MUST cite the row/section that authorizes it; an entry that cannot
cite one does not belong in the budget.
**Provenance-clean rule and the worktree baseline (added 2026-10-02, post-IA-rework).** The rule
above holds only while the tree is clean: the whole point of a HEAD-bytes baseline is that the
committed bytes ARE the surface. Once the product IA rework went in and the market families were
still being edited, the worktree was **dirty** (84 entries under `frontend/web`), so a HEAD-bytes
build would have been a surface the design system no longer serves. In that state the defensible
baseline is the **worktree build**, captured from the worktree and **labelled as such** — never a
HEAD claim. That baseline is `/tmp/design-baseline/baseline-worktree.json` (`sha256
d5036b36ffdfde993b5c24601890b10a01ded8974c30c3e3adb038543e0343d9`), from HEAD
`f50f9a608d25b0e116f37d94555f174f8650ecb8` with worktree `git status --porcelain -- frontend/web`
sha1 `1ba0adc1f59260c3182bd61ed5f95b46c72d51e3`, build id `2U-N1k2ze8lB7a0QbQQc_`, served on port
3214; 17 routes / 2744 probes; same-build default compare `FINGERPRINT: compared=2701 skipped=43
diffs=0`. Full metadata in `/tmp/design-baseline/worktree-baseline-meta.txt`.

### E.8 Deployed `:3100` drift measures (read-only, informational)

Comparing `baseline-head.json` against the live deployed unit (never restarted) at the time of
writing: `compare` → `FINGERPRINT: compared=419 skipped=3237 diffs=782` (offline file-vs-file
capture: compared=450 skipped=3206 diffs=860; prop classes `lineHeight` 448, `borderTopColor`
238, `fontFamily` 78, `fontSize` 22, `fontWeight` 21, `color` 19, `margin` 19, `backgroundColor`
13, `padding` 2). **Confound:** `:3100` returned only 746 probes vs the baseline's 3656 — its
data tables are empty (3206–3237 skips), so this number is dominated by empty-table effects, not
pure design drift, and `:3100`'s build identity is UNVERIFIED. Treat it as a "the deployed unit
is not comparable right now" signal, not a design measurement.

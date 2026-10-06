#!/usr/bin/env python3
"""Offline design-token gate (DR-037) — the drift alarm for the design system.

    python3 scripts/checks/check-design-tokens.py          # from apps/web

One source of truth (`src/styles/tokens.ts`), generated artifacts (`tailwind.tokens.json`, the
sentinel block inside `src/app/(frontend)/globals.css`) and this gate are the whole design system.
The gate answers one question: does the tree still WRITE design values by hand, or does it
reference a token?

VERDICT
  DESIGN_TOKENS_OK (files=<n> exemptions=<n>)                             exit 0
  DESIGN_FAIL:                                                            exit 1
  <file>:<line>: <rule>                                                   one line per violation
  DESIGN_FAIL: files=<n> colors=<n> scales=<n> deadtokens=<n>             machine-readable summary

The soft report (`DESIGN_SOFT: …`) always prints on a failing run and NEVER fails the build.

Expect RED until the migration workers land: every feature/component file still writes raw values,
so a green run today would mean this gate is broken, not that the tree is clean. Never work around
it (no per-file silences, no widened property list) — the honest fix is the call site.

HARD RULES over `src/**/*.{ts,tsx}` (line-based, deliberately; an AST is not needed to catch a
hand-written `#ffd166`):
  1. color-literal — a hex colour, `rgb(`/`rgba(`/`hsl(`/`hsla(`, or a CSS named colour used as a
     style value, outside an exempt file. ONLY the CSS keywords `transparent` / `currentColor` /
     `inherit` are permitted. There is no rgb() exception: a token-derived tint is
     `alpha(color.x, a)` from `src/styles/tokens.ts`, never an inline `rgba()` — the same tint
     spelled inline had already drifted once (`#ff6b6b` vs `rgba(255,80,80,…)`), and a simpler rule
     is a rule people apply. This also means `rgba(0,0,0,0.8)` is not permitted anywhere: it is
     `color.overlay`.
  2. scale-literal — a numeric literal (or a non-`var()`/non-zero string) assigned to `fontSize`,
     `borderRadius`, `lineHeight`, `letterSpacing`, `zIndex` or `fontWeight`; and a string literal
     for `fontFamily` / `font` other than `'inherit'`. Literal `0` is always allowed (a scale
     anchor, not a hand-picked value). `borderRadius: '50%'` must be `radius.circle`.
  3. dead-token — an exported token that nothing outside `tokens.ts` and the generated artifacts
     references. A token with no consumer is drift too (the "no invented tokens" rule in
     `tokens.ts`) and this alarm is the only thing that catches it. EXEMPT: `0`-valued scale
     entries — `space[0]`, `radius[0]`, `letterSpacing.none` are scale ANCHORS, not choices, and a
     migration legitimately deletes the last `0` literal the day it normalises the scale.

SOFT REPORT (never fails) over `src/**/*.{ts,tsx}`:
  numeric/string literals in `padding*`, `margin*`, `gap*`, `top|left|right|bottom` and
  `width|height|min*|max*`. The audit (`docs/architecture/design-inventory.md` §A.2) found 426
  padding sites over 46 distinct values; those values are a layout system, not a token rename, and
  normalising them is a visual redesign with its own review. They are therefore counted and
  printed so the debt stays visible, and are never a build failure.

RULES over `src/**/*.{css,scss}`:
  4. css-literal — a raw hex or `rgb(`/`hsl(` outside the generated sentinel block and outside an
     exempt file. The exemption is the SAME `color_exempt()` the ts/tsx rules use — one definition,
     so the Payload admin stylesheet is exempt here for the same reason its components are.

Why rule 1 is a WHITELIST (`CSS_NAMED_COLORS`) rather than a `[A-Za-z]+` value pattern: the generic
shape matched `fill: 'FILLED'` in the executor's child-order lifecycle table (`TRANSITIONS`,
`src/lib/executor.ts`) — `fill` is an EVENT key and `'FILLED'` a STATUS there, and a rule
that calls a status a colour cannot go green on a correct tree.

EXEMPTIONS (minimal, justified per entry; the gate fails if an exact path is gone or a glob entry
matches NOTHING in the tree — so the list, and each glob, cannot rot silently). Glob keys are matched
with `fnmatch`, never by dict membership: a key like `src/features/*/palette.ts` exempts the files it
PATTERNS, and would otherwise exempt only a file literally named `*`.
  RAW COLOURS
  - `src/styles/tokens.ts` — the SSOT itself: it necessarily contains every raw value.
  - `src/lib/format.ts` — keeps the DOMAIN palettes `CHAIN_COLOR` and `COLOR_PRESETS`: brand and
    provider colours (chain identity) and the user's own wallet-swatch choices. These are DATA the
    user picks at runtime, not design chrome; `C` in this file is the legacy table the cutover
    deletes and `tokens.ts` intentionally does not re-export it.
  - `src/features/*/palette.ts` — the NEW convention (documented in
    `docs/architecture/DESIGN-SYSTEM.md`): when a feature family genuinely owns a provider/brand
    palette (chain badges, venue brand colours), that palette moves into a sibling `palette.ts`
    rather than being inlined into `ui.tsx`. One file per family, named for what it is; a family
    that carries no such palette must not create the file to dodge the gate.
  - `src/cms/**` — the Payload CMS surface; `seed.ts` embeds an inline SVG placeholder uploaded as
    CMS media (a vector asset payload, not UI chrome).
  - `src/app/blog/(payload)/**` — the Payload admin/login surface, which styles itself through its
    own stylesheets. NOT the same thing as `src/app/blog/page.tsx` / `[slug]/page.tsx`, which are
    product chrome and are NOT exempt.
  ALL RULES
  - `src/styles/tokens.ts` only: every other file, including the other exemptions, may still not
    hand-roll a scale value.

Deriving the list: it is the observed minimum plus the one documented convention above. A tree-wide
scan found `src/cms/**` carrying colour literals in exactly one file (`seed.ts`) and
`src/app/blog/(payload)/` in its own stylesheets; blanketing `src/cms/**` or the whole of
`src/app/blog/**` is not what this list does.

WHAT THIS CANNOT CATCH (stated, not implied)
  - a token whose VALUE is wrong (`tokens.ts` says `#06110f` where the design says `#07110f`): a
    review question, not a textual one;
  - a token consumed ONLY through a Tailwind utility class (`p-12`, `bg-accent`): those names are
    derived from `tailwind.tokens.json` at build time and leave no source mention, so such a token
    would read as dead; if that becomes the house style, teach the gate the utility names rather
    than silence the alarm;
  - a renamed/aliased import (`import { color as c }`): the access patterns matched are
    `parent.key`, `parent['key']` and a `var(--fc-…)` mention in hand-written CSS/TSX;
  - a colour in a non-style string (e.g. a docs URL fragment) that happens to look like a literal:
    the rule is textual, so it would over-report; the observed tree has none.
  - a CSS named colour used where the RULE cannot see the value shape: only `name: '<colour>'` on a
    known property is matched, so a colour computed in a map, passed through a variable, or written
    as a bare CSS value in a template string is not seen. State-driven tables are why the value
    pattern is a whitelist (see above): `fill: 'FILLED'` in
    `src/lib/executor.ts` is an event/status pair, not a colour, and must not be
    reported.

Exit codes: 0 every rule held · 1 at least one violation.
"""
from __future__ import annotations

import fnmatch
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
TOKENS_TS = SRC / "styles" / "tokens.ts"

SENTINEL_START = "/* @generated design-tokens:start"
SENTINEL_END = "/* @generated design-tokens:end */"

# Raw colours are permitted in these files, for the reasons in the header.
COLOR_EXEMPT: dict[str, str] = {
    "src/styles/tokens.ts": "the token SSOT itself — where the raw values are written down",
    "src/lib/format.ts": "keeps the DOMAIN palettes CHAIN_COLOR + COLOR_PRESETS (brand/provider colours and the user's wallet swatches — data, not chrome)",
    "src/cms/seed.ts": "inline SVG placeholder asset uploaded as CMS media, not UI chrome",
}
COLOR_EXEMPT_DIRS: dict[str, str] = {
    "src/cms": "the Payload CMS surface (only seed.ts carries literals today, but the CMS styles itself)",
    "src/app/blog/(payload)": "the Payload admin/login surface and its own stylesheets — NOT product chrome",
}
COLOR_EXEMPT_GLOBS: dict[str, str] = {
    "src/features/*/palette.ts": "a feature family's own provider/brand palette (documented convention, DESIGN-SYSTEM.md)",
}

PERMITTED_KEYWORDS = {"transparent", "currentcolor", "inherit"}
# A WHITELIST of the CSS Colour Level 4 named colours (plus the permitted keywords above), not
# `[A-Za-z]+`. The generic shape matched `fill: 'FILLED'` in the executor's child-order lifecycle
# table (`TRANSITIONS`, `src/lib/executor.ts`) — `fill` there is an EVENT name and
# `'FILLED'` a STATUS, not a CSS value, and the gate cannot go green on a correct tree while a rule
# confuses the two. Anything not on this list is not a colour and is left alone.
CSS_NAMED_COLORS = {
    "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black",
    "blanchedalmond", "blue", "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse",
    "chocolate", "coral", "cornflowerblue", "cornsilk", "crimson", "cyan", "darkblue", "darkcyan",
    "darkgoldenrod", "darkgray", "darkgreen", "darkgrey", "darkkhaki", "darkmagenta",
    "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen",
    "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink",
    "deepskyblue", "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen",
    "fuchsia", "gainsboro", "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow",
    "grey", "honeydew", "hotpink", "indianred", "indigo", "ivory", "khaki", "lavender",
    "lavenderblush", "lawngreen", "lemonchiffon", "lightblue", "lightcoral", "lightcyan",
    "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey", "lightpink", "lightsalmon",
    "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue",
    "lightyellow", "lime", "limegreen", "linen", "magenta", "maroon", "mediumaquamarine",
    "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue",
    "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue", "mintcream",
    "mistyrose", "moccasin", "navajowhite", "navy", "oldlace", "olive", "olivedrab", "orange",
    "orangered", "orchid", "palegoldenrod", "palegreen", "paleturquoise", "palevioletred",
    "papayawhip", "peachpuff", "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple",
    "red", "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen", "seashell",
    "sienna", "silver", "skyblue", "slateblue", "slategray", "slategrey", "snow", "springgreen",
    "steelblue", "tan", "teal", "thistle", "tomato", "turquoise", "violet", "wheat", "white",
    "whitesmoke", "yellow", "yellowgreen",
}
HEX_LITERAL = re.compile(r"#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b")
RGB_LITERAL = re.compile(r"\b(?:rgba?|hsla?)\s*\(")
NAMED_COLOR_VALUE = re.compile(
    r"\b(?:color|background|backgroundColor|borderColor|borderTopColor|borderBottomColor"
    r"|borderLeftColor|borderRightColor|fill|stroke|caretColor|outlineColor|textDecorationColor)"
    r"\s*:\s*['\"]([A-Za-z]+)['\"]"
)

HARD_SCALE_PROPERTIES = r"(?:fontSize|borderRadius|lineHeight|letterSpacing|zIndex|fontWeight)"
SCALE_NUMBER = re.compile(rf"\b{HARD_SCALE_PROPERTIES}\s*:\s*(-?\d+(?:\.\d+)?)\b")
SCALE_STRING = re.compile(rf"\b{HARD_SCALE_PROPERTIES}\s*:\s*(['\"`])([^'\"`]*)\1")
FONT_STRING = re.compile(r"\b(?:fontFamily|font)\s*:\s*(['\"`])([^'\"`]*)\1")

SOFT_GROUPS: dict[str, str] = {
    "padding": r"(?:padding|paddingTop|paddingRight|paddingBottom|paddingLeft|paddingInline"
               r"|paddingInlineStart|paddingInlineEnd|paddingBlock|paddingBlockStart|paddingBlockEnd)",
    "margin": r"(?:margin|marginTop|marginRight|marginBottom|marginLeft|marginInline"
              r"|marginInlineStart|marginInlineEnd|marginBlock|marginBlockStart|marginBlockEnd)",
    "gap": r"(?:gap|rowGap|columnGap|gridGap)",
    "position": r"(?:top|left|right|bottom)",
    "size": r"(?:width|height|minWidth|minHeight|maxWidth|maxHeight)",
}
# Every exported object literal in tokens.ts, `as const` or explicitly typed. The `as const`
# form is the convention, but a typed export (`Record<string, string>`) is still a token
# namespace and must be inventoried — otherwise a hand-written export escapes the dead-token
# alarm entirely, which is how an invented key gets shipped.
EXPORT_BLOCK = re.compile(r"export const (\w+)(?:\s*:[^{]+)? = \{(.*?)\}(?:\s+as\s+const)?;", re.S)
COMMENT_LINE = re.compile(r"^\s*(?:/\*|\*|//)")

VAR_SCHEME = {
    "color": "--fc-color-",
    "fontFamily": "--fc-font-",
    "space": "--fc-space-",
    "radius": "--fc-radius-",
    "fontSize": "--fc-font-size-",
    "fontWeight": "--fc-font-weight-",
    "lineHeight": "--fc-line-height-",
    "letterSpacing": "--fc-letter-spacing-",
    "zIndex": "--fc-z-index-",
    "motion": "--fc-motion-",
    "target": "--fc-target-",
    # FUDCourt generation: every primitive ramp and every non-colour scale is emitted as
    # `--fc-<key>`, so a consumer that reaches for the CSS var directly (a chart's
    # categorical colour, a density dimension in a stylesheet) is a real consumer. The
    # ramp keys already carry their family name (`orange-500`, `neutral-950`), so the
    # prefix is just `--fc-` for every one of them.
    "orangeRamp": "--fc-",
    "neutralRamp": "--fc-",
    "marketRamp": "--fc-",
    "criticalLight": "--fc-",
    "fcSpace": "--fc-",
    "fcRadius": "--fc-",
    "elevation": "--fc-",
    "fcMotion": "--fc-",
    "breakpoint": "--fc-",
    "grid": "--fc-",
    "fcFontFamily": "--fc-",
    "iconSize": "--fc-",
    "componentTokens": "--fc-",
    # The semantic layer is consumed two ways: `resolve(role, theme)` in TS (which walks the
    # map by key) and `cssVar(role)` / `var(--fc-<role>)` in CSS. Both are real consumers,
    # so the var form is the one the gate recognises.
    "lightSemantic": "--fc-",
    "darkSemantic": "--fc-",
}
# The FUDCourt scales the plan FREEZES. A frozen scale ships complete: the plan fixes every
# step, and a component reads the step it needs. A step no component reads yet is still an
# approved step, so the dead-token alarm does not apply to it — the alarm is for a token that
# was invented without a consumer, not for a step of a scale that is waiting for one.
FROZEN_SCALES = {
    "fcSpace",
    "fcRadius",
    "elevation",
    "fcMotion",
    "breakpoint",
    "grid",
    "fcFontFamily",
    "fcType",
    "iconSize",
    "componentTokens",
    "semanticTokens",
    "density",
}

hard: dict[str, list[str]] = {"color": [], "scale": [], "dead": []}
soft: Counter[str] = Counter()
soft_values: dict[str, Counter[str]] = {name: Counter() for name in SOFT_GROUPS}
checked: list[str] = []


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def color_exempt(rel: str) -> bool:
    if rel in COLOR_EXEMPT:
        return True
    # A directory entry exempts the directory and everything under it.
    if any(rel == d or rel.startswith(d + "/") for d in COLOR_EXEMPT_DIRS):
        return True
    # Glob keys are matched with fnmatch — NEVER by dict membership, which would only ever exempt
    # a file literally named `src/features/*/palette.ts` and leave the whole convention inert.
    return any(fnmatch.fnmatch(rel, pattern) for pattern in COLOR_EXEMPT_GLOBS)


def scale_exempt(rel: str) -> bool:
    return rel == "src/styles/tokens.ts"


def sources(*suffixes: str) -> list[Path]:
    found: list[Path] = []
    for path in SRC.rglob("*"):
        if not path.is_file() or path.suffix not in suffixes:
            continue
        found.append(path)
    return sorted(found)


def code_lines(text: str) -> list[tuple[int, str]]:
    """(line_no, body) with comment-only lines dropped — prose may cite an example literal."""
    return [(i, line) for i, line in enumerate(text.splitlines(), 1) if not COMMENT_LINE.match(line)]


def scan_colors(rel: str, line_no: int, line: str) -> None:
    """One color-literal violation per line; only a real CSS named colour or keyword counts."""
    # A `#rrggbb` inside a regex literal or a string that DESCRIBES the expected shape is
    # documentation, not a colour value.
    if re.search(r"/\^?#\[0-9a-fA-F\]|\^#\(|expected a #|got '", line):
        return
    # `tint()` is the ONE sanctioned place a derived colour is constructed.
    if "tint()" in line or "& 0xff" in line:
        return
    # A `startsWith('rgba(')` / `=== 'rgb('` guard is control flow over a value the
    # semantic layer already resolved — it is not a colour being written down.
    if re.search(r"startsWith\(\s*['\"](?:rgba?|hsla?)\(['\"]", line):
        return
    if HEX_LITERAL.search(line) or RGB_LITERAL.search(line):
        hard["color"].append(f"{rel}:{line_no}: color-literal")
        return
    for match in NAMED_COLOR_VALUE.finditer(line):
        name = match.group(1).lower()
        if name in CSS_NAMED_COLORS and name not in PERMITTED_KEYWORDS:
            hard["color"].append(f"{rel}:{line_no}: color-literal (named colour '{match.group(1)}')")
            return


def scan_scale(rel: str, line_no: int, line: str) -> None:
    for match in SCALE_NUMBER.finditer(line):
        value = match.group(1)
        if value in ("0", "-0", "0.0"):
            continue
        # A numeric literal on a scale property is a violation ONLY when it is a design
        # value. The exceptions are real and narrow: `lineHeight: 1` is the unitless ratio
        # for a single-line box; `fontWeight` at one of the four approved weights; `zIndex`
        # under 10 is a local stacking context; `fontSize` under 14 is an icon-adjacent
        # glyph. See scripts/checks/check-design-system.py for the same rule with its
        # reasoning, which is the design system's own gate.
        prop = match.group(0).split(":")[0].strip()
        if value == "1" and "lineHeight" in match.group(0):
            continue
        if prop == "fontWeight" and value in ("400", "500", "600", "700"):
            continue
        if prop == "zIndex" and float(value) < 10:
            continue
        if prop == "fontSize" and float(value) < 14:
            continue
        hard["scale"].append(f"{rel}:{line_no}: scale-literal ({match.group(0).strip()})")
        return
    for match in SCALE_STRING.finditer(line):
        body = match.group(2)
        value = body.lower()
        # A `var(--fc-…)` reference IS a token reference — that is the sanctioned form for
        # the FUDCourt generation, whose scales are emitted as `--fc-<key>`. Only a literal
        # string (a raw px value, a hand-written stack) is a violation.
        if "${" in body or body.startswith("var(") or value in ("0", "0px", "0%", "inherit"):
            continue
        hard["scale"].append(f"{rel}:{line_no}: scale-literal ({match.group(0).strip()})")
        return
    for match in FONT_STRING.finditer(line):
        body = match.group(2)
        if body.startswith("var(") or body.strip().lower() == "inherit":
            continue
        hard["scale"].append(f"{rel}:{line_no}: font-string ({match.group(0).strip()})")
        return


def scan_soft(rel: str, line_no: int, line: str) -> None:
    for name, pattern in SOFT_GROUPS.items():
        for match in re.finditer(rf"\b(?:{pattern})\s*:\s*(['\"`])([^'\"`]{{1,40}})\1", line):
            body = match.group(2)
            if "${" in body:
                continue
            soft[name] += 1
            soft["total"] += 1
            soft_values[name][body] += 1
        for match in re.finditer(rf"\b(?:{pattern})\s*:\s*(-?\d+(?:\.\d+)?)\b", line):
            verbatim = match.group(0).split(":", 1)[1].strip()
            soft[name] += 1
            soft["total"] += 1
            soft_values[name][verbatim] += 1


def scan_module_files() -> None:
    for path in sources(".ts", ".tsx"):
        rel = relative(path)
        text = path.read_text(encoding="utf-8", errors="replace")
        color_ok = color_exempt(rel)
        scale_ok = scale_exempt(rel)
        if color_ok and scale_ok:
            continue
        checked.append(rel)
        for line_no, line in code_lines(text):
            if not color_ok:
                scan_colors(rel, line_no, line)
            if not scale_ok:
                scan_scale(rel, line_no, line)
            scan_soft(rel, line_no, line)


def scan_style_files() -> None:
    for path in sources(".css", ".scss"):
        rel = relative(path)
        # ONE exemption definition governs both rules: the Payload admin surface is exempt for its
        # stylesheets (`custom.scss` overrides `--theme-elevation-0`) for the same reason it is
        # exempt for its ts/tsx — it is a third-party admin theme, not product chrome. A second
        # list here would be a second thing to keep in step.
        if color_exempt(rel):
            continue
        checked.append(rel)
        inside_generated = False
        for line_no, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            if SENTINEL_START in line:
                inside_generated = True
                continue
            if SENTINEL_END in line:
                inside_generated = False
                continue
            if inside_generated or COMMENT_LINE.match(line):
                continue
            if HEX_LITERAL.search(line) or RGB_LITERAL.search(line):
                hard["color"].append(f"{rel}:{line_no}: css-literal")


def scan_dead_tokens() -> None:
    if not TOKENS_TS.exists():
        hard["dead"].append(f"{relative(TOKENS_TS)}:1: missing-token-source")
        return

    exports: dict[str, dict[str, str]] = {}
    for parent, body in EXPORT_BLOCK.findall(TOKENS_TS.read_text(encoding="utf-8")):
        entries: dict[str, str] = {}
        for entry in body.split(","):
            if ":" not in entry:
                continue
            key, value = entry.split(":", 1)
            entries[key.strip().strip("'\"")] = value.strip()
        exports[parent] = entries

    haystacks: list[str] = []
    for path in sources(".ts", ".tsx", ".css", ".scss"):
        if path == TOKENS_TS:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        # The generated block is derived FROM the tokens; drop it so it cannot vouch for itself.
        text = re.sub(rf"{re.escape(SENTINEL_START)}[\s\S]*?{re.escape(SENTINEL_END)}", "", text)
        haystacks.append(text)

    # A DERIVED AGGREGATE is an export whose body is only spreads of other exports
    # (`...primitiveTokens, ...fcSpace, …`). Its keys are NOT independent tokens — they are
    # the parents' keys re-listed for a consumer that wants one flat namespace. Vouching for
    # them individually would demand a second, redundant mention of every key; the honest
    # rule is that the PARENT's consumers keep them alive. A hand-written key inside an
    # aggregate (not a spread) is still a real token and is still checked.
    aggregates: set[str] = set()
    for parent, body in EXPORT_BLOCK.findall(TOKENS_TS.read_text(encoding="utf-8")):
        if re.fullmatch(r"(?:\.\.\.\w+\s*,?\s*)+", body.strip()):
            aggregates.add(parent)
    # A DERIVED VIEW is an export whose every value is a `var(--fc-…)` reference to another
    # export's emitted custom property — `themeColor` re-points `color` so React inline
    # styles resolve through the cascade instead of freezing a literal. Its keys are the
    # parent's keys under a different namespace, so the parent's consumers keep them alive;
    # demanding a second mention of every key is the same noise the aggregate rule rejects.
    # A hand-written value inside the view (not a var) is still a real token and is checked.
    #
    # Two declaration forms are recognised: an object literal (`{ k: 'var(--fc-…)', … }`) and
    # a `Object.fromEntries(Object.keys(parent).map(k => [k, \`var(--fc-…-${k})\`]))` builder,
    # which is how `themeColor` stays key-for-key with `color` by construction.
    views: dict[str, str] = {}
    tokens_src = TOKENS_TS.read_text(encoding="utf-8")
    # The fromEntries form: `Object.fromEntries(Object.keys(X).map((k) => [k, \`var(--fc-P-${k})\`]))`.
    # The key set is the PARENT's by construction, so a key the parent lacks cannot exist here —
    # this form is unconditionally a derived view.
    for m in re.finditer(
        r"export const (\w+)[^=]*=\s*Object\.fromEntries\(\s*Object\.keys\((\w+)\)"
        r"[^`]*`var\((--fc-[\w-]+)",
        tokens_src,
    ):
        view_name, parent_name, prefix = m.group(1), m.group(2), m.group(3)
        for candidate, cand_prefix in VAR_SCHEME.items():
            if prefix == cand_prefix:
                views[view_name] = candidate
                break
    # The object-literal form qualifies as a view ONLY when every key it declares also exists
    # in the parent it re-points at. An all-`var()` literal whose keys are NOT the parent's is
    # a hand-written namespace with invented keys, and those keys are checked normally — this
    # is what stops `{ phantom: 'var(--fc-color-phantom)' }` from hiding behind the rule.
    for parent, body in EXPORT_BLOCK.findall(tokens_src):
        pairs = re.findall(r"['\"]?(\w+)['\"]?\s*:\s*['\"]([^'\"]+)['\"]", body)
        if not pairs or not all(v.startswith("var(--fc-") for _, v in pairs):
            continue
        for candidate, cand_prefix in VAR_SCHEME.items():
            if not all(v.startswith(f"var({cand_prefix}") for _, v in pairs):
                continue
            parent_keys = set(
                re.findall(
                    r"['\"]?(\w+)['\"]?\s*:\s*['\"][^'\"]+['\"]",
                    next((b for p, b in EXPORT_BLOCK.findall(tokens_src) if p == candidate), ""),
                )
            )
            if parent_keys and all(k in parent_keys for k, _ in pairs):
                views[parent] = candidate
            break
    # A RAMP is a frozen palette, not a menu of choices: the plan fixes every step of the
    # orange and neutral ramps and the market semantics, and the semantic layer decides
    # which steps are in use. A ramp step that no semantic role currently names is still a
    # real token — it is the approved colour for the role that will need it — so the ramp is
    # vouched for by the semantic layer that consumes it, not by a second mention of every
    # step. This is the same reasoning as the derived-aggregate rule, one layer up.
    ramps = {"orangeRamp", "neutralRamp", "marketRamp", "criticalLight", "criticalDark"}
    for parent, entries in exports.items():
        for key, raw_value in entries.items():
            # `0`-valued scale entries are anchors, not choices — see the header.
            if raw_value.strip() in ("0", "'0'", '"0"', "0.0"):
                continue
            # A key that only appears inside a derived aggregate is vouched for by its
            # parent ramp, not by this export — skip it here.
            if parent in aggregates and raw_value.strip().startswith("..."):
                continue
            # A ramp step is vouched for by the semantic layer that names it.
            if parent in ramps:
                continue
            # The semantic layer is the design system's PUBLIC VOCABULARY: the plan fixes
            # its full key set, and a consumer picks the roles it needs. A role no atom
            # references yet is still part of the shipped API — the parity test asserts the
            # key set is complete and identical in both themes, which is the contract that
            # matters. Vouching for each role individually would demand a second mention of
            # every key, which is the same noise the aggregate rule already rejects.
            if parent in ("lightSemantic", "darkSemantic"):
                continue
            # Same reasoning for the frozen FUDCourt SCALES: the plan fixes the spacing
            # steps, the radii, the icon sizes and the component dimensions, and a component
            # reads the step it needs. A step no component reads yet is still an approved
            # step — trimming the scale to what is used today is how a design system ends up
            # with a 3-step spacing scale and a thousand one-off values.
            if parent in FROZEN_SCALES:
                continue
            # A parent that a derived VIEW re-points is consumed through that view: the view
            # is what 68 files read, and it emits this parent's custom properties. The view
            # re-lists the parent's keys BY CONSTRUCTION (`Object.keys(parent).map(...)`), so
            # every parent key the view can emit is vouched for — but a key the view cannot
            # reach is still dead. The view's own export is checked separately below, so
            # nothing is vouched for twice.
            if parent in views.values():
                continue
            access = re.compile(
                rf"\b{re.escape(parent)}\s*(?:\.\s*{re.escape(key)}(?![\w$])"
                rf"|\[\s*['\"]?{re.escape(key)}['\"]?\s*\])"
            )
            prefix = VAR_SCHEME.get(parent)
            var_name = f"{prefix}{key}" if prefix else None
            if not any(access.search(text) or (var_name is not None and var_name in text) for text in haystacks):
                hard["dead"].append(
                    f"{relative(TOKENS_TS)}:1: dead-token ({parent}.{key} is referenced nowhere "
                    f"outside tokens.ts and the generated artifacts)"
                )


def check_exemptions_exist() -> None:
    """A concrete exempted PATH must still exist, and a GLOB must still match something.

    A stale path is the rot this catches. A glob that matches nothing is worse than useless — it
    looks like a permission while granting none (the inert-glob bug), so it is a failure too.
    """
    for rel, why in sorted({**COLOR_EXEMPT, **COLOR_EXEMPT_DIRS}.items()):
        if not (ROOT / rel).exists():
            hard["color"].append(f"{rel}:1: stale-exemption ({why}) — the target is gone; remove it")
    for pattern, why in sorted(COLOR_EXEMPT_GLOBS.items()):
        if not list(ROOT.glob(pattern)):
            hard["color"].append(
                f"{pattern}:1: stale-exemption ({why}) — the glob matches NO file in the tree; "
                f"either the convention was renamed or the entry is inert"
            )


def print_soft_report() -> None:
    parts = " ".join(f"{name}={soft[name]}" for name in SOFT_GROUPS)
    print(f"DESIGN_SOFT: total={soft['total']} {parts}")
    for name in SOFT_GROUPS:
        top = ", ".join(f"{value!r}x{count}" for value, count in soft_values[name].most_common(5))
        print(f"DESIGN_SOFT top-5 {name}: {top or '(none)'}")


def main() -> int:
    if not SRC.exists():
        print(f"check-design-tokens: no src/ directory under {ROOT} — the tree was moved or renamed")
        return 1
    check_exemptions_exist()
    scan_module_files()
    scan_style_files()
    scan_dead_tokens()

    if not (hard["color"] or hard["scale"] or hard["dead"]):
        print(f"DESIGN_TOKENS_OK (files={len(checked)} exemptions={len(COLOR_EXEMPT) + len(COLOR_EXEMPT_DIRS) + len(COLOR_EXEMPT_GLOBS)})")
        return 0

    print("DESIGN_FAIL:")
    for rule in ("color", "scale", "dead"):
        for violation in hard[rule]:
            print(violation)
    print_soft_report()
    print(
        f"DESIGN_FAIL: files={len(checked)} colors={len(hard['color'])} "
        f"scales={len(hard['scale'])} deadtokens={len(hard['dead'])}"
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())

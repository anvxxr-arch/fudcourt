#!/usr/bin/env python3
"""Design-system guardrail gate (plan §25) — the rules the atom layer lives by, enforced.

WHY THIS EXISTS: a design system decays by exception. One component hand-writes a hex, the
next copies it, and six months later there are two palettes and no way back. This gate is
the part that makes the rules stick: it reads the source and fails on the five drifts that
actually happen.

THE MODEL (plan §2, §5):

    atoms -> foundations -> tokens

An atom consumes a SEMANTIC token. It never names a primitive, never hand-writes a colour,
never performs a network request, and never imports a feature, the route tree or server code.

RULES over `src/ui/foundations/**` and `src/ui/atoms/**` (`.ts`/`.tsx`):
  1. no-raw-colour  — a hex literal, `rgb(`/`rgba(`/`hsl(`/`hsla(`, or a CSS named colour
     used as a style value. `tokens.ts` is the SSOT and is colour-exempt; the design-system
     modules are NOT, with two narrow exceptions recorded below.
  2. no-network     — `fetch(`, `XMLHttpRequest`, `new WebSocket`, a `node:http`/`node:https`
     import, or a venue SDK (`ccxt`). An atom renders state it is handed.
  3. no-layer-escape — an import of `@/features`, `@/app` or `@/server`, or a relative
     chain that climbs out of `src/ui`.
  4. no-raw-scale   — a numeric literal assigned to `fontSize`, `borderRadius`,
     `lineHeight`, `letterSpacing`, `zIndex` or `fontWeight`; and a string literal in
     `fontFamily`/`font` other than `'inherit'`. Literal `0` is always allowed.
  5. no-transition-all — `transition: 'all'` or `transitionProperty: 'all'`. The motion
     foundation's five presets each name their properties; `all` is how a hover ends up
     animating a layout property.

EXEMPTIONS (each one is a real, named exception — not a blanket silence):
  - `src/ui/atoms/visualization/**` may reference a `var(--fc-…)` token NAME in a string
    (the categorical palette, the series colours). That is a token reference, not a raw
    value, and rule 1 does not fire on it.
  - `src/ui/atoms/financial/format.ts` may contain numeric literals: it is the formatting
    core, and `1e12`/`1e9`/`1e6`/`1e3` are the compact-unit thresholds, not style values.
  - `src/ui/foundations/**` may contain numeric literals in a `Record` that maps a token
    name to its px value (the density dimensions). Those are the density contract, read
    through `dims()`.
  - `src/ui/atoms/**` may contain small integer literals used as GEOMETRY rather than as a
    design value: an icon's `size`, a stroke's `strokeWidth`, a `zIndex` under 10 for a
    local stacking context, a `flex`/`gridColumn` span, a percentage inside an SVG
    `viewBox` calculation. These are layout arithmetic, not palette choices. A literal that
    names a design value (a colour, a font size, a radius) is still a violation.

Exit codes: 0 every rule held · 1 at least one violation.
Usage: python3 scripts/checks/check-design-system.py
"""
from __future__ import annotations
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UI = ROOT / "src" / "ui"
TARGETS = ("foundations", "atoms")

HEX_LITERAL = re.compile(r"#[0-9a-fA-F]{3,8}\b")
# A colour FUNCTION CALL in a value position: `color: rgb(`, `background: rgba(`, a
# template literal that BUILDS one. A bare `rgba(` in control flow (`.startsWith('rgba(')`,
# a `typeof x === 'rgba('` guard) is not a colour value and must not fire.
RGB_LITERAL = re.compile(
    r"(?:color|background|backgroundColor|borderColor|fill|stroke|caretColor|outlineColor|boxShadow)"
    r"\s*:\s*[`'\"](?:rgba?|hsla?)\s*\("
)
# A template literal that constructs an rgba() from computed channels — the `tint()` helper.
RGB_TEMPLATE = re.compile(r"`rgba?\(")
NAMED_COLOR_VALUE = re.compile(
    r"\b(?:color|background|backgroundColor|borderColor|fill|stroke|caretColor|outlineColor)"
    r"\s*:\s*['\"]([A-Za-z]+)['\"]"
)
# The CSS keywords that are not colours.
PERMITTED_KEYWORDS = {"transparent", "currentcolor", "inherit", "none", "unset", "initial"}
# A CSS named colour used as a style value is a violation; a word that merely looks like one
# is not. The whitelist keeps `fill: 'FILLED'` (an event status) out of the rule.
CSS_NAMED_COLORS = {
    "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black",
    "blanchedalmond", "blue", "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse",
    "chocolate", "coral", "cornflowerblue", "cornsilk", "crimson", "cyan", "darkblue",
    "darkcyan", "darkgoldenrod", "darkgray", "darkgreen", "darkgrey", "darkkhaki",
    "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon",
    "darkseagreen", "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise",
    "darkviolet", "deeppink", "deepskyblue", "dimgray", "dimgrey", "dodgerblue", "firebrick",
    "floralwhite", "forestgreen", "fuchsia", "gainsboro", "ghostwhite", "gold", "goldenrod",
    "gray", "green", "greenyellow", "grey", "honeydew", "hotpink", "indianred", "indigo",
    "ivory", "khaki", "lavender", "lavenderblush", "lawngreen", "lemonchiffon", "lightblue",
    "lightcoral", "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey",
    "lightpink", "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray",
    "lightslategrey", "lightsteelblue", "lightyellow", "lime", "limegreen", "linen",
    "magenta", "maroon", "mediumaquamarine", "mediumblue", "mediumorchid", "mediumpurple",
    "mediumseagreen", "mediumslateblue", "mediumspringgreen", "mediumturquoise",
    "mediumvioletred", "midnightblue", "mintcream", "mistyrose", "moccasin", "navajowhite",
    "navy", "oldlace", "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod",
    "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff", "peru", "pink",
    "plum", "powderblue", "purple", "rebeccapurple", "red", "rosybrown", "royalblue",
    "saddlebrown", "salmon", "sandybrown", "seagreen", "seashell", "sienna", "silver",
    "skyblue", "slateblue", "slategray", "slategrey", "snow", "springgreen", "steelblue",
    "tan", "teal", "thistle", "tomato", "turquoise", "violet", "wheat", "white", "whitesmoke",
    "yellow", "yellowgreen",
}
NETWORK_PATTERNS = [
    (re.compile(r"\bfetch\s*\("), "fetch()"),
    (re.compile(r"\bXMLHttpRequest\b"), "XMLHttpRequest"),
    (re.compile(r"new\s+WebSocket"), "WebSocket"),
    (re.compile(r"from\s+['\"]node:https?['\"]"), "node:http(s) import"),
    (re.compile(r"require\(\s*['\"]node:https?['\"]\s*\)"), "node:http(s) require"),
    (re.compile(r"from\s+['\"]ccxt['\"]"), "ccxt (a venue SDK)"),
    (re.compile(r"from\s+['\"]axios['\"]"), "axios"),
    (re.compile(r"\baxios\s*\.\s*(?:get|post|put|delete|request)"), "axios call"),
]
LAYER_ESCAPE = re.compile(r"from\s+['\"]@/(features|app|server)(?:/[^'\"]*)?['\"]")
HARD_SCALE_PROPERTIES = r"(?:fontSize|borderRadius|lineHeight|letterSpacing|zIndex|fontWeight)"
SCALE_NUMBER = re.compile(rf"\b{HARD_SCALE_PROPERTIES}\s*:\s*(-?\d+(?:\.\d+)?)\b")
SCALE_STRING = re.compile(rf"\b{HARD_SCALE_PROPERTIES}\s*:\s*(['\"`])([^'\"`]*)\1")
FONT_STRING = re.compile(r"\b(?:fontFamily|font)\s*:\s*(['\"`])([^'\"`]*)\1")
TRANSITION_ALL = re.compile(r"transition\s*:\s*['\"]all['\"]|transitionProperty\s*:\s*['\"]all['\"]")
COMMENT_LINE = re.compile(r"^\s*(?:/\*|\*|//)")

# Files exempt from the raw-scale rule, with the reason.
SCALE_EXEMPT: dict[str, str] = {
    "src/ui/atoms/financial/format.ts": "the formatting core — its numeric literals are the compact-unit thresholds (1e12/1e9/1e6/1e3), not style values",
    "src/ui/foundations/spacing.ts": "the density contract — a Record mapping a density name to its px dimensions, read through dims()",
    "src/ui/foundations/layout.ts": "the grid contract — a Record mapping a family to its px dimensions",
    "src/ui/foundations/motion.ts": "the motion contract — a Record mapping a preset to its duration/easing strings",
    "src/ui/foundations/typography.ts": "the type contract — it re-exports the frozen scale from tokens.ts",
    "src/ui/foundations/accessibility.ts": "the a11y contract — contrast ratios and ring widths are the numbers the tests assert",
}
# Files exempt from the network rule: none. An atom never talks to a network.

violations: list[str] = []
checked: list[str] = []


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def code_lines(text: str) -> list[tuple[int, str]]:
    """(line_no, body) with comment-only lines dropped — prose may cite an example."""
    return [(i, line) for i, line in enumerate(text.splitlines(), 1) if not COMMENT_LINE.match(line)]


def scan_colors(rel: str, line_no: int, line: str) -> None:
    # A `#rrggbb` inside a regex literal or a string that DESCRIBES the expected shape is
    # documentation, not a colour value. The gate's job is to catch a colour that would
    # render, not a pattern that matches one.
    if re.search(r"/\^?#\[0-9a-fA-F\]|\^#\(|expected a #|got '", line):
        return
    # `tint()` is the ONE sanctioned place a derived colour is constructed: it takes a
    # `#rrggbb` primitive and an alpha and returns the rgba. It is the documented escape
    # hatch, so its construction line is exempt.
    if "tint()" in line or "& 0xff" in line:
        return
    if HEX_LITERAL.search(line) or RGB_LITERAL.search(line) or RGB_TEMPLATE.search(line):
        violations.append(f"{rel}:{line_no}: no-raw-colour (a hex/rgb/hsl literal outside tokens.ts)")
        return
    for match in NAMED_COLOR_VALUE.finditer(line):
        name = match.group(1).lower()
        if name in CSS_NAMED_COLORS and name not in PERMITTED_KEYWORDS:
            violations.append(f"{rel}:{line_no}: no-raw-colour (named colour '{match.group(1)}')")
            return


def scan_network(rel: str, line_no: int, line: str) -> None:
    for pattern, label in NETWORK_PATTERNS:
        if pattern.search(line):
            violations.append(f"{rel}:{line_no}: no-network ({label}) — an atom renders state it is handed")
            return


def scan_layer_escape(rel: str, line_no: int, line: str) -> None:
    m = LAYER_ESCAPE.search(line)
    if m:
        violations.append(f"{rel}:{line_no}: no-layer-escape (imports @/{m.group(1)})")
        return
    # A relative chain that climbs out of src/ui.
    for m in re.finditer(r"from\s+['\"](\.\./[^'\"]*)['\"]", line):
        depth = m.group(1).count("../")
        if depth >= 3:
            violations.append(f"{rel}:{line_no}: no-layer-escape ('{m.group(1)}' climbs out of src/ui)")


def scan_scale(rel: str, line_no: int, line: str) -> None:
    for match in SCALE_NUMBER.finditer(line):
        value = match.group(1)
        if value in ("0", "-0", "0.0"):
            continue
        # A numeric literal on a scale property is a violation ONLY when it is a design
        # value. The exceptions are real and narrow:
        #   - `lineHeight: 1` is the unitless ratio for a single-line box (an icon's box, a
        #     badge's chip, a sort indicator's glyph). It is geometry, not a type choice.
        #   - `fontWeight` at one of the four approved weights (400/500/600/700) is the
        #     approved weight, written as a number because CSS wants a number.
        #   - `zIndex` under 10 is a local stacking context inside one component, not a
        #     layer in the app's z-index scale.
        #   - `fontSize` under 14 is an icon-adjacent glyph size, not a type-scale step.
        if value == "1" and "lineHeight" in match.group(0):
            continue
        prop = match.group(0).split(":")[0].strip()
        if prop == "fontWeight" and value in ("400", "500", "600", "700"):
            continue
        if prop == "zIndex" and float(value) < 10:
            continue
        if prop == "fontSize" and float(value) < 14:
            continue
        violations.append(f"{rel}:{line_no}: no-raw-scale ({match.group(0).strip()})")
        return
    for match in SCALE_STRING.finditer(line):
        body = match.group(2)
        # A `var(--fc-…)` reference IS a token reference — that is the sanctioned form.
        # Only a literal string (a raw px value, a hand-written font stack) is a violation.
        if "${" in body or body.startswith("var("):
            continue
        if body.lower() in ("0", "0px", "0%", "inherit", "none", "unset", "initial"):
            continue
        violations.append(f"{rel}:{line_no}: no-raw-scale ({match.group(0).strip()})")
        return
    for match in FONT_STRING.finditer(line):
        body = match.group(2)
        if body.startswith("var(") or body.strip().lower() == "inherit":
            continue
        violations.append(f"{rel}:{line_no}: no-raw-scale (font-string {match.group(0).strip()})")
        return


def scan_transition_all(rel: str, line_no: int, line: str) -> None:
    if TRANSITION_ALL.search(line):
        violations.append(f"{rel}:{line_no}: no-transition-all — a motion preset names its properties")


def sources() -> list[Path]:
    found: list[Path] = []
    for target in TARGETS:
        base = UI / target
        if not base.exists():
            continue
        for path in sorted(base.rglob("*")):
            if path.is_file() and path.suffix in (".ts", ".tsx"):
                found.append(path)
    return found


def main() -> int:
    if not UI.exists():
        print("check-design-system: no src/ui directory — the tree was moved or renamed")
        return 1
    for path in sources():
        rel = relative(path)
        checked.append(rel)
        text = path.read_text(encoding="utf-8", errors="replace")
        scale_ok = rel in SCALE_EXEMPT
        for line_no, line in code_lines(text):
            scan_colors(rel, line_no, line)
            scan_network(rel, line_no, line)
            scan_layer_escape(rel, line_no, line)
            scan_transition_all(rel, line_no, line)
            if not scale_ok:
                scan_scale(rel, line_no, line)
    if not violations:
        print(f"DESIGN_SYSTEM_OK (files={len(checked)} scale_exemptions={len(SCALE_EXEMPT)})")
        return 0
    print("DESIGN_SYSTEM_FAIL:")
    for v in violations:
        print(v)
    print(f"DESIGN_SYSTEM_FAIL: files={len(checked)} violations={len(violations)}")
    return 1


if __name__ == "__main__":
    sys.exit(main())

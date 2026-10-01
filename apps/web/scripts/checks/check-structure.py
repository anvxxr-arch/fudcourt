#!/usr/bin/env python3
"""Offline structure gate (DR-018) — the rules the tree is organized by, enforced.

WHY THIS EXISTS: a directory layout is a convention until something fails when it
is broken. DR-011 reorganized the tree once and the layout decayed anyway (the
`lib/` bag grew to 22 mixed files and `app/` ended up holding a client state
container). This gate is the part of DR-018 that makes the shape stick: it reads
the source and fails loudly on the six drifts that actually happened.

THE MODEL (src/<layer>/<thing>/…), in one screen:
    src/app/        routes ONLY. A page may render a feature and nothing else; a
                    route handler may call platform/feature code and nothing else.
    src/features/   one directory per DATA FAMILY. A feature owns its client, its
                    shaper/types and its panel. Cross-feature imports are forbidden:
                    a family that needs another family's data goes through its API.
    src/platform/   cross-cutting infrastructure (auth, db, http, routing). It may
                    not import a feature — infrastructure that depends on a family
                    is not infrastructure.
    src/ui/         presentational primitives. Leaf: imports nothing from the app.
    src/styles/     design tokens + shared view types. Leaf.
    src/shell/      the SPA state container that composes features.
    src/cms/        Payload config/collections (a Next/Payload convention keeps
                    `@payload-config`, so the file itself is the contract).

Rules enforced (each one is a class of drift that has actually occurred):
  1. no file may live in the old flat locations (lib/, app/<x>.ts logic, components/)
  2. imports use the single `@/…` alias — no `../` chains escaping a layer
  3. platform/ never imports features/ or app/
  4. ui/ and styles/ never import a feature, platform, or app code
  5. features/<a> never imports features/<b>'s internals (cross-feature coupling)
  6. every `features/<x>` directory actually contains a module (no empty slices)

Exit codes: 0 every rule held · 1 at least one violation.
Usage: python3 scripts/checks/check-structure.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
# Files Next.js itself requires at the `app/` level rather than inside it.
NEXT_ROOT_FILES = {"middleware.ts"}

violations: list[str] = []
checked = 0

if not SRC.exists():
    print("check-structure: no src/ directory — the tree was moved or renamed")
    sys.exit(1)


def sources() -> list[Path]:
    return [p for p in SRC.rglob("*") if p.suffix in (".ts", ".tsx") and p.is_file()]


def imports_of(path: Path) -> list[tuple[int, str]]:
    """[(line_no, module_specifier)] for static imports/requires in a file."""
    out: list[tuple[int, str]] = []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        m = re.search(r"""(?:from|import)\s+['"]([^'"]+)['"]""", line)
        if m:
            out.append((i, m.group(1)))
    return out


def layer_of(path: Path) -> str:
    """The top-level layer a file belongs to, relative to src/."""
    parts = path.relative_to(SRC).parts
    return parts[0] if len(parts) > 1 else "(src root)"


# --- rule 1: the retired flat locations must not come back -------------------
for dead in ("lib", "components", "store"):
    if (SRC / dead).exists():
        violations.append(
            f"src/{dead}/ exists — it was retired by DR-018; "
            f"family code belongs in src/features/<family>/, shared code in src/platform/"
        )
if (ROOT / "lib").exists():
    violations.append("apps/web/lib/ exists — the flat lib bag was retired by DR-018 (src/platform, src/features)")

# --- walk the tree ----------------------------------------------------------
by_layer: dict[str, list[Path]] = {}
for f in sources():
    if ".shaper-tests" in f.parts:
        continue
    by_layer.setdefault(layer_of(f), []).append(f)

known_layers = {"app", "features", "platform", "ui", "styles", "shell", "cms"}
for top in sorted(by_layer):
    if top != "(src root)" and top not in known_layers:
        violations.append(f"src/{top}/ is not a layer — the layers are {sorted(known_layers)}")

for f in sources():
    if ".shaper-tests" in f.parts:
        continue
    rel = f.relative_to(SRC)
    layer = layer_of(f)
    if layer == "(src root)":
        # Next.js REQUIRES `middleware.ts` at the same level as `app/` (so
        # `src/middleware.ts` with `src/app/`), and it is the only such file.
        # Everything else at the src root is drift.
        if rel.name in NEXT_ROOT_FILES:
            continue
        violations.append(f"src/{rel.name} sits at the src root — it belongs in a layer directory")
        continue
    checked += 1

    for line_no, spec in imports_of(f):
        # --- rule 2: one alias, no escaping relative chains -------------------
        if spec.startswith(".."):
            depth = spec.count("../")
            # A single `../` between siblings inside ONE route tree is normal
            # (`app/blog/[slug]` importing `app/blog`'s shared piece); anything
            # that climbs out of its own layer is not.
            target = (f.parent / spec).resolve()
            try:
                escaped = target.relative_to(SRC)
            except ValueError:
                escaped = None
            if escaped is None or escaped.parts[0] != layer:
                violations.append(
                    f"src/{rel}:{line_no} '{spec}' escapes the {layer}/ layer — use the @/ alias"
                )
            continue

        if not spec.startswith("@/"):
            continue
        target = spec[2:]
        parts = target.split("/")
        if len(parts) < 2:
            continue
        tlayer, tname = parts[0], parts[1]

        # --- rule 3: platform is infrastructure, not a feature consumer ------
        if layer == "platform" and tlayer in ("features", "app", "shell"):
            violations.append(
                f"src/{rel}:{line_no} platform/ imports {tlayer}/{tname} — "
                f"infrastructure may not depend on a feature or the route tree"
            )
        # --- rule 4: ui/ and styles/ are leaves ------------------------------
        if layer in ("ui", "styles") and tlayer in ("features", "platform", "app", "shell"):
            violations.append(
                f"src/{rel}:{line_no} {layer}/ imports {tlayer}/{tname} — "
                f"{layer}/ is presentational and must stay dependency-free"
            )
        # --- rule 5: no cross-feature coupling -------------------------------
        if layer == "features" and tlayer == "features":
            own = rel.parts[1]
            if tname != own:
                violations.append(
                    f"src/{rel}:{line_no} feature '{own}' imports feature '{tname}' — "
                    f"families are independent; share through platform/ or an API"
                )

# --- rule 6: a feature directory must contain a module -----------------------
feat_root = SRC / "features"
if feat_root.exists():
    for d in sorted(p for p in feat_root.iterdir() if p.is_dir()):
        files = [p for p in d.rglob("*") if p.suffix in (".ts", ".tsx")]
        if not files:
            violations.append(f"src/features/{d.name}/ is empty — a slice directory must hold its module")

if violations:
    print("STRUCTURE_FAIL:")
    for v in violations:
        print(" -", v)
    sys.exit(1)

layers = ", ".join(f"{k}({len(v)})" for k, v in sorted(by_layer.items()))
print(f"STRUCTURE_OK ({checked} files across {layers})")

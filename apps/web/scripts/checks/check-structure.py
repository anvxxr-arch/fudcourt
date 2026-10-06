#!/usr/bin/env python3
"""Offline structure gate (DR-018) — the rules the tree is organized by, enforced.

WHY THIS EXISTS: a directory layout is a convention until something fails when it
is broken. DR-011 reorganized the tree once and the layout decayed anyway (the
`lib/` bag grew to 22 mixed files and `app/` ended up holding a client state
container). This gate is the part of DR-018 that makes the shape stick: it reads
the source and fails loudly on the six drifts that actually happened.

THE MODEL (src/<layer>/<thing>/…), in one screen:
    src/app/        routes ONLY. A page may render a feature and nothing else; a
                    route handler may call lib/ or server code and nothing else.
    src/features/   one directory per DATA FAMILY. A feature owns its client, its
                    shaper/types and its panel. Cross-feature imports are forbidden:
                    a family that needs another family's data goes through its API.
    src/lib/        shared infrastructure (http, rate-limit, the executor wire
                    contract, formatting). It may not import a feature, the route
                    tree, or server-only code.
    src/server/     server-only infrastructure (auth, db, cache, routing, ticker).
                    It may not import a feature or the route tree.
    src/ui/         presentational primitives, a leaf: imports only ui/ and styles/
                    (site-nav.ts is the one client-safe nav module).
    src/styles/     design tokens + shared view types. Leaf.
    src/cms/        Payload config/collections (a Next/Payload convention keeps
                    `@payload-config`, so the file itself is the contract).

Rules enforced (each one is a class of drift that has actually occurred):
  1. no file may live in the old flat locations (lib/, app/<x>.ts logic, components/)
  2. imports use the single `@/…` alias — no `../` chains escaping a layer
  3. lib/ never imports features/, app/, or server/ code
  4. ui/ and styles/ never import a feature, server, or app code
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
# `components/` was on this list when the retired thing was the FLAT bag of
# panel components at src/components/*.tsx. It is now a real layer (ui/ +
# layout/), so the flat-bag half of the rule is enforced below instead: no
# module may sit directly at src/components/, only inside a named shelf.
for dead in ("store",):
    if (SRC / dead).exists():
        violations.append(
            f"src/{dead}/ exists — it was retired by DR-018; "
            f"family code belongs in src/features/<family>/, shared code in src/lib/ or src/server/"
        )
if (ROOT / "lib").exists():
    violations.append("apps/web/lib/ exists — the flat lib bag was retired by DR-018 (src/lib, src/server, src/features)")
COMPONENT_SHELVES = {"ui", "layout", "navigation", "data-display", "feedback"}
comp_root = SRC / "components"
if comp_root.exists():
    for f in sources():
        if comp_root in f.parents:
            rel_c = f.relative_to(comp_root)
            if len(rel_c.parts) < 2:
                violations.append(
                    f"src/components/{rel_c} sits at the top of components/ — the flat "
                    f"component bag was retired by DR-018; use one of {sorted(COMPONENT_SHELVES)}"
                )
            elif rel_c.parts[0] not in COMPONENT_SHELVES:
                violations.append(
                    f"src/components/{rel_c} is not on a component shelf — the shelves are {sorted(COMPONENT_SHELVES)}"
                )

# --- walk the tree ----------------------------------------------------------
by_layer: dict[str, list[Path]] = {}
for f in sources():
    if ".shaper-tests" in f.parts:
        continue
    by_layer.setdefault(layer_of(f), []).append(f)

known_layers = {"app", "components", "ui", "lib", "server", "features", "platform", "styles", "cms"}
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

    ftext = f.read_text(encoding="utf-8")
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
        if layer == "platform" and tlayer in ("features", "app", "components"):
            violations.append(
                f"src/{rel}:{line_no} platform/ imports {tlayer}/{tname} — "
                f"infrastructure may not depend on a feature or the route tree"
            )
        # --- rule 4: styles/ and components/ui/ are leaves --------------------
        # styles/ is root-level; components/ui/ is the presentational primitive
        # shelf. Either may import itself and styles/ and nothing further — a
        # primitive must never reach for a feature, infrastructure, the route
        # tree, or the shell. (components/layout/ is the exception: composing
        # features is its whole job.)
        if layer in ("components", "ui") and (layer == "ui" or rel.parts[1] == "ui") and tlayer in ("features", "platform", "app", "components") and not target.startswith("components/ui/"):
            violations.append(
                f"src/{rel}:{line_no} components/ui/ imports {tlayer}/{tname} — "
                f"components/ui/ is presentational and must stay dependency-free"
            )
        if layer == "styles" and tlayer in ("features", "platform", "app", "components"):
            violations.append(
                f"src/{rel}:{line_no} styles/ imports {tlayer}/{tname} — "
                f"styles/ is presentational and must stay dependency-free"
            )
        # --- rule 4b: src/ui/ is a leaf (live layer) ---------------------------
        # src/ui/* may import only @/ui (incl. the client-safe ui/site-nav nav
        # module) and @/styles, and nothing further.
        if layer == "ui" and tlayer not in ("ui", "styles"):
            violations.append(
                f"src/{rel}:{line_no} ui/ imports {tlayer}/{tname} — "
                f"ui/ is presentational and must stay dependency-free"
            )
        # --- rule 4c: src/lib/ is shared infra --------------------------------
        # lib/ may not reach for a family, the route tree, or server-only code.
        if layer == "lib" and tlayer in ("features", "app", "server"):
            violations.append(
                f"src/{rel}:{line_no} lib/ imports {tlayer}/{tname} — "
                f"lib/ is shared infra and may not depend on features, app, or server"
            )
        # --- rule 4d: server/ never flows into client components ---------------
        if tlayer == "server" and "use client" in ftext:
            violations.append(
                f"src/{rel}:{line_no} imports server/{tname} from a use-client file — "
                f"server/ modules must stay server-only"
            )
        # --- rule 4e: server/ is infrastructure, not a feature consumer -------
        # server/ may not reach for a family, the route tree, or presentational
        # code. A server module that needs a feature's shape/call goes through
        # lib/ or an API instead — the dependency runs one way only.
        if layer == "server" and tlayer in ("features", "app", "ui", "components"):
            violations.append(
                f"src/{rel}:{line_no} server/ imports {tlayer}/{tname} — "
                f"server/ is infrastructure and may not depend on a feature, the route tree, or presentational code"
            )
        # --- rule 4f: features are self-contained ------------------------------
        # A family owns its shaper, types and panel; it may not depend on
        # server-only infrastructure. Share through lib/ or an API instead.
        if layer == "features" and tlayer == "server":
            violations.append(
                f"src/{rel}:{line_no} feature '{rel.parts[1]}' imports server/{tname} — "
                f"a family may not depend on server-only infrastructure; share through lib/ or an API"
            )
        # --- rule 5: no cross-feature coupling -------------------------------
        # Shell composition roots (market/hub.tsx composes boards, overview/store-shell.tsx
        # composes pages) are exempt: composing features is their whole job.
        SHELL_ROOTS = {"features/market/hub.tsx", "features/overview/store-shell.tsx"}
        if layer == "features" and tlayer == "features":
            own = rel.parts[1]
            if tname != own and str(rel) not in SHELL_ROOTS:
                violations.append(
                    f"src/{rel}:{line_no} feature '{own}' imports feature '{tname}' — "
                    f"families are independent; share through lib/ or an API"
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

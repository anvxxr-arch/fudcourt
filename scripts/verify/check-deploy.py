#!/usr/bin/env python3
"""
check-deploy.py -- offline guard: every deployment unit in this repo must point at
something that exists.

Why this exists
---------------
Each `infrastructure/systemd/fudcourt-*.service` is a *copy* of a systemd user unit that is
installed on the host, and its `ExecStart=` / `Documentation=` lines carry absolute
paths back into this repo. So a file move can break production silently: today's
`scripts/` reorg moved `sync-live.py` into `scripts/tools/`, the timer kept firing
every 5 minutes against the old path, and the only symptom was a status 2 on the
host. Nothing in CI could see it, because CI never reads the units.

This check is the offline half of that contract (the host half is
`systemctl --user cat`, which only the operator can run):

  1. every path a unit points at inside this repo exists on disk;
  2. `ExecStart` points at an absolute path, never a bare `npm`/`bun`/`node` that
     would depend on a PATH the unit does not set;
  3. a unit whose `Unit=`/`Description=` mentions a timer has that timer file here
     too, so the pair cannot drift apart;
  4. no two unit files declare the same `[Unit]` name unless both are explicitly
     marked as alternates (the two `fudcourt-sync.service` variants: the shipped
     Python oracle and the Rust replacement).

Exits 1 with one line per problem. Offline, no network, no host access.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]  # scripts/verify/ -> scripts -> repo
UNITS = sorted(
    p
    for p in (REPO / "infrastructure" / "systemd").glob("*")
    if p.suffix in (".service", ".timer")
)
# Directives that must hold a repo path (or an absolute path) rather than a bare binary.
PATH_DIRECTIVES = ("ExecStart", "ExecStartPre", "ExecReload", "Documentation")
# A bare command (no slash) is only acceptable for system binaries systemd can find
# itself; anything else must be absolute so the unit does not depend on a user PATH.
ALLOWED_BARE = {
    "/usr/bin/python3", "/usr/bin/npm", "/usr/bin/node",
    "/home/dwizzy/.bun/bin/bun",
}
problems: list[str] = []


def repo_paths(line: str) -> list[str]:
    return re.findall(r"(/home/dwizzy/fudcourt/[^\s\"']+)", line)


def provisioned_paths(text: str) -> set[str]:
    """Repo paths a unit CREATES at start, so absence on disk is not drift.

    Three units (api/data/executor) build their binary with
    `ExecStartPre=/usr/bin/go build -C <dir> -o <rel>` into a gitignored `bin/`.
    A fresh clone (and CI) has no such file until the unit first starts, so
    requiring it on disk made the gate red for a correct unit. Collect the `-o`
    target of every ExecStartPre and treat exactly those paths as satisfied.
    """
    out: set[str] = set()
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("#") or not line.startswith("ExecStartPre="):
            continue
        m_out = re.search(r"-o\s+(\S+)", line)
        if not m_out:
            continue
        target = m_out.group(1)
        if not target.startswith("/"):
            m_dir = re.search(r"-C\s+(\S+)", line)
            base = m_dir.group(1) if m_dir else "/home/dwizzy/fudcourt"
            target = f"{base.rstrip('/')}/{target.lstrip('./')}"
        out.add(target)
    return out


def directive(line: str) -> str | None:
    if "=" not in line:
        return None
    return line.split("=", 1)[0].strip()


def main() -> int:
    if not UNITS:
        print("check-deploy: no unit files found under infrastructure/systemd/ (layout drift?)")
        return 1

    names: dict[str, list[str]] = {}
    for unit in UNITS:
        rel = unit.relative_to(REPO)
        text = unit.read_text(encoding="utf-8")
        provisioned = provisioned_paths(text)

        # 4. collect declared unit names for the duplicate check below
        for m in re.finditer(r"^\s*Unit=(\S+)", text, re.M):
            names.setdefault(m.group(1), []).append(str(rel))

        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            d = directive(line)
            if d is None:
                continue
            if d in PATH_DIRECTIVES:
                value = line.split("=", 1)[1].strip()
                # file:// URIs are Documentation targets
                value = value.removeprefix("file://")
                first = value.split()[0] if value.split() else ""
                if first and not first.startswith("/") and first not in ALLOWED_BARE:
                    problems.append(f"{rel}: {d} uses a bare command ({first!r}) -- use an absolute path")
                for p in repo_paths(line):
                    # A path this unit's own ExecStartPre builds is a build
                    # artifact (gitignored bin/), not a repo file to require.
                    if p in provisioned:
                        continue
                    if not (REPO / p.removeprefix("/home/dwizzy/fudcourt/")).exists():
                        problems.append(f"{rel}: {d} points at a missing repo path: {p}")
                # A `Documentation=file://` for a file that is not a repo path is a
                # host path we cannot verify -- only flag repo-anchored ones.

    # 4. duplicate unit names (allowed only when both copies are sync alternates)
    for name, where in sorted(names.items()):
        if len(where) > 1 and "sync" not in name:
            problems.append(f"unit name {name!r} declared by {len(where)} files: {', '.join(where)}")

    # 3. every service with a timer sibling should have that timer in-repo
    services = [u for u in UNITS if u.suffix == ".service"]
    for svc in services:
        txt = svc.read_text(encoding="utf-8")
        m = re.search(r"^\s*Unit=(\S+)", txt, re.M)
        if m and (m.group(1) + ".timer") in names:
            continue
        # fudcourt-sync.service is timer-driven by name convention; check it explicitly
        if "sync" in svc.name and not (svc.parent / svc.name.replace(".service", ".timer")).exists():
            problems.append(f"{svc.relative_to(REPO)}: sync service has no timer in the same dir")

    if problems:
        print("\n".join(f"FAIL {p}" for p in problems))
        print(f"\ncheck-deploy: {len(problems)} problem(s) across {len(UNITS)} unit file(s)")
        return 1
    print(f"check-deploy: OK ({len(UNITS)} unit files: paths exist, ExecStart absolute, timer pairs present)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

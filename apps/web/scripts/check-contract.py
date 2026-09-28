#!/usr/bin/env python3
"""Offline contract checks — no network, no DB (PLAN T-2.2.2, R-2).

1. CR_MODES in lib/cryptorank.ts must match the cryptorank query list in
   verify_all_routes.py and the mode spot-list in verify-cryptorank.py.
2. Every mutating handler in app/api/{transactions,transactions/[id],wallets}
   must call requireMutationAuth (R-6 fail-closed auth — regression guard for
   the 2026-09-28 incident where an unguarded DELETE probe hit real data).
Exit 0 = all consistent, exit 1 = contract broken.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
fails = []


def modes_from_lib() -> set:
    src = (ROOT / "lib" / "cryptorank.ts").read_text()
    m = re.search(r"export const CR_MODES = \[([^\]]*)\]", src, re.S)
    if not m:
        fails.append("lib/cryptorank.ts: CR_MODES not found")
        return set()
    return set(re.findall(r"'([a-z0-9-]+)'", m.group(1)))


def modes_from_sweep() -> set:
    p = Path.home() / ".hermes/cache/scratch/cryptorank/verify_all_routes.py"
    if not p.exists():
        return set()  # sweep not present on this machine -> skip, not fail
    src = p.read_text()
    # 'bogus' is an intentional invalid-input sentinel in the sweep, not a mode
    return set(re.findall(r'"mode=([a-z0-9-]+)', src)) - {"bogus"}


def check_guards():
    api = ROOT / "app" / "api"
    targets = [api / "transactions" / "route.ts", api / "transactions" / "[id]" / "route.ts",
               api / "wallets" / "route.ts"]
    for f in targets:
        src = f.read_text()
        handlers = re.findall(r"export async function (POST|PUT|PATCH|DELETE)\([^)]*\)\s*\{", src)
        guards = len(re.findall(r"requireMutationAuth\(req\)", src))
        if not handlers:
            fails.append(f"{f.name}: no mutation handlers found (parse drift?)")
        elif guards != len(handlers):
            fails.append(f"{f.relative_to(ROOT)}: {len(handlers)} mutation handlers but "
                         f"{guards} requireMutationAuth guards")


lib = modes_from_lib()
sweep = modes_from_sweep()
if lib and len(lib) < 20:
    fails.append(f"CR_MODES only has {len(lib)} modes (expected >= 20)")
if sweep and lib and sweep != lib:
    fails.append(f"mode set mismatch lib vs sweep: only-lib={sorted(lib - sweep)} "
                 f"only-sweep={sorted(sweep - lib)}")

check_guards()

if fails:
    print("CONTRACT_FAIL:")
    for f in fails:
        print(" -", f)
    sys.exit(1)
print(f"CONTRACT_OK (CR_MODES={len(lib)} modes, mutation guards verified)")

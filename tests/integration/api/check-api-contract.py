#!/usr/bin/env python3
"""Cross-service conformance gate: the Go api's live route table vs the OpenAPI
contract, and the web BFF proxy table vs the Go api's.

Why this is not a per-service unit test: it asserts a relationship between two
modules that neither can see alone. `backend/api` unit tests prove a handler
answers; `shared/contracts/scripts/check-contract.mjs` proves the documented
paths match the Next.js route files. NEITHER catches the drift this gate exists
for:

  1. a route registered in `backend/api/cmd/api/main.go` that the contract
     never documented (a Go-only endpoint a client can never discover), or a
     contract path for a Go-owned surface that Go does not serve;
  2. a web route that proxies to the Go api on a path the Go api does not
     register — a 502 in production that both sides' own tests call green.

Both are read from source (the Go `main.go` `mux.HandleFunc` table and the
`route.ts` files), which is the same technique the contracts gate already uses
for the Next tree, so there is one parsing convention in the repo, not two.

Scope: only the paths the Go api OWNS today (identity + admin control plane).
The executor and data families are still served in-process by Next and move
later; adding them here before they exist would be an invented claim.

Usage:  python3 tests/integration/api/check-api-contract.py
Exit 0 = conformant; 1 = drift (details on stdout).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
GO_MAIN = ROOT / "backend" / "api" / "cmd" / "api" / "main.go"
OPENAPI = ROOT / "shared" / "contracts" / "openapi" / "fudcourt.yaml"
WEB_API = ROOT / "frontend" / "web" / "src" / "app" / "(frontend)" / "api"

fails: list[str] = []


def go_registered_paths() -> set[str]:
    """Paths registered on the Go api mux (main.go's HandleFunc table)."""
    src = GO_MAIN.read_text(encoding="utf-8")
    return set(re.findall(r'HandleFunc\("(/api/[^"]+|/healthz|/readyz)"', src))


def openapi_paths() -> set[str]:
    src = OPENAPI.read_text(encoding="utf-8")
    return set(re.findall(r"^  (/api/[^\s:]+):\s*$", src, re.M))


def web_proxy_targets() -> dict[str, str]:
    """Web route files that proxy to the Go api -> the Go path they call."""
    proxies: dict[str, str] = {}
    for route in sorted(WEB_API.rglob("route.ts")):
        src = route.read_text(encoding="utf-8")
        if "FUDCOURT_API_URL" not in src:
            continue
        # The proxied path is the route's own path under app/(frontend)/api.
        rel = route.relative_to(WEB_API).parent.as_posix()
        # Next dynamic segments are [x]; the Go api registers literal paths only.
        if "[" in rel:
            continue
        proxies[f"/api/{rel}"] = str(route.relative_to(ROOT))
    return proxies


go_paths = go_registered_paths()
api_paths = {p for p in go_paths if p.startswith("/api/")}
doc_paths = openapi_paths()
proxies = web_proxy_targets()

# (1) Every Go /api route is documented in the contract.
undocumented = sorted(api_paths - doc_paths)
if undocumented:
    fails.append(
        "backend/api registers paths the contract does not document "
        f"(a client cannot discover these): {undocumented}"
    )

# (2) Every web→Go proxy path is served by the Go api.
unserved = sorted(set(proxies) - api_paths)
if unserved:
    detail = ", ".join(f"{p} ({proxies[p]})" for p in unserved)
    fails.append(
        f"web route proxies to the Go api on a path it does not register (a 502 in production): {detail}"
    )

# (3) Guard against a vacuous pass: the proxy table this gate reads must be non-empty.
if not proxies:
    fails.append("no web→Go proxy routes found — the parser drifted (expected >=1)")

if fails:
    print("API_CONTRACT_FAIL:")
    for f in fails:
        print(f"  - {f}")
    sys.exit(1)

print(
    f"API_CONTRACT_OK go_paths={len(api_paths)} documented={len(doc_paths)} "
    f"web_proxies={len(proxies)}:{','.join(sorted(proxies))}"
)

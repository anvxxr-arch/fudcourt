#!/usr/bin/env python3
"""Offline contract checks — no network, no DB (PLAN T-2.2.2, R-2).
1. CR_MODES in src/features/cryptorank/client.ts must match the cryptorank query list in
   verify_all_routes.py and the mode spot-list in verify-cryptorank.py.
2. Every mutating handler in app/api/{transactions,transactions/[id],wallets}
   must `await requireMutationAuth(req)` (R-6 fail-closed session-tier auth —
   regression guard for the 2026-09-28 incident where an unguarded DELETE probe
   hit real data, and for the retired x-fud-token that leaked into the client
   bundle).
3. ONE CONTRACT, TWO IMPLEMENTATIONS: the Go sidecar (backend/data) owns the
   CryptoRank mode/key tables at runtime, so its table in
   internal/research/cryptorank/modes.go must EQUAL the TS table in src/features/cryptorank/client.ts --
   mode list, disabled list, the exchange/launchpool/nodesale/RWA whitelists
   and the two keyed tables. Drift here means the Go service accepts or serves
   something the rest of this repo does not document (or vice versa), which is
   exactly the class of bug the migration to one implementation was meant to
   end. If the Go table is not on disk this check SKIPs loudly (never passes
   silently).
4. The cutover itself: app/api/cryptorank/route.ts must be a pure proxy -- no
   `execFile`, no python helper path, no second copy of the validation. That is
   the same invariant as (3) from the other side.
Exit 0 = all consistent, exit 1 = contract broken.
"""
import os
import re
import sys
from pathlib import Path
# This gate is repo-wide (it diffs the TS mode tables against the Go ones), so it
# lives in scripts/verify/ and resolves everything from the repo root — the web app
# is the frontend/web subdirectory. Cwd-independent by construction: CI runs it from
# frontend/web, verify-all.sh from the repo root, an operator from anywhere.
REPO = Path(__file__).resolve().parents[2]  # scripts/verify/ -> scripts -> repo
WEB = REPO / "frontend" / "web"
# Every TS source lives under src/ (DR-018), so the gate resolves its TS side
# through that single root instead of hardcoding an old location. The `app/`
# route tree is at SRC/app; a `lib/` no longer exists — putting one back would
# make the feature lookups below fail loudly, which is the intended behaviour.
SRC = WEB / "src"
# Normally backend/data/internal/cryptorank/modes.go; overridable so the parity
# gate can be exercised (and so CI survives a different checkout layout).
GO_TABLE = Path(os.environ.get(
    "FUDCOURT_DATA_MODES_GO", REPO / "backend" / "data" / "internal" / "research" / "cryptorank" / "modes.go"))
fails = []
def modes_from_lib() -> set:
    src = (SRC / "features" / "cryptorank" / "client.ts").read_text()
    m = re.search(r"export const CR_MODES = \[([^\]]*)\]", src, re.S)
    if not m:
        fails.append("src/features/cryptorank/client.ts: CR_MODES not found")
        return set()
    return set(re.findall(r"'([a-z0-9-]+)'", m.group(1)))
def sweep_modes_from(src: str) -> set:
    """Mode tokens of the route sweep's cryptorank table (the CR list only).

    Scoped deliberately: the khala/llama/chainrank tables in the same file carry
    their own mode= strings (`report`, `protocols`, `latest`, …) which are NOT
    cryptorank modes, so a whole-file regex invents a false mismatch.
    """
    # NB the marker must NOT include the opening bracket: block_after() scans for
    # the open char AFTER the marker, so "CR = [" would skip this list's own `[`
    # and capture the next one in the file (the khala table).
    body = block_after(src, "CR = ", "[", "]")
    if body is None:
        return set()
    return set(re.findall(r'"mode=([a-z0-9-]+)', body)) - {"bogus"}


def modes_from_sweep() -> set:
    """The cryptorank mode set an independent route sweep witnesses.

    The sweep is a web-only artifact and moved to frontend/web/tests/ in the
    restructure. The path fetched from ~/.hermes/cache/… is a machine-local
    operator copy that CI can never have — reading it made this comparison
    unfalsifiable on a runner, so it is not consulted any more.
    """
    p = REPO / "frontend" / "web" / "tests" / "verify_all_routes.py"
    if not p.exists():
        return set()
    return sweep_modes_from(p.read_text())
def check_guards():
    api = SRC / "app" / "(frontend)" / "api"
    targets = [api / "transactions" / "route.ts", api / "transactions" / "[id]" / "route.ts",
               api / "wallets" / "route.ts"]
    for f in targets:
        src = f.read_text()
        handlers = re.findall(r"export async function (POST|PUT|PATCH|DELETE)\([^)]*\)\s*\{", src)
        guards = len(re.findall(r"await requireMutationAuth\(req\)", src))
        if not handlers:
            fails.append(f"{f.name}: no mutation handlers found (parse drift?)")
        elif guards != len(handlers):
            fails.append(f"{f.relative_to(SRC)}: {len(handlers)} mutation handlers but "
                         f"{guards} requireMutationAuth guards")
def block_after(src: str, marker: str, open_ch: str = "{", close_ch: str = "}") -> str | None:
    """Body of the balanced open_ch..close_ch block after the first `marker`."""
    i = src.find(marker)
    if i < 0:
        return None
    j = src.find(open_ch, i + len(marker))
    if j < 0:
        return None
    depth = 0
    for k in range(j, len(src)):
        c = src[k]
        if c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return src[j + 1:k]
    return None
def tokens(body: str | None, quote: str) -> set | None:
    if body is None:
        return None
    return set(re.findall(r"%s([^%s]*)%s" % (quote, quote, quote), body))
def keys_of(body: str | None, quote: str = '"') -> set | None:
    """Map-literal keys: `"key": …` (Go) or `key: …` (TS, unquoted)."""
    if body is None:
        return None
    if quote:
        return set(re.findall(r"^\s*\"([A-Za-z0-9_-]+)\":", body, re.M))
    return set(re.findall(r"^\s*([A-Za-z0-9_-]+):", body, re.M))
def check_go_table() -> bool:
    """Go cryptorank table must equal the TS table (both languages, same contract)."""
    if not GO_TABLE.exists():
        # The TS side is the tracked source of truth and is always present, so a
        # missing Go table is a broken checkout, not an optional comparison: the
        # old skip let all nine rows pass vacuously while still printing CONTRACT_OK.
        fails.append(f"backend/data mode table not found at {GO_TABLE} — the TS<->Go parity "
                     "rows cannot run (tracked source missing?)")
        return False
    ts = (SRC / "features" / "cryptorank" / "client.ts").read_text()
    go = GO_TABLE.read_text()
    # (label, TS declaration, Go declaration, kind) -- kind: list | map
    pairs = [
        ("CR_MODES", "CR_MODES", "Modes", "list"),
        ("CR_DISABLED", "CR_DISABLED", "Disabled", "list"),
        ("CR_EXCHANGE_LISTS", "CR_EXCHANGE_LISTS", "ExchangeLists", "list"),
        ("CR_LP_LISTS", "CR_LP_LISTS", "LPLists", "list"),
        ("CR_ND_LISTS", "CR_ND_LISTS", "NDLists", "list"),
        ("CR_RWA_TYPES", "CR_RWA_TYPES", "RwaTypes", "list"),
        ("CR_CATEGORY_SLUGS", "CR_CATEGORY_SLUGS", "CategorySlugs", "list"),
        ("CR_KEYED_PATHS", "CR_KEYED_PATHS", "KeyedPaths", "map"),
        ("CR_DEFAULT_KEYS", "CR_DEFAULT_KEYS", "DefaultKeys", "map"),
    ]
    for label, ts_name, go_name, kind in pairs:
        if kind == "list":
            want = tokens(block_after(ts, f"export const {ts_name} = ", "[", "]"), "'")
            got = tokens(block_after(go, f"var {go_name} = []string", "{", "}"), '"')
        else:
            want = keys_of(block_after(ts, f"export const {ts_name}", "{", "}"), quote=None)
            got = keys_of(block_after(go, f"var {go_name} = map[", "{", "}"))
        if want is None:
            fails.append(f"src/features/cryptorank/client.ts: {label} not found (parse drift?)")
        elif got is None:
            fails.append(f"internal/cryptorank/modes.go: {go_name} not found (parse drift?)")
        elif want != got:
            fails.append(f"{label} drift TS vs Go: only-ts={sorted(want - got)} "
                         f"only-go={sorted(got - want)}")
    n_go = len(tokens(block_after(go, "var Modes = []string", "{", "}"), '"') or ())
    if n_go < 20:
        fails.append(f"Go Modes only has {n_go} modes (expected >= 20)")
    return True
def check_route_is_proxy(rel: str = "cryptorank", needles=("execFile", "child_process", "cr_fetch", "CR_PYTHON", "CR_MODES.includes")):
    """A sidecar-proxy route must not spawn python or re-implement validation."""
    route = SRC / "app" / "(frontend)" / "api" / rel / "route.ts"
    if not route.exists():
        # Family not landed yet (or removed): skip, never fail -- the same
        # convention modes_from_sweep() uses for a machine-local artifact.
        return False
    src = route.read_text()
    # comments are allowed to *talk* about an old path; only code counts
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    src = re.sub(r"//[^\n]*", "", src)
    for needle in needles:
        if needle in src:
            fails.append(f"src/app/(frontend)/api/{rel}/route.ts: {needle!r} present — the route must be "
                         f"a thin proxy to backend/data (Go owns validation)")
    if "DATA_URL" not in src:
        fails.append(f"src/app/(frontend)/api/{rel}/route.ts: no DATA_URL upstream base — proxy wiring lost")
    return True
lib = modes_from_lib()
sweep = modes_from_sweep()
if lib and len(lib) < 20:
    fails.append(f"CR_MODES only has {len(lib)} modes (expected >= 20)")
if not sweep:
    # No witness is a FAIL, not a skip: a comparison that cannot run on CI must
    # never be reported as a parity result (the sweep is tracked in-repo now).
    fails.append("sweep witness missing: frontend/web/tests/verify_all_routes.py has no "
                 "cryptorank CR table (the lib<->sweep parity check cannot run)")
elif lib and sweep != lib:
    fails.append(f"mode set mismatch lib vs sweep: only-lib={sorted(lib - sweep)} "
                 f"only-sweep={sorted(sweep - lib)}")
check_guards()
go_checked = check_go_table()
check_route_is_proxy()
# khala: the second sidecar-resident family. Its TS table (src/features/khala/client.ts) and Go
# table (internal/khala/modes.go) are one contract; the mode set must be equal.
# Both sides are skipped-not-failed when absent so this gate can land before the
# family does (same convention as modes_from_sweep).
KH_TS = SRC / "features" / "khala" / "client.ts"
KH_GO = Path(os.environ.get("FUDCOURT_DATA_KHALA_GO",
                            REPO / "backend" / "data" / "internal" / "research" / "khala" / "modes.go"))
kh_parity = "khala absent"
if KH_TS.exists() and KH_GO.exists():
    kh_ts_modes = set(re.findall(
        r"'([a-z0-9-]+)'", block_after(KH_TS.read_text(), "export const KH_MODES =", "[", "]") or ""))
    kh_go_modes = set(re.findall(
        r'"([a-z0-9-]+)"', block_after(KH_GO.read_text(), "var Modes = []string", "{", "}") or ""))
    if not kh_ts_modes:
        fails.append("src/features/khala/client.ts: KH_MODES not found (parse drift?)")
    elif not kh_go_modes:
        fails.append("internal/khala/modes.go: Modes not found (parse drift?)")
    elif kh_ts_modes != kh_go_modes:
        fails.append(f"KH_MODES drift TS vs Go: only-ts={sorted(kh_ts_modes - kh_go_modes)} "
                     f"only-go={sorted(kh_go_modes - kh_ts_modes)}")
    else:
        kh_parity = f"khala KH_MODES parity ({len(kh_ts_modes)} modes)"
elif KH_TS.exists() or KH_GO.exists():
    # One side without the other is drift, not an absent family: both live in this
    # tree, so a half-present pair would silently drop the comparison.
    missing = "backend/data/internal/research/khala/modes.go" if KH_TS.exists() else str(KH_TS)
    fails.append(f"khala parity cannot run: {missing} is missing (both sides are tracked)")
    kh_parity = "khala parity FAILED (one side absent)"
if check_route_is_proxy("khala"):
    kh_parity += ", route is a proxy"
# llama: the THIRD sidecar-resident family (PLAN G9 SG-9.3). Same convention as
# khala -- src/features/llama/client.ts carries the TS mode list, backend/data/internal/research/llama/
# modes.go the Go one, and the route must be the verbatim proxy.
LL_TS = SRC / "features" / "llama" / "client.ts"
LL_GO = Path(os.environ.get("FUDCOURT_DATA_LLAMA_GO",
                            REPO / "backend" / "data" / "internal" / "research" / "llama" / "modes.go"))
ll_parity = "llama absent"
if LL_TS.exists() and LL_GO.exists():
    ll_ts_modes = set(re.findall(
        r"'([a-z0-9-]+)'", block_after(LL_TS.read_text(), "LLAMA_MODES =", "[", "]") or ""))
    ll_go_modes = set(re.findall(
        r'"([a-z0-9-]+)"', block_after(LL_GO.read_text(), "var Modes = []string", "{", "}") or ""))
    if not ll_ts_modes:
        fails.append("src/features/llama/client.ts: LLAMA_MODES not found (parse drift?)")
    elif not ll_go_modes:
        fails.append("internal/llama/modes.go: Modes not found (parse drift?)")
    elif ll_ts_modes != ll_go_modes:
        fails.append(f"LLAMA_MODES drift TS vs Go: only-ts={sorted(ll_ts_modes - ll_go_modes)} "
                     f"only-go={sorted(ll_go_modes - ll_ts_modes)}")
    else:
        ll_parity = f"llama LLAMA_MODES parity ({len(ll_ts_modes)} modes)"
elif LL_TS.exists() or LL_GO.exists():
    missing = "backend/data/internal/research/llama/modes.go" if LL_TS.exists() else str(LL_TS)
    fails.append(f"llama parity cannot run: {missing} is missing (both sides are tracked)")
    ll_parity = "llama parity FAILED (one side absent)"
if check_route_is_proxy("llama", ("execFile", "child_process", "limitedFetch",
                                  "LLAMA_MODES.includes", "parseInt")):
    ll_parity += ", route is a proxy"
# news: the FOURTH sidecar-resident family (PLAN G12 SG-12.3), and the first
# whose upstream is a DOCUMENT rather than a JSON API. Same convention as
# llama -- src/features/news/client.ts carries the TS feed list, backend/data/internal/research/news/
# modes.go the Go one, and the route must be the verbatim proxy. The RSS parser
# itself must not come back: src/features/llama/client.ts-style mirror has no parse code, and a
# route that regrows one is the drift this row exists to catch.
NW_TS = SRC / "features" / "news" / "client.ts"
NW_GO = Path(os.environ.get("FUDCOURT_DATA_NEWS_GO",
                            REPO / "backend" / "data" / "internal" / "research" / "news" / "modes.go"))
nw_parity = "news absent"
if NW_TS.exists() and NW_GO.exists():
    nw_ts_sources = set(re.findall(
        r"'([a-z0-9-]+)'", block_after(NW_TS.read_text(), "NEWS_SOURCES =", "[", "]") or ""))
    nw_go_sources = set(re.findall(
        r'Name:\s*"([a-z0-9-]+)"', NW_GO.read_text()))
    if not nw_ts_sources:
        fails.append("src/features/news/client.ts: NEWS_SOURCES not found (parse drift?)")
    elif not nw_go_sources:
        fails.append("internal/news/modes.go: Sources not found (parse drift?)")
    elif nw_ts_sources != nw_go_sources:
        fails.append(f"NEWS_SOURCES drift TS vs Go: only-ts={sorted(nw_ts_sources - nw_go_sources)} "
                     f"only-go={sorted(nw_go_sources - nw_ts_sources)}")
    else:
        nw_parity = f"news NEWS_SOURCES parity ({len(nw_ts_sources)} feeds)"
    # The bounds are a frozen 400 boundary; assert the pair, not just the names.
    for name, want in (("NEWS_LIMIT_MIN", "1"), ("NEWS_LIMIT_MAX", "100")):
        m = re.search(rf"{name}\s*=\s*{want}\b", NW_TS.read_text())
        if not m:
            fails.append(f"src/features/news/client.ts: {name} must be {want} (the Go 400 boundary)")
elif NW_TS.exists() or NW_GO.exists():
    missing = "backend/data/internal/research/news/modes.go" if NW_TS.exists() else str(NW_TS)
    fails.append(f"news parity cannot run: {missing} is missing (both sides are tracked)")
    nw_parity = "news parity FAILED (one side absent)"
# `parseInt`/`Math.min` were the silent-coercion pair the original TS route used;
# `XMLParser`/`<item>` would mean the parse came back. All four are code smells
# here, not just prose (comments are stripped by the helper).
if check_route_is_proxy("news", ("execFile", "child_process", "limitedFetch",
                                 "NEWS_SOURCES.includes", "parseInt", "Math.min",
                                 "<item>", "stripCdata")):
    nw_parity += ", route is a proxy"
# chainrank: the FIFTH sidecar-resident family (PLAN G13 SG-13.4). Same
# convention, with one extra assertion the relay-verbatim rule needs: the route
# must not clamp pagination locally (a `Math.min`/`Number()` on pageSize is the
# drift this row exists to catch, because upstream's own clamp is the answer the
# board must show).
CH_TS = SRC / "features" / "chainrank" / "client.ts"
CH_GO = Path(os.environ.get("FUDCOURT_DATA_CHAINRANK_GO",
                            REPO / "backend" / "data" / "internal" / "research" / "chainrank" / "modes.go"))
ch_parity = "chainrank absent"
if CH_TS.exists() and CH_GO.exists():
    ch_ts_modes = set(re.findall(
        r"'([a-z0-9-]+)'", block_after(CH_TS.read_text(), "CR_MODES =", "[", "]") or ""))
    ch_go_modes = set(re.findall(
        r'"([a-z0-9-]+)"', block_after(CH_GO.read_text(), "var Modes = []string", "{", "}") or ""))
    if not ch_ts_modes:
        fails.append("src/features/chainrank/client.ts: CR_MODES not found (parse drift?)")
    elif not ch_go_modes:
        fails.append("internal/chainrank/modes.go: Modes not found (parse drift?)")
    elif ch_ts_modes != ch_go_modes:
        fails.append(f"chainrank CR_MODES drift TS vs Go: only-ts={sorted(ch_ts_modes - ch_go_modes)} "
                     f"only-go={sorted(ch_go_modes - ch_ts_modes)}")
    else:
        ch_parity = f"chainrank CR_MODES parity ({len(ch_ts_modes)} modes)"
    # The write endpoints stay unproxied: a route that learned /api/click would
    # be relaying someone else's production mutation.
    route_src = re.sub(r"/\*.*?\*/", "", (SRC / "app" / "(frontend)" / "api" / "chainrank" / "route.ts").read_text(), flags=re.S)
    for verb in ("click", "presence", "claim", "upload"):
        if f"/api/{verb}" in route_src:
            fails.append(f"app/api/chainrank/route.ts: /api/{verb} present — writes must never be proxied")
elif CH_TS.exists() or CH_GO.exists():
    missing = "backend/data/internal/research/chainrank/modes.go" if CH_TS.exists() else str(CH_TS)
    fails.append(f"chainrank parity cannot run: {missing} is missing (both sides are tracked)")
    ch_parity = "chainrank parity FAILED (one side absent)"
if check_route_is_proxy("chainrank", ("execFile", "child_process", "limitedFetch",
                                      "CR_MODES.includes", "Math.min", "pageSize")):
    ch_parity += ", route is a proxy"
# coinglass / coinank / coinmarketcap: the three KEYLESS sidecar families, whose web
# half (the `/api/<family>` proxy + the typing mirror) is now wired. Same convention
# as khala/llama/news/chainrank -- src/features/<family>/client.ts carries the TS mode
# table, backend/data/internal/research/<family>/modes.go the Go one, and the route must be
# the verbatim proxy. Their modes are camelCase (`openInterest`, `marketPairs`), so
# the token regex admits uppercase where the older families' all-lowercase one did not.
# The route must NOT re-implement the family's mechanism: coinglass decrypts an
# encrypted body, coinank computes a request signature, coinmarketcap clamps nothing
# (its bounds are the sidecar's, validated before any fetch).
def _keyless_parity(prefix, family, needles):
    """TS<->Go mode-table parity + proxy-shape check for one keyless family.

    `prefix` is the TS/Go const prefix (CG/CN/CMC); `family` is the package + route
    segment (coinglass/coinank/coinmarketcap) -- they differ, so the route path must
    be built from `family`, never from prefix.lower().
    """
    ts = SRC / "features" / family / "client.ts"
    go = Path(os.environ.get(f"FUDCOURT_DATA_{family.upper()}_GO",
                             str(REPO / "backend" / "data" / "internal" / "research" / family / "modes.go")))
    row = f"{family} absent"
    if ts.exists() and go.exists():
        ts_modes = set(re.findall(
            r"'([A-Za-z0-9-]+)'", block_after(ts.read_text(), f"{prefix}_MODES =", "[", "]") or ""))
        go_modes = set(re.findall(
            r'"([A-Za-z0-9-]+)"', block_after(go.read_text(), "var Modes = []string", "{", "}") or ""))
        if not ts_modes:
            fails.append(f"src/features/{family}/client.ts: {prefix}_MODES not found (parse drift?)")
        elif not go_modes:
            fails.append(f"internal/research/{family}/modes.go: Modes not found (parse drift?)")
        elif ts_modes != go_modes:
            fails.append(f"{family} {prefix}_MODES drift TS vs Go: "
                         f"only-ts={sorted(ts_modes - go_modes)} only-go={sorted(go_modes - ts_modes)}")
        else:
            row = f"{family} {prefix}_MODES parity ({len(ts_modes)} modes)"
    elif ts.exists() or go.exists():
        missing = (f"backend/data/internal/research/{family}/modes.go" if ts.exists() else str(ts))
        fails.append(f"{family} parity cannot run: {missing} is missing (both sides are tracked)")
        row = f"{family} parity FAILED (one side absent)"
    if check_route_is_proxy(family, needles):
        row += ", route is a proxy"
    return row
cg_parity = _keyless_parity(
    "CG", "coinglass",
    ("execFile", "child_process", "limitedFetch", "CG_MODES.includes",
     "createDecipheriv", "gunzip"))
cn_parity = _keyless_parity(
    "CN", "coinank",
    ("execFile", "child_process", "limitedFetch", "CN_MODES.includes",
     "coinank-apikey", "createHash"))
cmc_parity = _keyless_parity(
    "CMC", "coinmarketcap",
    ("execFile", "child_process", "limitedFetch", "CMC_MODES.includes",
     "Math.min", "parseInt"))
# reconcile: a RUST-served route (PLAN G9 SG-9.7 / DR-014), not a sidecar family,
# so there is no mode table to compare. The drift this row exists to catch is the
# one a proxy route can still have: spawning a second implementation instead of
# proxying, losing its upstream base, or -- the specific hazard here -- silently
# FALLING BACK to the local shaper when the Rust service is down. That fallback
# would keep the board rendering from a source nothing verified, which is exactly
# the failure mode the house refuses; the route must fail loud instead.
RC_ROUTE = SRC / "app" / "(frontend)" / "api" / "reconcile" / "route.ts"
rc_row = "reconcile absent"
if RC_ROUTE.exists():
    src = re.sub(r"/\*.*?\*/", "", RC_ROUTE.read_text(), flags=re.S)
    src_nocomment = re.sub(r"//[^\n]*", "", src)
    if "RECONCILE" not in src_nocomment:
        fails.append("src/app/(frontend)/api/reconcile/route.ts: no RECONCILE upstream base — proxy wiring lost")
    # `reconcile(` is the shaper's call shape: importing it here would make the TS
    # implementation a runtime path again.
    if re.search(r"import[^;]*from\s+['\"][^'\"]*lib/reconcile", src_nocomment) or "reconcile(" in src_nocomment:
        fails.append("src/app/(frontend)/api/reconcile/route.ts: imports/calls the TS shaper — the Rust "
                     "service owns this route; src/features/treasury/reconcile.ts is the oracle, not a fallback")
    if "502" not in src_nocomment:
        fails.append("src/app/(frontend)/api/reconcile/route.ts: no 502 path — an unreachable service must fail loud")
    # src/features/treasury/reconcile.ts must still exist as the oracle, or parity has no second side.
    if not (SRC / "features" / "treasury" / "reconcile.ts").exists():
        fails.append("src/features/treasury/reconcile.ts: the TS oracle is gone — parity has no second side")
    elif not (REPO / "scripts" / "verify" / "verify-reconcile.py").exists():
        fails.append("scripts/verify/verify-reconcile.py: contract harness is gone")
    else:
        rc_row = "reconcile is a Rust-served proxy (oracle kept, 502 path present)"
if fails:
    print("CONTRACT_FAIL:")
    for f in fails:
        print(" -", f)
    sys.exit(1)
parity = "TS/Go mode table parity" if go_checked else "Go parity SKIPPED (table absent)"
print(f"CONTRACT_OK (CR_MODES={len(lib)} modes, {parity}, {kh_parity}, {ll_parity}, "
      f"{nw_parity}, {ch_parity}, {cg_parity}, {cn_parity}, {cmc_parity}, {rc_row}, "
      f"mutation guards verified)")

"""Verify EVERY route/endpoint of fudcourt web (live, zero side effects).

Re-aligned 2026-09-29 to the repurpose pass (commit 5e68576 "re-align every
surface"), read out of the running build, not from memory:

- Pages: live HTML -> 200. The market hub absorbed the standalone boards, so
  `/ticker`, `/tracker`, `/llama`, `/markets`, `/market/ticker`, `/dex`,
  `/trench`, `/ticker/:ticker` and `/market/ticker/:ticker` are deliberate 307s
  into the hub (next.config.js, ARCHITECTURE.md §3) and are asserted as such.
  `/coin` and `/balance` were removed and must answer a REAL 404.
  An off-allowlist coin (`/market/crypto/FOO`) must render the NOT-FOUND page
  rather than the live detail shell — a soft-404. NOTE the status line: Next
  16.3.6 answers HTTP 200 for EVERY notFound() in this app, so this probe
  asserts on the BODY, not the status. See the FOO probe below and
  docs/architecture/design-debt.md §notFound-status.
- Treasury reads (/api/all, /coins, /wallets, /reconcile, /transactions) are
  session-gated (lib/guard.ts TEAM_API_ROUTES + middleware.ts): anonymous ->
  JSON 401. Gated pages (/team/**, /member, /admin) -> 307 to /login?next=…
- Mutations D1: NO cookie -> 401 fail-closed (lib/mutation-auth.ts).
- Mutations D2: WITH a signed `fud_session` admin cookie -> the handler runs.
  Every probe is validation-first, so the expected status is the route's own
  local 400 and ZERO rows are written (DELETE /api/transactions/999999999 is a
  read-only 404: the handler SELECTs before it would ever DELETE, and the row
  does not exist). This replaces the retired `x-fud-token` probe: that header
  grants nothing any more (docs/architecture/ARCHITECTURE.md §6).
  The cookie is minted exactly like apps/web/tests/auth-tests.ts does it:
      payload = base64url(JSON.stringify(SessionUser + exp))
      cookie  = payload + "." + base64url(HMAC-SHA256(secret, payload))
  The secret is discovered from (in order) the listening server's own
  /proc/<pid>/environ, then this process's FUDCOURT_SESSION_SECRET, then
  apps/web/.env.local. If none is found (or the server rejects the minted
  cookie) the D2 checks report an ENVIRONMENTAL fail naming that reason — the
  fail-closed 401/D1 checks stay meaningful regardless.
- cryptorank: all 28 modes + keyed variants + error contract.
(chainrank and khala are no longer swept: their web surfaces were removed in
DR-041 — the boards and their /api/* proxies are gone, so :3100 has nothing to
probe. Their sidecar families are still exercised directly against :3101 by
scripts/verify/verify-chainrank.py and verify-khala.py.)
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from collections import Counter

B = os.environ.get("SWEEP_BASE", "http://127.0.0.1:3100")
REPO = "/home/dwizzy/fudcourt"
WEB = os.path.join(REPO, "frontend", "web")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # surface the 3xx itself; assert the redirect, not its landing page


OPENER = urllib.request.build_opener(_NoRedirect)
results = []


def hit(path, method="GET", body=None, timeout=90, cookie=None):
    req = urllib.request.Request(B + path, method=method)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with OPENER.open(req, data, timeout=timeout) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw)
            except Exception:
                return r.status, {"_html": len(raw)}
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"_raw": raw[:120].decode("utf-8", "replace")}
    except Exception as e:  # noqa: BLE001
        return 0, {"error": f"{type(e).__name__}: {e}"}


def rec(group, name, st, want, body):
    want_ok = st in (want if isinstance(want, tuple) else (want,))
    verdict = "PASS" if want_ok else "FAIL"
    results.append((verdict, group, name, st, json.dumps(body, default=str)[:90]))
    return want_ok


# --------------------------------------------------------------------------
# session minting (mirrors apps/web/tests/auth-tests.ts createSessionToken)
# --------------------------------------------------------------------------
def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _listening_pid(port):
    """PID of the process LISTENing on `port`, from /proc/net/tcp + /proc/*/fd."""
    inodes = set()
    for f in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            lines = open(f).read().splitlines()[1:]
        except OSError:
            continue
        for ln in lines:
            p = ln.split()
            if len(p) < 10 or p[3] != "0A":  # 0A == TCP_LISTEN
                continue
            try:
                if int(p[1].split(":")[1], 16) != port:
                    continue
            except (IndexError, ValueError):
                continue
            inodes.add(p[9])
    if not inodes:
        return None
    for ent in os.listdir("/proc"):
        if not ent.isdigit():
            continue
        fd_dir = f"/proc/{ent}/fd"
        try:
            fds = os.listdir(fd_dir)
        except OSError:
            continue
        for fd in fds:
            try:
                tgt = os.readlink(f"{fd_dir}/{fd}")
            except OSError:
                continue
            if tgt.startswith("socket:[") and tgt[8:-1] in inodes:
                return int(ent)
    return None


def _valid(secret):
    return secret if secret and len(secret) >= 32 else None


def session_secret():
    """(secret, where) — the key the RUNNING server signs with, if discoverable."""
    port = urllib.parse.urlparse(B).port or 80
    pid = _listening_pid(port)
    if pid is not None:
        try:
            env = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
            for item in env:
                if item.startswith(b"FUDCOURT_SESSION_SECRET="):
                    s = _valid(item.split(b"=", 1)[1].decode("utf-8", "replace"))
                    if s:
                        return s, f"listening pid {pid} environ"
        except OSError:
            pass
    s = _valid(os.environ.get("FUDCOURT_SESSION_SECRET"))
    if s:
        return s, "FUDCOURT_SESSION_SECRET in the sweep's own env"
    try:
        for ln in open(os.path.join(WEB, ".env.local")):
            if ln.strip().startswith("FUDCOURT_SESSION_SECRET="):
                s = _valid(ln.strip().split("=", 1)[1].strip().strip('"').strip("'"))
                if s:
                    return s, f"{WEB}/.env.local"
    except OSError:
        pass
    return None, None


SECRET, SECRET_SRC = session_secret()
SESSION = None
if SECRET:
    user = {"id": "1961200000000000000", "username": "sweep-audit",
            "globalName": "Route Sweep", "avatar": None, "tier": "admin", "roles": []}
    payload = _b64url(json.dumps(
        {**user, "exp": int(time.time()) + 3600}, separators=(",", ":")).encode())
    sig = _b64url(hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).digest())
    SESSION = f"fud_session={payload}.{sig}"

SESSION_OK = False
SESSION_WHY = "no FUDCOURT_SESSION_SECRET discoverable (server /proc, sweep env, .env.local)"
if SESSION:
    st, b = hit("/api/all", cookie=SESSION, timeout=30)
    if st == 200:
        SESSION_OK = True
        SESSION_WHY = f"signed admin cookie accepted (secret from {SECRET_SRC})"
    else:
        SESSION_WHY = (f"server has a session secret but rejected the minted admin cookie "
                       f"(/api/all -> {st}); secret from {SECRET_SRC} does not match the server")
print(f"# session: {SESSION_WHY}", flush=True)

print("=== A. pages ===", flush=True)
for p in ["/", "/market", "/market/crypto", "/market/trench", "/market/forex",
          "/market/stock", "/market/commodity", "/market/crypto/BTC",
          "/news", "/scoreboard", "/signals",
          # the public boards added by the data-breadth pass (all 200 live)
          "/risk", "/proof", "/derivatives", "/etf", "/global", "/breadth", "/whales",
          # the TIER-2 idle-mode boards (all 200 live)
          "/chains", "/sectors", "/coins", "/media", "/insights",
          # the TIER-3 last idle-mode boards (all 200 live)
          "/screener", "/funding"]:
    st, b = hit(p, timeout=60)
    rec("page", p, st, 200, b)
# The market hub absorbed the standalone boards: their old paths are deliberate
# 307s into the hub (next.config.js, documented in ARCHITECTURE.md §3). Assert
# the redirect status so a dropped or renamed redirect is caught, not 404'd.
for src in ["/ticker", "/tracker", "/llama", "/markets", "/market/ticker",
            "/dex", "/trench", "/ticker/BTC", "/ticker/ETH",
            "/market/ticker/BTC", "/market/ticker/ETH"]:
    st, b = hit(src, timeout=60)
    rec("page", f"{src} -> 307 into the hub", st, 307, b)
# Real 404s: two removed routes. Their handlers are gone, so Next's own
# catch-all answers and the status is a true 404.
for p, why in [("/coin", "route removed"), ("/balance", "route removed")]:
    st, b = hit(p, timeout=60)
    rec("page", f"{p} -> 404 (real 404, {why})", st, 404, b)
# An off-allowlist coin on the detail route. `notFound()` fires and the
# (frontend)/not-found boundary renders, but Next 16.3.6 answers HTTP 200 for
# EVERY notFound() in this app -- /blog/<unknown>, /economy/nation/ZZ and
# /trade/notatype behave identically (measured 2026-10-06). So the assertion is
# on the BODY, which is the thing that actually distinguishes a real 404 page
# from a soft-404 that renders the live detail shell for a coin nobody quotes.
# The status-line defect is app-wide and tracked separately; asserting 404 here
# would be a knowingly red test.
st, b = hit("/market/crypto/FOO", timeout=60)
# Markers that exist ONLY in the live detail shell, not in the not-found
# boundary: the metadata description ("Cross-checked ... prices across
# centralized exchanges") is present on both, because Next renders the
# generateMetadata head either way. "Loading venues" and the empty-table copy
# are the component's own output.
soft = ("Loading venues" in b) or ("No venue lists this type for this coin" in b)
notfound_body = ("NOT FOUND" in b) or ("does not exist" in b)
# rec() compares status against `want`, so the body verdict is recorded through
# the name: a FAIL line here means the detail shell rendered for an unquoted
# coin, which is the soft-404 this probe exists to catch.
name = "/market/crypto/FOO -> not-found body, no detail shell" if (not soft and notfound_body) \
    else f"/market/crypto/FOO -> SOFT-404 (detail shell rendered: soft={soft}, notfound_body={notfound_body})"
rec("page", name, st, (200, 404), b)
for p in ["/robots.txt", "/sitemap.xml"]:
    st, b = hit(p, timeout=60)
    rec("page", p, st, 200, b)

print("=== B. anonymous gates ===", flush=True)
for p in ["/team/balance", "/team/portfolio", "/team/wallets", "/team/transactions",
          "/team/reconciliation", "/team/journal", "/team/plans", "/member", "/admin"]:
    st, b = hit(p, timeout=60)
    rec("gate", f"{p} anon -> 307 login", st, 307, b)

print("=== C. API GET endpoints ===", flush=True)
# treasury reads are session-gated: no cookie -> JSON 401 (never HTML)
for p, name in [("/api/all", "/api/all anon -> 401"),
                ("/api/coins", "/api/coins anon -> 401"),
                ("/api/wallets", "/api/wallets (list) anon -> 401"),
                ("/api/reconcile", "/api/reconcile anon -> 401"),
                ("/api/transactions?limit=5", "/api/transactions?limit=5 anon -> 401"),
                ("/api/journal", "/api/journal anon -> 401"),
                ("/api/plans", "/api/plans anon -> 401"),
                ("/api/admin/members", "/api/admin/members anon -> 401")]:
    st, b = hit(p)
    rec("api", name, st, 401, b)
st, b = hit("/api/news?source=cointelegraph&limit=2")
rec("api", "/api/news?source&limit", st, 200, b)
st, b = hit("/api/news?source=bogus")
rec("api", "/api/news unknown source", st, 400, b)
# news strict-param matrix (PLAN G12 SG-12.3): the sidecar owns these 400s and
# the proxy must forward them verbatim, so the two silent-coercion defects the
# original TS route shipped are pinned as regressions here.
st, b = hit("/api/news?limit=0")
rec("api", "/api/news limit=0", st, 400, b)
st, b = hit("/api/news?limit=101")
rec("api", "/api/news limit=101", st, 400, b)
st, b = hit("/api/news?limit=abc")
rec("api", "/api/news limit=abc", st, 400, b)
st, b = hit("/api/news?limit=")
rec("api", "/api/news limit empty", st, 400, b)
st, b = hit("/api/news?source=")
rec("api", "/api/news source empty", st, 400, b)
st, b = hit("/api/news?limit=100")
rec("api", "/api/news limit=100 (head slice)", st, 200, b)
st, b = hit("/api/markets?search=btc&limit=5")
rec("api", "/api/markets?search&limit", st, 200, b)
st, b = hit("/api/markets?sort=bogus")
rec("api", "/api/markets bad sort", st, 400, b)
st, b = hit("/api/signals?chain=solana&type=index")
rec("api", "/api/signals?chain&type", st, 200, b)
# ticker family: 3 routes, strict param validation, allowlisted symbol lookup
st, b = hit("/api/ticker?type=spot", timeout=300)
rec("api", "/api/ticker?type=spot", st, 200, b)
st, b = hit("/api/ticker?type=bogus", timeout=60)
rec("api", "/api/ticker bad type -> 400", st, 400, b)
st, b = hit("/api/ticker/instruments?symbol=BTC%2FUSDT", timeout=300)
rec("api", "/api/ticker/instruments?symbol=BTC/USDT", st, 200, b)
st, b = hit("/api/ticker/instruments?symbol=NOPE%2FUSDT", timeout=120)
rec("api", "/api/ticker/instruments unknown symbol -> 404", st, 404, b)
st, b = hit("/api/ticker/instrument?base=BTC&type=spot", timeout=300)
rec("api", "/api/ticker/instrument?base=BTC&type=spot", st, 200, b)
st, b = hit("/api/ticker/instrument?base=BTC&type=bogus", timeout=60)
rec("api", "/api/ticker/instrument bad type -> 400", st, 400, b)
# The three KEYLESS sidecar families (coinglass / coinank / coinmarketcap) whose web
# half is now wired. Each mode must answer THROUGH the proxy on :3100, and the
# sidecar's own strict-param contract must survive the proxy hop. All three are
# live as of 2026-10-07: the CoinAnk upstream gate that refused all five modes
# with HTTP 502 `403` (DR-038) lifted, so the honest assertion is now a 200.
for m, extra in (("statistics", ""), ("openInterest", "&symbol=BTC"),
                 ("fundingRate", ""), ("markets", "")):
    st, b = hit(f"/api/coinglass?mode={m}{extra}", timeout=120)
    rec("api", f"/api/coinglass mode={m}{extra}", st, 200, b)
for q, label in (("mode=bogus", "coinglass bogus mode -> 400"),
                 ("mode=openInterest", "coinglass openInterest w/o symbol -> 400"),
                 ("mode=statistics&symbol=BTC", "coinglass symbol on statistics -> 400")):
    st, b = hit(f"/api/coinglass?{q}", timeout=120)
    rec("api", label, st, 400, b)
for m in ("fundingRate", "liquidation", "longShort", "etf", "whales"):
    st, b = hit(f"/api/coinank?mode={m}", timeout=120)
    rec("api", f"/api/coinank mode={m}", st, 200, b)
for q, label in (("mode=bogus", "coinank bogus mode -> 400"),
                 ("mode=etf&interval=1h", "coinank interval on etf -> 400"),
                 ("mode=liquidation&interval=8h", "coinank bad interval 8h -> 400")):
    st, b = hit(f"/api/coinank?{q}", timeout=120)
    rec("api", label, st, 400, b)
for m in ("listing", "global", "exchanges"):
    st, b = hit(f"/api/coinmarketcap?mode={m}", timeout=120)
    rec("api", f"/api/coinmarketcap mode={m}", st, 200, b)
st, b = hit("/api/coinmarketcap?mode=marketPairs&slug=bitcoin", timeout=120)
rec("api", "/api/coinmarketcap mode=marketPairs&slug=bitcoin", st, 200, b)
for q, label in (("mode=bogus", "coinmarketcap bogus mode -> 400"),
                 ("mode=listing&limit=0", "coinmarketcap limit=0 (empty-list trap) -> 400"),
                 ("mode=global&limit=5", "coinmarketcap limit on global -> 400")):
    st, b = hit(f"/api/coinmarketcap?{q}", timeout=120)
    rec("api", label, st, 400, b)
for m in ("chains", "protocols", "historical"):
    st, b = hit(f"/api/llama?mode={m}", timeout=120)
    rec("api", f"/api/llama mode={m}", st, 200, b)
st, b = hit("/api/llama?mode=bogus")
rec("api", "llama bogus mode -> 400", st, 400, b)
# The two OUR-params are strict and never clamped (PLAN G9 SG-9.3): the sidecar
# owns them, so the sweep proves the boundary survives the proxy hop.
for q, label in [("mode=protocols&top=0", "llama top=0 -> 400"),
                 ("mode=protocols&top=201", "llama top=201 (over cap) -> 400"),
                 ("mode=protocols&top=abc", "llama top=abc -> 400"),
                 ("mode=historical&days=0", "llama days=0 -> 400"),
                 ("mode=historical&days=99999", "llama days (over cap) -> 400")]:
    st, b = hit(f"/api/llama?{q}", timeout=120)
    rec("api", label, st, 400, b)
dex_types = ["profiles", "boosts", "boosts-top", "search", "tokens",
             "tokens-v1", "token-pairs", "orders"]
for t in dex_types:
    q = "q=solana" if t == "search" else ""
    st, b = hit(f"/api/dex?type={t}{('&' + q) if q else ''}", timeout=60)
    # bare probes w/o required params may legitimately 400/502 from upstream;
    # record actual status, PASS = responded with structured JSON (alive)
    alive = st in (200, 400, 502) and isinstance(b, dict)
    results.append(("PASS" if alive else "FAIL", "api", f"/api/dex type={t}", st,
                    json.dumps(b, default=str)[:90]))
st, b = hit("/api/dex?type=bogus")
rec("api", "dex bogus type -> 400", st, 400, b)

MUT_CASES = [
    ("POST /api/transactions", "POST", "/api/transactions", {}),
    ("DELETE /api/transactions", "DELETE", "/api/transactions", {}),
    ("PUT /api/transactions", "PUT", "/api/transactions", {}),
    ("POST /api/wallets", "POST", "/api/wallets", {}),
    ("PUT /api/transactions/abc", "PUT", "/api/transactions/abc", {"memo": "x"}),
    ("PATCH /api/transactions/999999999", "PATCH", "/api/transactions/999999999", {}),
    ("DELETE /api/transactions/999999999", "DELETE", "/api/transactions/999999999", None),
]
# With a valid admin session each handler runs and refuses on its own contract:
# 6 validation-first 400s + a read-only 404 for the absent row. ZERO writes.
MUT_AUTHED_CASES = [
    ("POST /api/transactions", "POST", "/api/transactions", {}, 400),
    ("DELETE /api/transactions", "DELETE", "/api/transactions", {}, 400),
    ("PUT /api/transactions", "PUT", "/api/transactions", {}, 400),
    ("POST /api/wallets", "POST", "/api/wallets", {}, 400),
    ("PUT /api/transactions/abc", "PUT", "/api/transactions/abc", {"memo": "x"}, 400),
    ("PATCH /api/transactions/999999999", "PATCH", "/api/transactions/999999999",
     {"__probe__": True}, 400),
    ("DELETE /api/transactions/999999999", "DELETE", "/api/transactions/999999999",
     None, 404),
]
print("=== D1. mutations WITHOUT session -> 401 fail-closed ===", flush=True)
for name, m, p, body in MUT_CASES:
    st, b = hit(p, method=m, body=body)
    rec("mut-auth", f"{name} no-cookie -> 401", st, 401, b)

print("=== D2. mutations WITH a signed admin session ===", flush=True)
if SESSION_OK:
    for name, m, p, body, want in MUT_AUTHED_CASES:
        st, b = hit(p, method=m, body=body, cookie=SESSION)
        rec("mut", f"{name} admin-cookie -> {want}", st, want, b)
    for p in ["/member", "/team/balance", "/admin"]:
        st, b = hit(p, timeout=60, cookie=SESSION)
        rec("gate-auth", f"{p} admin-cookie -> 200", st, 200, b)
    # The gated READ the /team/plans board depends on: a session must open it,
    # and it must answer its own shape (a `plans` list + an integer `total`) --
    # not merely a 200 with an envelope that could be anything.
    st, b = hit("/api/plans", cookie=SESSION)
    ok_shape = False
    n = 0
    if isinstance(b, dict):
        plans_list = b.get("plans")
        if isinstance(plans_list, list) and isinstance(b.get("total"), int):
            ok_shape = True
            n = len(plans_list)
    rec("api-auth", f"/api/plans admin-cookie -> 200 + plans/total ({n} plans)", st if (st == 200 and ok_shape) else 0, 200, b)
    # The fifth mode of the treasury read layer (DR-053). A session must open it,
    # and the SPLIT MUST CLOSE: `residualUsd` is the panel's own check figure
    # (move - market - book), so a 200 carrying a non-zero residual is a
    # decomposition that does not explain the move it claims to -- a defect no
    # status code can see. A dimension the parser rejects must be a 400, not a
    # silent fallback to a dimension the caller did not ask for.
    st, b = hit("/api/treasury?mode=attribution&dimension=asset&range=7d", cookie=SESSION)
    ok_pairs = ok_resid = False
    n_pairs = 0
    resid = None
    if isinstance(b, dict):
        rows, pairs, resid = b.get("rows"), b.get("pairs"), b.get("residualUsd")
        n_pairs = len(pairs) if isinstance(pairs, list) else 0
        ok_pairs = isinstance(rows, list) and isinstance(pairs, list)
        ok_resid = isinstance(resid, (int, float)) and abs(resid) < 1e-6
    rec("api-auth", f"/api/treasury?mode=attribution -> 200 + split closes ({n_pairs} pairs, residual {resid})",
        st if (st == 200 and ok_pairs and ok_resid) else 0, 200, b)
    st, b = hit("/api/treasury?mode=attribution&dimension=total&range=7d", cookie=SESSION)
    rec("api-auth", "/api/treasury?mode=attribution&dimension=total -> 400 (not a dimension)", st, 400, b)
else:
    # ENVIRONMENTAL: this audit target cannot authenticate anyone, so the
    # session-gated path is unexercised rather than broken.
    for name, m, p, body, want in MUT_AUTHED_CASES:
        rec("mut-env", f"{name} admin-cookie -> {want} [ENV: {SESSION_WHY}]", 0, want, {})
    for p in ["/member", "/team/balance", "/admin"]:
        rec("gate-auth-env", f"{p} admin-cookie -> 200 [ENV: {SESSION_WHY}]", 0, 200, {})
    rec("api-auth-env", f"/api/plans admin-cookie -> 200 + plans/total [ENV: {SESSION_WHY}]", 0, 200, {})
    rec("api-auth-env", f"/api/treasury?mode=attribution -> 200 + split closes [ENV: {SESSION_WHY}]", 0, 200, {})
    rec("api-auth-env", f"/api/treasury?mode=attribution&dimension=total -> 400 [ENV: {SESSION_WHY}]", 0, 400, {})

print("=== E. cryptorank: 28 modes + contract ===", flush=True)
CR = [
    # (query, expected status)
    ("mode=home", 200), ("mode=coins", 200), ("mode=trending", 200),
    ("mode=gainers", 200), ("mode=losers", 200),
    ("mode=funding", 503), ("mode=unlocks", 503),
    ("mode=categories", 200), ("mode=categories&key=chain", 200),
    ("mode=exchanges", 200), ("mode=exchanges&key=cex%2Fspot", 200),
    ("mode=exchanges&key=dex%2Fspot", 200), ("mode=exchanges&key=perpetuals", 200),
    ("mode=exchanges&key=cex-transparency", 200),
    ("mode=exchanges&key=bogus", 400),
    ("mode=coin", 200), ("mode=coin&key=ethereum", 200),
    ("mode=coin&key=zzznoexist9999", 404),
    ("mode=listings", 200),
    ("mode=blockchains", 200), ("mode=chain", 200),
    ("mode=chain&key=solana", 200), ("mode=chain&key=zzznoexist9999", 404),
    ("mode=launchpool&key=past", 200), ("mode=launchpool&key=active", 200),
    ("mode=launchpool&key=upcoming", 200), ("mode=launchpool&key=bogus", 400),
    ("mode=nodesale&key=past", 200), ("mode=nodesale&key=active", 200),
    ("mode=nodesale&key=upcoming", 200), ("mode=nodesale&key=bogus", 400),
    ("mode=news", 200),
    ("mode=tags", 200), ("mode=tag", 200), ("mode=tag&key=layer-1", 200),
    ("mode=tag&key=zzznoexist9999", 404),
    ("mode=ecosystems", 200), ("mode=ecosystem", 200),
    ("mode=ecosystem&key=solana", 200), ("mode=ecosystem&key=zzznoexist9999", 404),
    ("mode=rwa", 200), ("mode=rwaasset", 200),
    ("mode=rwaasset&key=commodities%2Fgold", 200),
    ("mode=rwaasset&key=bad%2Fxx", 400),
    ("mode=rwaasset&key=stocks%2Fzzznoexist9999", 404),
    ("mode=quarterly", 200), ("mode=prediction", 200),
    ("mode=converter", 200), ("mode=media", 200),
    ("mode=newstag", 200), ("mode=newstag&key=defi", 200),
    ("mode=newstag&key=zzznoexist9999", 404), ("mode=newstag&key=BAD%20KEY", 400),
    ("mode=aioverview", 200),
    ("mode=bogus", 400), ("mode=", 400),
    ("mode=categories&key=BAD%20KEY", 400),
    ("mode=rwa&key=anything", 200),  # rwa unkeyed: key ignored? record actual
]
for q, want in CR:
    st, b = hit(f"/api/cryptorank?{q}", timeout=120)
    rec("cr", f"/api/cryptorank?{q}", st, want, b)

# ---- report
fails = [r for r in results if r[0] == "FAIL"]
print(f"\n=== RESULT: {len(results) - len(fails)}/{len(results)} PASS, {len(fails)} FAIL ===")
for v, g, n, st, det in results:
    if v == "FAIL":
        print(f"  FAIL [{g}] {n} -> {st} {det}")
print("by group:", dict(Counter(g for v, g, *_ in results if v == "PASS")), "(pass counts)")
print("statuses:", dict(Counter(str(st) for _, _, _, st, _ in results)))
sys.exit(1 if fails else 0)

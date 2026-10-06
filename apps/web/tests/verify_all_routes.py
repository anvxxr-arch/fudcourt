"""Verify EVERY route/endpoint of fudcourt web (live, zero side effects).

Re-aligned 2026-09-29 to the repurpose pass (commit 5e68576 "re-align every
surface"), read out of the running build, not from memory:

- Pages: live HTML -> 200. The market hub absorbed the standalone boards, so
  `/ticker`, `/tracker`, `/llama`, `/markets`, `/market/ticker`, `/dex`,
  `/trench`, `/ticker/:ticker` are deliberate 307s into the hub (next.config.js,
  ARCHITECTURE.md §3) and are asserted as such. `/coin` and `/balance` were
  removed and must answer a REAL 404, and an off-allowlist ticker
  (`/market/ticker/FOO`) must be a real 404 too, never a soft-404 that renders a
  200 shell.
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
          "/market/stock", "/market/commodity", "/market/ticker/BTC",
          "/news", "/scoreboard", "/signals"]:
    st, b = hit(p, timeout=60)
    rec("page", p, st, 200, b)
# The market hub absorbed the standalone boards: their old paths are deliberate
# 307s into the hub (next.config.js, documented in ARCHITECTURE.md §3). Assert
# the redirect status so a dropped or renamed redirect is caught, not 404'd.
for src in ["/ticker", "/tracker", "/llama", "/markets", "/market/ticker",
            "/dex", "/trench", "/ticker/BTC", "/ticker/ETH"]:
    st, b = hit(src, timeout=60)
    rec("page", f"{src} -> 307 into the hub", st, 307, b)
# Real 404s: two removed routes, and an off-allowlist ticker -- the old path
# 307s into the hub, whose detail route then answers the real 404 (never a
# soft-404 that renders a 200 shell).
for p, why in [("/coin", "route removed"), ("/balance", "route removed"),
               ("/market/ticker/FOO", "off the ticker allowlist")]:
    st, b = hit(p, timeout=60)
    rec("page", f"{p} -> 404 (real 404, {why})", st, 404, b)
for p in ["/robots.txt", "/sitemap.xml"]:
    st, b = hit(p, timeout=60)
    rec("page", p, st, 200, b)

print("=== B. anonymous gates ===", flush=True)
for p in ["/team/balance", "/team/portfolio", "/team/wallets", "/team/transactions",
          "/team/reconciliation", "/member", "/admin"]:
    st, b = hit(p, timeout=60)
    rec("gate", f"{p} anon -> 307 login", st, 307, b)

print("=== C. API GET endpoints ===", flush=True)
# treasury reads are session-gated: no cookie -> JSON 401 (never HTML)
for p, name in [("/api/all", "/api/all anon -> 401"),
                ("/api/coins", "/api/coins anon -> 401"),
                ("/api/wallets", "/api/wallets (list) anon -> 401"),
                ("/api/reconcile", "/api/reconcile anon -> 401"),
                ("/api/transactions?limit=5", "/api/transactions?limit=5 anon -> 401"),
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
# sidecar's own strict-param contract must survive the proxy hop. coinglass and
# coinmarketcap are live; coinank is DARK -- upstream refuses all five, so the honest
# assertion is the 502 carrying its own code, never a 200 (DR-038).
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
    rec("api", f"/api/coinank mode={m} (dark upstream refusal)", st, 502, b)
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
else:
    # ENVIRONMENTAL: this audit target cannot authenticate anyone, so the
    # session-gated path is unexercised rather than broken.
    for name, m, p, body, want in MUT_AUTHED_CASES:
        rec("mut-env", f"{name} admin-cookie -> {want} [ENV: {SESSION_WHY}]", 0, want, {})
    for p in ["/member", "/team/balance", "/admin"]:
        rec("gate-auth-env", f"{p} admin-cookie -> 200 [ENV: {SESSION_WHY}]", 0, 200, {})

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

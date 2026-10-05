#!/usr/bin/env python3
"""verifylib -- shared helpers for the scripts/verify harnesses.

Every body here was lifted VERBATIM out of the twelve verify-*.py harnesses
(byte-identical across files) so that a fix to a shared contract lives in one
place. What each helper prints, returns, and mutates is unchanged; only the
names moved and the counters/results lists are now reached through the CALLER's
module globals instead of being closed over.

Two behaviours are load-bearing and easy to break:

* The counted VERDICT helpers (check_counted / skip / info) read and write the
  caller's module globals -- PASS, FAIL, SKIP, NOTES, RESULTS -- via
  sys._getframe(1).  A harness aliases them into its own namespace
  (`from verifylib import check_counted as check`), so a whole file of handlers
  keeps updating its own counters with no wrapper and no extra indirection.

* The tuple-style CHECK helpers append to the caller's `results` list when one
  exists.  verify-sync.py never declared that list, so its `check` only prints;
  chainrank / dex / llama / markets / news / reconcile / signals record.

`call` has three shapes because three call patterns were frozen in the
harnesses and must not be merged: the chainrank form sends a method/payload,
the llama/markets/news form is a plain timeout-get that swallows transport
errors, and the reconcile form lets transport errors propagate.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
DIM = "\033[2m"
RESET = "\033[0m"


# ------------------------------------------------------------------ verdicts
def check_counted(name, ok, detail="", *, coerce_bool=True):
    """`[PASS|FAIL] name -- detail`; bump the caller's PASS/FAIL and RESULTS.

    coinank / coinmarketcap / khala / cryptorank all spell this the same way.
    coerce_bool=False is cryptorank's variant, which stores and returns `ok`
    itself rather than bool(ok).
    """
    g = sys._getframe(1).f_globals
    tag = "PASS" if ok else "FAIL"
    print(f"[{tag}] {name}" + (f" -- {detail}" if detail else ""))
    g["RESULTS"].append({"name": name, "ok": bool(ok) if coerce_bool else ok, "detail": detail})
    if ok:
        g["PASS"] += 1
    else:
        g["FAIL"] += 1
    return bool(ok) if coerce_bool else ok


def check_tuple(ok, label, detail=""):
    """`  [PASS|FAIL] label  detail`; record into the caller's `results`."""
    results = sys._getframe(1).f_globals.get("results")
    if results is not None:
        results.append((ok, label, detail))
    print(f"  [{GREEN + 'PASS' + RESET if ok else RED + 'FAIL' + RESET}] {label}"
          + (f"  {DIM}{detail}{RESET}" if detail else ""))
    return ok


def check_mark(ok, label, detail=""):
    """check_tuple's verdict, built through an intermediate `mark` (signals)."""
    results = sys._getframe(1).f_globals.get("results")
    if results is not None:
        results.append((ok, label, detail))
    mark = f"{GREEN}PASS{RESET}" if ok else f"{RED}FAIL{RESET}"
    print(f"  [{mark}] {label}" + (f"  {DIM}{detail}{RESET}" if detail else ""))
    return ok


def check_bare(ok, label, detail=""):
    """check_tuple without a results list at all (verify-sync.py)."""
    print(f"  [{GREEN + 'PASS' + RESET if ok else RED + 'FAIL' + RESET}] {label}"
          + (f"  {DIM}{detail}{RESET}" if detail else ""))
    return ok


def skip(name, detail):
    """`[SKIP] name -- detail`; bump the caller's SKIP and RESULTS."""
    g = sys._getframe(1).f_globals
    print(f"[SKIP] {name} -- {detail}")
    g["RESULTS"].append({"name": name, "ok": None, "detail": detail})
    g["SKIP"] += 1


def info(name, detail):
    """`[INFO] name -- detail`; record into the caller's RESULTS and NOTES."""
    g = sys._getframe(1).f_globals
    print(f"[INFO] {name} -- {detail}")
    g["RESULTS"].append({"name": name, "ok": None, "detail": detail})
    g["NOTES"].append(f"{name}: {detail}")


# --------------------------------------------------------------------- notes
def note_msg(msg):
    """Print-only note (`--- msg`), used by cryptorank and khala."""
    print(f"--- {msg}")


def note_join(*parts, maxlen=160):
    """Join truthy fragments and clip to `maxlen` (harnesses pin 150/160/200)."""
    return " ".join(str(p) for p in parts if p)[:maxlen]


# ------------------------------------------------------------------ narrowing
def as_dict(v):
    return v if isinstance(v, dict) else {}


def as_list(v):
    return v if isinstance(v, list) else []


def as_str(v):
    return v if isinstance(v, str) else ""


def as_dict_loud(body):
    """Narrow a body to a dict, or carry the reason under `__unexpected__`."""
    if isinstance(body, dict):
        return body
    return {"__unexpected__": (body if isinstance(body, str) else type(body).__name__)[:120]}


# -------------------------------------------------------------------- headers
def hget(hdr, name):
    """Case-insensitive header lookup that returns None when absent."""
    for k, v in hdr.items():
        if k.lower() == name.lower():
            return v
    return None


def hdr(headers, name):
    """Case-insensitive header lookup that returns "-" when absent."""
    lname = name.lower()
    for k, v in headers.items():
        if k.lower() == lname:
            return v
    return "-"


# -------------------------------------------------------------------- sections
def section(title):
    print(f"\n▸ {title}")


def section_yellow(title):
    print(f"\n{YELLOW}▸ {title}{RESET}")


# ------------------------------------------------------------------ transport
def call(url, method="GET", payload=None, ctype="application/json", timeout=45):
    """(status, headers, body-bytes). An HTTPError IS a response -- read its body."""
    req = urllib.request.Request(url, data=payload, method=method, headers={
        "User-Agent": "fudcourt-verify/1.0", "Accept": "application/json",
        **({"Content-Type": ctype} if payload is not None else {}),
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        try:
            body = e.read()
        except Exception:
            body = b""
        return e.code, dict(e.headers), body
    except Exception as e:
        return 0, {}, f"{type(e).__name__}: {e}".encode()


def call_get(url, timeout=60):
    """(status, headers, body-bytes). HTTPError IS a response -- read its body."""
    req = urllib.request.Request(url, headers={"User-Agent": "fudcourt-verify/1.0",
                                               "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        try:
            body = e.read()
        except Exception:
            body = b""
        return e.code, dict(e.headers), body
    except Exception as e:
        return 0, {}, f"{type(e).__name__}: {e}".encode()


def call_plain(url, method="GET", timeout=60):
    """(status, headers, body-bytes). An HTTPError IS a response -- read its body."""
    req = urllib.request.Request(url, method=method, headers={
        "User-Agent": "fudcourt-verify-reconcile/1.0", "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def jload(body):
    try:
        return json.loads(body)
    except Exception:
        return None

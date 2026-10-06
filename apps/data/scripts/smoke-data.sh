#!/usr/bin/env bash
# Live smoke test for fudcourt-data: starts the real server and drives it over HTTP.
#
#   cd apps/data && ./scripts/smoke-data.sh
#
# It uses its own port and its own cache dir, so it never disturbs a running
# fudcourt-data unit (which owns 127.0.0.1:3101 and ~/.cache/fudcourt-data).
# Total live upstream requests: 4, spaced 2s (it is someone else's site).
set -uo pipefail

PORT="${PORT:-32101}"
CACHE="$(mktemp -d)"
LOG="$(mktemp)"
BASE="http://127.0.0.1:${PORT}"
cd "$(dirname "$0")/.."

cleanup() {
  [[ -n "${PID:-}" ]] && kill "$PID" 2>/dev/null
  rm -rf "$CACHE" "$LOG"
}
trap cleanup EXIT

echo "building..."
go build -o /tmp/fudcourt-data-smoke . || exit 1

FUDCOURT_DATA_ADDR="127.0.0.1:${PORT}" FUDCOURT_DATA_CACHE_DIR="$CACHE" /tmp/fudcourt-data-smoke >"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 50); do
  curl -sf "${BASE}/healthz" >/dev/null 2>&1 && break
  sleep 0.1
done

fail=0
check() { # label expected_status url [extra_jq]
  local label="$1" want="$2" url="$3"
  sleep 2 # be polite: every check below is (mostly) a fresh upstream fetch
  local body status
  body="$(curl -s -w '\n%{http_code}' "${url}")"
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"
  local count bytes
  count="$(printf '%s' "$body" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("count","-"))' 2>/dev/null || echo '?')"
  bytes="$(printf '%s' "$body" | wc -c)"
  printf '%-42s status=%-3s bytes=%-7s count=%s\n' "$label" "$status" "$bytes" "$count"
  if [[ "$status" != "$want" ]]; then
    printf '  FAIL want %s\n  body: %s\n' "$want" "${body:0:300}"
    fail=1
  fi
}

echo
echo "=== live checks (real upstream) ==="
check "mode=home"                       200 "${BASE}/api/cryptorank?mode=home&fresh=1"
check "mode=coins"                      200 "${BASE}/api/cryptorank?mode=coins&fresh=1"
check "mode=coin&key=bitcoin"           200 "${BASE}/api/cryptorank?mode=coin&key=bitcoin&fresh=1"

echo
echo "=== refusals (no upstream traffic) ==="
check "mode=funding (503, refused)"     503 "${BASE}/api/cryptorank?mode=funding"
check "mode=unlocks (503, refused)"     503 "${BASE}/api/cryptorank?mode=unlocks"
check "mode=hack (400, unknown)"        400 "${BASE}/api/cryptorank?mode=hack"
check "mode=coin&key=!!! (400, bad key)" 400 "${BASE}/api/cryptorank?mode=coin&key=%21%21%21"
check "mode=coin&key=zzznoexist9999"    404 "${BASE}/api/cryptorank?mode=coin&key=zzznoexist9999"
# upstream answers 307 -> 200 with tag:null, so this must be the LOCAL soft-404
# (a client that does not follow redirects reports 502 upstream 307 instead).
check "mode=newstag&key=zzznope"        404 "${BASE}/api/cryptorank?mode=newstag&key=zzznope"

echo
echo "=== verbatim reasons ==="
curl -s "${BASE}/api/cryptorank?mode=funding" | python3 -c 'import json,sys;print(json.load(sys.stdin)["error"])'
curl -s "${BASE}/api/cryptorank?mode=hack" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("modes:",len(d["modes"]),"got:",d["got"])'
curl -s "${BASE}/api/cryptorank?mode=coin&key=%21%21%21" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("detail:",d["detail"])'
curl -s "${BASE}/api/cryptorank?mode=coin&key=zzznoexist9999" | python3 -c 'import json,sys;print(json.load(sys.stdin))'
curl -s "${BASE}/api/cryptorank?mode=newstag&key=zzznope" | python3 -c 'import json,sys;print(json.load(sys.stdin))'

echo
echo "=== headers (mode=home) ==="
sleep 2
curl -sS -D - -o /dev/null "${BASE}/api/cryptorank?mode=home&fresh=1" \
  | grep -iE '^(HTTP/|x-cr-|cache-control|content-type)'

echo
if [[ "$fail" == 0 ]]; then echo "SMOKE: PASS"; else echo "SMOKE: FAIL"; fi
exit "$fail"

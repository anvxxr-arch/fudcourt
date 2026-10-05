#!/bin/bash
# fudcourt one-command OFFLINE verification — every fast gate the repo has, in one
# place, so "is the tree green?" is one command instead of a dozen (Phase 8/9 infra).
#
#   bash scripts/verify/verify-all.sh        # from anywhere in the repo
#
# Covers: structure gate (DR-018), web contract gate, deploy-unit guard,
# shared/contracts drift gate, the three
# Go modules (build/vet/test), the Rust crate (build/test), the sync oracle gate
# (Python vs Rust byte-identical replay, tests/oracle/fixtures — offline), the
# cross-service API conformance check, the hook syntax check, and frontend/web
# typecheck + shaper fixture tests.
#
# DELIBERATELY NOT HERE: live/network harnesses (scripts/verify/verify-*.py,
# FUDCOURT_DATA_LIVE=1 Go tests, real exchange calls) — they are slow and touch upstreams;
# run them manually against a known-good window.
set -u
# Resolve the repo's toolchain regardless of the caller's PATH: a non-login
# shell (CI steps, a bare `bash scripts/...`, a git-invoked hook) does not have
# ~/.bun/bin or ~/.cargo/bin, so the web and rust gates report "command not
# found" — a red gate that is really an environment gap. CI installs both
# globally, so this is a harmless prepend there.
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")/../.."
rc=0
step() { echo; echo "== $1"; }
fail() { echo "!! FAILED: $1"; rc=1; }

# A step whose output is suppressed must still explain itself when it goes red.
# The 2026-10-02 web failure logged only `error: script "test:shapers" exited
# with code 1`: the step redirected to /dev/null, so the compiler/test
# diagnostics naming the real problem were discarded and the red gate could not
# be diagnosed from the log. Capture instead of discard — silent on success (the
# step's own OK line is the signal), print the tail on failure.
quiet_step() {
  local name="$1"; shift
  local log; log=$(mktemp)
  if "$@" >"$log" 2>&1; then
    rm -f "$log"; return 0
  fi
  echo "!! $name output (last 40 lines):"
  tail -40 "$log"
  rm -f "$log"
  return 1
}

step "structure gate (DR-018 layers)"
(cd frontend/web && python3 scripts/checks/check-structure.py) || fail structure
# The design system: one SSOT (src/styles/tokens.ts) + generated artifacts + these two gates
# (DR-037). The first step is the MIGRATION gate and is deliberately red until the feature/
# component workers land — a green run before then would mean the gate was broken, not that the
# tree was clean. The second is the generated-artifact drift alarm and is green from day one.
step "design-token gate (raw literals, magic style values, dead tokens)"
(cd frontend/web && python3 scripts/checks/check-design-tokens.py) || fail design-tokens
step "design-token artifact drift (globals.css block + tailwind.tokens.json are generated)"
(cd frontend/web && unset NODE_ENV && bun scripts/design/emit-tokens.ts --check) || fail design-tokens-artifacts

step "web contract gate (CR_MODES + mutation-auth guards)"
python3 scripts/verify/check-contract.py || fail web-contract

step "shared/contracts drift gate"
node shared/contracts/scripts/check-contract.mjs || fail contracts

step "shared/contracts canonical-schema gate (parse, dialect, refs, README index, structure)"
node shared/contracts/scripts/check-schemas.mjs || fail schemas

step "canonical doc-citation gate (cited repo paths resolve)"
node shared/contracts/scripts/check-doc-citations.mjs || fail doc-citations
step "markdown table-shape gate (a row must not exceed its header; GFM drops excess cells)"
node shared/contracts/scripts/check-table-shape.mjs || fail table-shape

step "canonical reference artifact drift (reference.json is generated)"
go run ./backend/api/internal/markets/reference/cmd/emit -check || fail reference

step "go build/vet/test (backend/api)"
go build ./backend/api/... && go vet ./backend/api/... && go test ./backend/api/... || fail go-api

step "go build/vet/test (backend/workers/executor)"
go build ./backend/workers/executor/... && go vet ./backend/workers/executor/... && go test ./backend/workers/executor/... || fail go-executor

step "go build/vet/test (backend/data)"
go build ./backend/data/... && go vet ./backend/data/... && go test ./backend/data/... || fail go-data

step "cargo build/test (backend/sync)"
(cd backend/sync && cargo fmt --check && cargo build --release --quiet && cargo test --release --quiet) || fail rust

# Ordered AFTER the cargo build on purpose: check-deploy requires every ExecStart target to
# exist, and the two Rust units (fudcourt-sync-rust / fudcourt-reconciled) are NOT
# self-provisioning the way the Go units are (they carry no ExecStartPre=go build), so
# backend/sync/target/release/* must already be built — running this before the cargo step
# is red on a clean checkout.
step "deploy-unit guard (ExecStart paths, timer pairs)"
python3 scripts/verify/check-deploy.py || fail deploy

step "sync oracle gate (Python oracle vs Rust replay, byte-identical projection)"
quiet_step sync-oracle python3 scripts/verify/verify-sync.py || fail sync-oracle
step "cross-service API conformance (Go api routes <-> contract <-> web proxies)"
python3 tests/integration/api/check-api-contract.py || fail api-contract
step "pre-push hook syntax"
bash -n scripts/githooks/pre-push || fail hook-syntax

step "frontend/web typecheck + shaper fixture tests"
quiet_step web bash -c 'cd frontend/web && unset NODE_ENV && bunx tsc --noEmit && bun run test:shapers' || fail web

echo
if [ "$rc" -eq 0 ]; then echo "VERIFY_ALL_OK"; else echo "VERIFY_ALL_FAILED (see !! FAILED above)"; fi
exit "$rc"

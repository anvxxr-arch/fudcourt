#!/bin/bash
# fudcourt one-command OFFLINE verification — every fast gate the repo has, in one
# place, so "is the tree green?" is one command instead of a dozen (Phase 8/9 infra).
#
#   bash scripts/verify/verify-all.sh        # from anywhere in the repo
#
# Covers: structure gate (DR-018), web contract gate, deploy-unit guard,
# shared/contracts drift gate + generated-SDK drift + sdk typecheck, the three
# Go modules (build/vet/test), the Rust crate (build/test), the sync oracle gate
# (Python vs Rust byte-identical replay, tests/oracle/fixtures — offline), the
# cross-service API conformance check, the hook syntax check, and frontend/web
# typecheck + shaper fixture tests.
#
# DELIBERATELY NOT HERE: live/network harnesses (scripts/verify/verify-*.py,
# FUDCOURT_DATA_LIVE=1 Go tests, real exchange calls) — they are slow and touch upstreams;
# run them manually against a known-good window.
set -u
cd "$(dirname "$0")/../.."
rc=0
step() { echo; echo "== $1"; }
fail() { echo "!! FAILED: $1"; rc=1; }

step "structure gate (DR-018 layers)"
(cd frontend/web && python3 scripts/checks/check-structure.py) || fail structure

step "web contract gate (CR_MODES + mutation-auth guards)"
(cd frontend/web && python3 scripts/checks/check-contract.py) || fail web-contract

step "shared/contracts drift gate"
node shared/contracts/scripts/check-contract.mjs || fail contracts

step "shared/contracts canonical-schema gate (parse, dialect, refs, README index, structure)"
node shared/contracts/scripts/check-schemas.mjs || fail schemas

step "canonical reference artifact drift (reference.json is generated)"
go run ./backend/api/internal/markets/reference/cmd/emit -check || fail reference
step "sdk-ts generated-SDK drift + typecheck"
(cd shared/sdk/typescript \
  && tmp=$(mktemp -d) && cp -r src/generated "$tmp/generated" \
  && bun run generate >/dev/null && diff -r "$tmp/generated" src/generated \
  && bun run typecheck >/dev/null) || fail sdk-ts

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
(cd frontend/web && python3 scripts/checks/check-deploy.py) || fail deploy

step "sync oracle gate (Python oracle vs Rust replay, byte-identical projection)"
python3 scripts/verify/verify-sync.py >/dev/null || fail sync-oracle
step "cross-service API conformance (Go api routes <-> contract <-> web proxies)"
python3 tests/integration/api/check-api-contract.py || fail api-contract
step "pre-push hook syntax"
bash -n scripts/githooks/pre-push || fail hook-syntax

step "frontend/web typecheck + shaper fixture tests"
(cd frontend/web && unset NODE_ENV && bunx tsc --noEmit && bun run test:shapers >/dev/null) || fail web

echo
if [ "$rc" -eq 0 ]; then echo "VERIFY_ALL_OK"; else echo "VERIFY_ALL_FAILED (see !! FAILED above)"; fi
exit "$rc"

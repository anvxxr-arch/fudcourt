#!/bin/bash
# fudcourt one-command OFFLINE verification — every fast gate the repo has, in one
# place, so "is the tree green?" is one command instead of a dozen (Phase 8/9 infra).
#
#   bash scripts/verify/verify-all.sh        # from anywhere in the repo
#
# Covers: structure gate (DR-018), web contract gate, deploy-unit guard,
# packages/contracts drift gate + generated-SDK drift + sdk typecheck, the three
# Go modules (build/vet/test), the Rust crate (build/test), the sync oracle gate
# (Python vs Rust byte-identical replay, tests/oracle/fixtures — offline), the
# cross-service API conformance check, the hook syntax check, and apps/web
# typecheck + shaper fixture tests.
#
# DELIBERATELY NOT HERE: live/network harnesses (apps/web/scripts/verify/verify-*.py,
# APICALLS_LIVE=1 Go tests, real exchange calls) — they are slow and touch upstreams;
# run them manually against a known-good window.
set -u
cd "$(dirname "$0")/../.."
rc=0
step() { echo; echo "== $1"; }
fail() { echo "!! FAILED: $1"; rc=1; }

step "structure gate (DR-018 layers)"
(cd apps/web && python3 scripts/checks/check-structure.py) || fail structure

step "web contract gate (CR_MODES + mutation-auth guards)"
(cd apps/web && python3 scripts/checks/check-contract.py) || fail web-contract

step "deploy-unit guard (ExecStart paths, timer pairs)"
(cd apps/web && python3 scripts/checks/check-deploy.py) || fail deploy

step "packages/contracts drift gate"
node packages/contracts/scripts/check-contract.mjs || fail contracts

step "sdk-ts generated-SDK drift + typecheck"
(cd packages/sdk-ts \
  && tmp=$(mktemp -d) && cp -r src/generated "$tmp/generated" \
  && bun run generate >/dev/null && diff -r "$tmp/generated" src/generated \
  && bun run typecheck >/dev/null) || fail sdk-ts

step "go build/vet/test (services/api)"
go build ./services/api/... && go vet ./services/api/... && go test ./services/api/... || fail go-api

step "go build/vet/test (services/executor)"
go build ./services/executor/... && go vet ./services/executor/... && go test ./services/executor/... || fail go-executor

step "go build/vet/test (services/data)"
go build ./services/data/... && go vet ./services/data/... && go test ./services/data/... || fail go-data

step "cargo build/test (services/sync)"
(cd services/sync && cargo build --release --quiet && cargo test --release --quiet) || fail rust

step "sync oracle gate (Python oracle vs Rust replay, byte-identical projection)"
python3 apps/web/scripts/verify/verify-sync.py >/dev/null || fail sync-oracle
step "cross-service API conformance (Go api routes <-> contract <-> web proxies)"
python3 tests/integration/api/check-api-contract.py || fail api-contract
step "pre-push hook syntax"
bash -n scripts/githooks/pre-push || fail hook-syntax

step "apps/web typecheck + shaper fixture tests"
(cd apps/web && unset NODE_ENV && bunx tsc --noEmit && bun run test:shapers >/dev/null) || fail web

echo
if [ "$rc" -eq 0 ]; then echo "VERIFY_ALL_OK"; else echo "VERIFY_ALL_FAILED (see !! FAILED above)"; fi
exit "$rc"

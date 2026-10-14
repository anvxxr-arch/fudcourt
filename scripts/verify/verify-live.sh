#!/bin/bash
# The DATABASE-backed Rust suites, run by hand and on purpose.
#
# WHY THIS IS NOT IN verify-all.sh: that gate is OFFLINE by contract and says so in its own
# header — these suites need a database and they DELETE rows.
#
# WHY NOT PLAIN `cargo test`: every one of them shares global state. `store::due` scans EVERY
# definition (so a row another session wrote makes this suite's counters move) and the feeds
# suite shares one feed space (so two tests delete each other's source). Cargo runs the tests
# of a binary in parallel threads, which turns that sharing into failures that look like code
# bugs: half the suite red in ~0.3s, then green when run alone. The `--test-threads=1` below
# is the entire reason this script exists.
#
#   set -a; . ./.env; set +a
#   bash scripts/verify/verify-live.sh
#
# Against the TEST database, never production: fudcourt_test is created from
# db/schema/pg-schema.sql (see the fudcourt-development skill) and the DSN guard below refuses
# anything that does not name it.
set -u
export PATH="$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")/../.."
rc=0

if [ -z "${FUDCOURT_TEST_PG_URL:-}" ]; then
  echo "FUDCOURT_TEST_PG_URL is not set. Source the env file first:"
  echo "  set -a; . ./.env; set +a"
  exit 2
fi

# The check is on the DATABASE NAME in the DSN, because the wrong value here is one segment
# away from the right one and the cost of getting it wrong is the live rows. Never print the
# DSN itself: it carries a password (it would land in the terminal and in any transcript).
db="${FUDCOURT_TEST_PG_URL%%\?*}"
db="${db##*/}"
if [ "$db" = "fudcourt" ]; then
  echo "refusing: the DSN names the PRODUCTION database. Use fudcourt_test."
  exit 2
fi
case "$db" in
  *_test) : ;;
  *)
    echo "refusing: the DSN's database name does not end in _test, and these suites delete rows."
    exit 2
    ;;
esac

for t in feeds_live jobs_live scheduler_live; do
  echo
  echo "== $t"
  (cd apps/discord-worker && cargo test --release --offline --test "$t" -- --test-threads=1) || rc=1
done

echo
if [ "$rc" -eq 0 ]; then
  echo "LIVE_SUITES_OK"
else
  echo "LIVE_SUITES_FAILED"
fi
exit "$rc"

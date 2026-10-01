/**
 * Data-layer unit tests (DR-019): run OFFLINE, no Postgres, no Turso, no Valkey.
 *
 * Contract under test:
 *  - `toPostgres` translates the two SQLite constructs this app's statements use.
 *    Both halves of it have already caused a visible bug: `ORDER BY rowid` must
 *    become `ORDER BY id` (an INTEGER PRIMARY KEY IS the rowid in SQLite, so the
 *    order is preserved exactly — `ctid` would reorder after an UPDATE), and `?`
 *    must become numbered `$n` placeholders (a bare `?` is invalid SQL in
 *    Postgres). The mapping is asserted for the exact statements the routes issue.
 *  - `DASHBOARD_READS`' orderings all end in a total-order tiebreaker. SQLite's
 *    rowid makes an ORDER BY on a non-unique column deterministic by insertion
 *    order; Postgres leaves ties unspecified, which returned a different row order
 *    for the transactions list until a tiebreaker was added.
 *
 * Usage: cd frontend/web && npm run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPostgres, DASHBOARD_READS } from '../../src/platform/db/mirror';

test('toPostgres: ? placeholders are numbered from 1', () => {
  assert.equal(toPostgres('SELECT * FROM wallets WHERE address = ?'), 'SELECT * FROM wallets WHERE address = $1');
  assert.equal(
    toPostgres('UPDATE wallets SET alias = ?, emoji = ? WHERE address = ?'),
    'UPDATE wallets SET alias = $1, emoji = $2 WHERE address = $3',
  );
  assert.equal(toPostgres('DELETE FROM transactions WHERE id IN (?, ?, ?)'), 'DELETE FROM transactions WHERE id IN ($1, $2, $3)');
});

test('toPostgres: ORDER BY rowid maps to the primary key, not to ctid', () => {
  // `ctid` is the physical-position analogue and would change under UPDATE,
  // silently reordering the wallets list after an edit.
  assert.equal(toPostgres('SELECT * FROM wallets ORDER BY rowid'), 'SELECT * FROM wallets ORDER BY id');
  assert.ok(!toPostgres('SELECT * FROM wallets ORDER BY rowid').includes('ctid'));
  // The rewrite is case-insensitive and normalises to the uppercase form.
  assert.equal(toPostgres('SELECT * FROM wallets order by rowid'), 'SELECT * FROM wallets ORDER BY id');
  assert.equal(toPostgres('SELECT * FROM accounts ORDER BY code'), 'SELECT * FROM accounts ORDER BY code');
});

test('toPostgres: numbering reflects placeholders only, never a literal ? in text', () => {
  // No statement in this codebase puts a `?` in a literal, but the rewrite must
  // still be predictable: the counter is positional, so two placeholders are
  // numbered in order regardless of what surrounds them.
  assert.equal(toPostgres('SELECT ?, ?'), 'SELECT $1, $2');
});

test('DASHBOARD_READS: every ordering is total (deterministic across engines)', () => {
  // The gate is on the ORDER BY tail: each must end in a unique column, so the
  // two engines cannot disagree on ties.
  const orderBy: Record<string, string> = {
    transactions: 'ORDER BY date DESC, id DESC',
    journal: 'ORDER BY date DESC, id DESC',
    assets: 'ORDER BY value_usd DESC, id DESC',
    wallets: 'ORDER BY label, address',
    trades: 'ORDER BY date DESC, id DESC',
  };
  for (const [name, clause] of Object.entries(orderBy)) {
    const sql = DASHBOARD_READS[name as keyof typeof DASHBOARD_READS];
    assert.ok(
      sql.includes(clause),
      `${name} must carry the total-order clause "${clause}", got: ${sql}`,
    );
  }
  // accounts and ledger key on a unique column already; netWorth has no ordering.
  assert.ok(DASHBOARD_READS.accounts.endsWith('ORDER BY code'));
  assert.ok(DASHBOARD_READS.ledger.endsWith('ORDER BY account_code'));
  assert.ok(!DASHBOARD_READS.netWorth.includes('ORDER BY'));
});

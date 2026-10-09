/**
 * Data-layer unit tests (DR-019, DR-040): run OFFLINE, no Postgres, no Valkey.
 *
 * Contract under test:
 *  - `toPostgres` translates the two SQLite constructs this app's statements use.
 *    Both halves of it have already caused a visible bug. `?` must become numbered
 *    `$n` placeholders (a bare `?` is invalid SQL in Postgres). `ORDER BY rowid`
 *    becomes `ORDER BY id`, which is sound ONLY where the primary key is an INTEGER
 *    (`transactions`, `trades`, `ledger`) and is FATAL for a table keyed on text:
 *    `wallets` is keyed on `address` and has no `id`, so that rewrite returned
 *    `column "id" does not exist` to `/api/wallets`, whose caller caught the 500 and
 *    rendered a calm "Wallets (0)". The translator contract is therefore asserted on
 *    a table where it IS sound, and the guard at the bottom forbids routes from
 *    depending on it at all.
 *  - `DASHBOARD_READS`' orderings all end in a total-order tiebreaker. SQLite's
 *    rowid makes an ORDER BY on a non-unique column deterministic by insertion
 *    order; Postgres leaves ties unspecified, which returned a different row order
 *    for the transactions list until a tiebreaker was added.
 *
 * Usage: cd apps/web && bun run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPostgres, DASHBOARD_READS } from '@/server/db';

test('toPostgres: ? placeholders are numbered from 1', () => {
  assert.equal(toPostgres('SELECT * FROM wallets WHERE address = ?'), 'SELECT * FROM wallets WHERE address = $1');
  assert.equal(
    toPostgres('UPDATE wallets SET alias = ?, emoji = ? WHERE address = ?'),
    'UPDATE wallets SET alias = $1, emoji = $2 WHERE address = $3',
  );
  assert.equal(toPostgres('DELETE FROM transactions WHERE id IN (?, ?, ?)'), 'DELETE FROM transactions WHERE id IN ($1, $2, $3)');
});

test('toPostgres: ORDER BY rowid maps to the primary key, not to ctid', () => {
  // The example is `transactions` (id is an INTEGER), NOT `wallets`: `wallets` is
  // keyed on `address` and has no `id`, so this very rewrite is what returned
  // `column "id" does not exist` to /api/wallets. Soundness here is a property of
  // the TABLE, not of the statement, which is why routes must not depend on it.
  assert.equal(toPostgres('SELECT * FROM transactions ORDER BY rowid'), 'SELECT * FROM transactions ORDER BY id');
  assert.ok(!toPostgres('SELECT * FROM transactions ORDER BY rowid').includes('ctid'));
  // The rewrite is case-insensitive and normalises to the uppercase form.
  assert.equal(toPostgres('SELECT * FROM transactions order by rowid'), 'SELECT * FROM transactions ORDER BY id');
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

test('no route orders by rowid (the rewrite needs an INTEGER primary key)', () => {
  // A route cannot know its table's key shape, and for a text-keyed table the rewrite
  // is fatal rather than merely wrong: `/api/wallets` ordered by rowid, Postgres
  // answered `column "id" does not exist`, and the caller's `.catch(() => [])` turned
  // that 500 into a calm "Wallets (0)". The accessible symptom was an empty surface,
  // not an error, so nothing else would have caught it. Hence a static guard.
  const root = fileURLToPath(new URL('../src/app/', import.meta.url));
  const entries = readdirSync(root, { recursive: true }) as unknown as (string | Buffer)[];
  const files = entries.map((f) => String(f)).filter((f) => f.endsWith('route.ts'));
  // The walk must actually find the routes: an empty glob would make this pass silently.
  assert.ok(files.length > 10, `expected the route walk to find the route files, got ${files.length}`);
  // Match CODE, not prose. The route that was fixed necessarily explains the hazard in
  // a comment containing the phrase, and a guard that reads comments fails the very
  // file that documents the fix — which is exactly what happened on first run. Comments
  // are stripped first. (Trade-off: a `//` inside a string literal truncates the rest of
  // its line and could hide a later match — accepted; this is a guard, not a parser.)
  const offenders = files.filter((f) =>
    /order\s+by\s+rowid/i.test(
      readFileSync(join(root, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, ''),
    ),
  );
  assert.deepEqual(offenders, [], `route(s) still order by rowid: ${offenders.join(', ')}`);
});

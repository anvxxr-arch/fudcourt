/**
 * Wire-time rendering: the api's timestamps are UTC with NO zone marker.
 *
 * `db/schema/pg-schema.sql` writes every `created_at` as
 *   to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
 * → `2026-10-14 23:10:00`, UTC, unmarked. `new Date()` on a string like that is
 * implementation-defined, and every engine we care about reads it as LOCAL time. On the UTC
 * homeserver that is a coincidence that hides the defect; in a browser east of UTC it is a silent
 * lie — 23:10 UTC rendered as "23:10" to a reader in WIB, seven hours and a day-boundary off. The
 * first version of this renderer passed its test because the test used an RFC3339 fixture the api
 * never sends, so these tests use the wire string verbatim and prove the rendering does not move
 * with the reader's clock.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'bun:test';

import { formatWireTime } from '../src/features/admin/wire-time';

// The string the api actually sends, copied from the schema's to_char format.
const WIRE = '2026-10-14 23:10:00';
const RENDERED = '14/10/2026, 23:10:00 UTC';

test('wire time: the api format is read as UTC', () => {
  assert.equal(formatWireTime(WIRE), RENDERED);
});

test('wire time: the result says which clock it is on', () => {
  // A bare "23:10" is the bug: the reader supplies their own timezone and gets it wrong.
  assert.ok(formatWireTime(WIRE).endsWith('UTC'));
});

test('wire time: a string that already carries a zone is honoured', () => {
  assert.equal(formatWireTime('2026-10-14T23:10:00Z'), RENDERED);
  // The same instant, written the way a timestamptz column would render it.
  assert.equal(formatWireTime('2026-10-15T06:10:00+07:00'), RENDERED);
});

test('wire time: seconds survive and the day does not drift', () => {
  assert.equal(formatWireTime('2026-01-01 00:00:00'), '01/01/2026, 00:00:00 UTC');
  assert.equal(formatWireTime('2026-12-31 23:59:59'), '31/12/2026, 23:59:59 UTC');
});

test('wire time: anything unreadable is shown verbatim, never "Invalid Date"', () => {
  // A value the renderer cannot read is itself the diagnosis; swallowing it hides a bad write.
  assert.equal(formatWireTime('not-a-date'), 'not-a-date');
  assert.equal(formatWireTime('2026-13-45 99:99:99'), '2026-13-45 99:99:99');
  assert.equal(formatWireTime(''), '');
});

test('wire time: the rendering does not depend on the reader timezone', () => {
  // The real module, in a child process, under a zone east of UTC. The naive parse passes on a UTC
  // box (which is how the bug survived) and fails here.
  const module = new URL('../src/features/admin/wire-time.ts', import.meta.url).pathname;
  const script = `import { formatWireTime } from ${JSON.stringify(module)}; console.log(formatWireTime(${JSON.stringify(WIRE)}));`;
  for (const tz of ['Asia/Jakarta', 'America/New_York', 'UTC', 'Pacific/Kiritimati']) {
    const out = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
    }).trim();
    assert.equal(out, RENDERED, `rendering under TZ=${tz} must match`);
  }
});

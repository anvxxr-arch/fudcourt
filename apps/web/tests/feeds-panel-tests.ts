/**
 * Feeds panel tests: run OFFLINE, no network, no DOM.
 *
 * The panel is a REPLACE editor for `feed_sources` — the rows the worker's poller reads. Three
 * things are worth pinning, because getting any of them wrong is silent:
 *
 *  - WHAT THE SAVE SENDS (`writableFeeds`). The source and its `scheduled_jobs` poll definition
 *    are written in ONE transaction, so the body must carry an OPERATOR's fields only: a body
 *    carrying the poller's own report (`primed`, `owed`, `lastStatus`, `lastError`,
 *    `consecutiveFailures`) or the row `id` describes an edit this panel cannot make.
 *  - WHAT A DRAFT ROUND-TRIPS (`draftFrom` → `toSource`). The fields an operator owns survive a
 *    load/save cycle, and the three nullable optionals map to the wire's own "no value" (null)
 *    rather than to "".
 *  - WHAT A CADENCE READS AS (`intervalLabel`) and what a feed's health says (`healthLine`).
 *    Both are the panel's whole reason for existing: an operator should never do arithmetic on a
 *    number of seconds, and "nothing was announced" must not look like a broken feed when it is
 *    a baseline that has not been absorbed yet.
 *
 * The rules the SERVER owns — the url guard, the name bound, the cadence bounds, the duplicate
 * name — are deliberately NOT re-implemented here, so there is nothing to assert about them: a
 * refusal is reported as the server's sentence via `describeSaveFailure`, which is tested.
 *
 * Usage: cd apps/web && bun run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchFeeds, saveFeeds, writableFeeds, type FeedSource } from '@/features/admin/client';
import {
  ADAPTERS,
  DEFAULT_POLL_SECS,
  MAX_POLL_SECS,
  MIN_POLL_SECS,
  adapterHint,
  draftFrom,
  healthLine,
  intervalLabel,
  newFeedDraft,
  toSource,
} from '@/features/admin/feeds-draft';
import { describeSaveFailure } from '@/features/admin/save-error';
import { HttpError } from '@/lib/fetch';

/** A row as the Go api returns it: the operator's fields, and the poller's report. */
function row(over: Partial<FeedSource> = {}): FeedSource {
  return {
    id: 7,
    name: 'blog',
    url: 'https://example.com/feed.xml',
    adapter: 'auto',
    channelId: '1234567890123456789',
    message: '**{title}**\n{url}',
    mentionRoleId: null,
    includeText: null,
    excludeText: null,
    enabled: true,
    pollIntervalSecs: 900,
    primed: true,
    owed: 0,
    consecutiveFailures: 0,
    lastStatus: 'ok',
    lastError: null,
    ...over,
  };
}

test('feeds panel: a draft round-trips the operator fields and the poller report', () => {
  const source = row({ mentionRoleId: '999888777666555444', includeText: 'release' });
  const d = draftFrom(source, 'feed-7');

  assert.equal(d.key, 'feed-7');
  assert.equal(d.id, 7);
  assert.equal(d.name, 'blog');
  assert.equal(d.url, 'https://example.com/feed.xml');
  assert.equal(d.channelId, '1234567890123456789', 'a snowflake stays a string: a JS number would lose the low digits');
  assert.equal(d.mentionRoleId, '999888777666555444');
  assert.equal(d.includeText, 'release');
  assert.equal(d.excludeText, '');
  assert.equal(d.pollIntervalSecs, 900);
  assert.equal(d.lastStatus, 'ok');

  const back = toSource(d);
  assert.equal(back.url, source.url);
  assert.equal(back.channelId, source.channelId);
  assert.equal(back.message, source.message, 'the template comes back byte for byte');
  assert.equal(back.enabled, true);
  assert.equal(back.pollIntervalSecs, 900);
  // The report is carried so the row renders without a re-read — and dropped at the body.
  assert.equal(back.primed, true);
  assert.equal(back.lastStatus, 'ok');
});

test('feeds panel: a nullable field becomes an empty input, and back to null on the wire', () => {
  const d = draftFrom(row({ mentionRoleId: null, lastError: null }), 'k');
  assert.equal(d.mentionRoleId, '');
  assert.equal(d.lastError, '');
  assert.equal(writableFeeds([toSource(d)])[0].mentionRoleId, null, 'the wire\'s "no value" is null, not ""');
});

test('feeds panel: the save body is the operator fields and nothing else', () => {
  const body = writableFeeds([toSource(draftFrom(row(), 'k'))])[0];
  assert.deepEqual(Object.keys(body).sort(), [
    'adapter',
    'channelId',
    'enabled',
    'excludeText',
    'includeText',
    'mentionRoleId',
    'message',
    'name',
    'pollIntervalSecs',
    'url',
  ]);

  // Named one by one, so a future field added to the type cannot silently join the body: the
  // poller owns these, and `id` is not how the store addresses a row (it keys on `name`).
  for (const owned of ['id', 'primed', 'owed', 'consecutiveFailures', 'lastStatus', 'lastError']) {
    assert.equal(owned in body, false, `${owned} belongs to the store/worker, not to a save`);
  }
});

test('feeds panel: a save trims what the api trims and stores a template verbatim', () => {
  const body = writableFeeds([
    toSource(draftFrom(row({ name: '  blog  ', url: ' https://example.com/feed.xml ', mentionRoleId: '   ', includeText: '  release  ' }), 'k')),
  ])[0];

  // The stored name is trimmed by the api, so "blog " and "blog" must not collide on the next save.
  assert.equal(body.name, 'blog');
  assert.equal(body.url, 'https://example.com/feed.xml');
  assert.equal(body.mentionRoleId, null, 'whitespace is "not set", the same as empty');
  assert.equal(body.includeText, 'release');
  assert.equal(body.message, '**{title}**\n{url}', 'a template is not trimmed: its whitespace may be deliberate');
});

test('feeds panel: a new draft is enabled, on auto, at the default cadence', () => {
  const d = newFeedDraft('new-1');
  assert.equal(d.enabled, true, 'a feed that saves disabled is the "I added it and nothing happened" bug');
  assert.equal(d.adapter, 'auto', 'the adapter that asks nothing of an operator');
  assert.equal(d.pollIntervalSecs, DEFAULT_POLL_SECS);
  assert.equal(d.id, 0);
  assert.equal(d.url, '');
  assert.equal(d.primed, false);
  assert.ok(MIN_POLL_SECS <= DEFAULT_POLL_SECS && DEFAULT_POLL_SECS <= MAX_POLL_SECS, 'the default is inside the api\'s bounds');
});

test('feeds panel: a cadence reads as a sentence, not as a number of seconds', () => {
  assert.equal(intervalLabel(60), 'every minute');
  assert.equal(intervalLabel(900), 'every 15 minutes');
  assert.equal(intervalLabel(3600), 'every hour');
  assert.equal(intervalLabel(86400), 'every day');
  assert.equal(intervalLabel(604800), 'every 7 days');
  assert.equal(intervalLabel(90), 'every 90 seconds', 'a non-round cadence is reported as it is, not rounded');
  assert.equal(intervalLabel(0), 'no cadence set');
  assert.equal(intervalLabel(Number.NaN), 'no cadence set');
});

test('feeds panel: a feed health line says what is true, including the silent first poll', () => {
  assert.equal(healthLine(draftFrom(row(), 'k')), 'ok');

  const fresh = draftFrom(row({ primed: false, lastStatus: null, lastError: null }), 'k');
  const line = healthLine(fresh);
  assert.match(line, /never polled/);
  assert.match(line, /baseline not absorbed yet/, 'a working feed that announces nothing must not read like a broken one');

  const owed = healthLine(draftFrom(row({ owed: 4, consecutiveFailures: 2, lastStatus: 'failed', lastError: 'connect timeout' }), 'k'));
  assert.match(owed, /4 owed/);
  assert.match(owed, /2 consecutive failures/);
  assert.match(owed, /error: connect timeout/);
});

test('feeds panel: the adapter field says what it is for, and it is not a switch', () => {
  assert.match(adapterHint('auto'), /sniffs the body/);
  assert.match(adapterHint('rss'), /same parser/);
  assert.match(adapterHint('json'), /same parser/);
});

test('feeds panel: the api client reads the list and posts the whole set', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ feeds: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    await fetchFeeds();
    assert.equal(calls[0].url, '/api/admin/feeds');
    assert.equal(calls[0].init?.cache, 'no-store', 'a cached read would show stale feed health');

    await saveFeeds([row(), row({ id: 8, name: 'news' })]);
    const post = calls[1];
    assert.equal(post.url, '/api/admin/feeds');
    assert.equal(post.init?.method, 'POST');
    assert.equal((post.init?.headers as Record<string, string>)['Content-Type'], 'application/json');

    const body = JSON.parse(String(post.init?.body)) as { feeds: Record<string, unknown>[] };
    assert.equal(body.feeds.length, 2, 'a replace sends the whole set: an absent source is deleted');
    assert.deepEqual(body.feeds.map((f) => f.name), ['blog', 'news']);
    assert.equal('primed' in body.feeds[0], false, 'the poller\'s report never travels back');
    assert.equal('lastStatus' in body.feeds[0], false);
  } finally {
    globalThis.fetch = real;
  }
});

test('feeds panel: a refusal reached over the wire arrives as the server\'s own sentence', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ detail: 'feeds[1]: url must not point at a private address' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  try {
    await assert.rejects(
      () => saveFeeds([row()]),
      (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 400);
        assert.match(describeSaveFailure(err), /feeds\[1\]: url must not point at a private address/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = real;
  }
});

test('feeds panel: this endpoint has no 409, so no refusal is dressed up as "rename it"', () => {
  const invalid = new HttpError('/api/admin/feeds', 400, 'feeds[2]: name must be 1..64 characters');
  assert.match(describeSaveFailure(invalid), /feeds\[2\]: name must be 1\.\.64 characters/);

  // The 503 names the reason AND the variable, which is what an operator needs to fix it.
  const unavailable = new HttpError('/api/admin/feeds', 503, 'feed store is not configured (FUDCOURT_PG_URL unset)');
  assert.match(describeSaveFailure(unavailable), /FUDCOURT_PG_URL/);

  const stray = describeSaveFailure(new HttpError('/api/admin/feeds', 409, 'the name "blog" is taken'));
  assert.equal(stray, 'refused: the name "blog" is taken');
  assert.doesNotMatch(stray, /rename it/, 'the conflict hint belongs to the panel whose endpoint has the 409');
});

test('feeds panel: the offered adapters are the ones the contract documents', () => {
  // Drift guard: the panel offers an adapter because the API accepts it, and the contract is
  // where that fact is written down. Adding one to the panel without the wire (or documenting
  // one the panel cannot reach) is the drift this catches.
  const contract = readFileSync(new URL('../../../contracts/openapi/fudcourt.yaml', import.meta.url), 'utf8');
  const schema = contract.slice(contract.indexOf('FeedSource:'), contract.indexOf('FeedConfig:'));
  assert.ok(schema.includes('enum: [auto, rss, atom, json]'), 'the panel offers exactly the enum the api accepts');
  assert.equal(ADAPTERS.join(','), 'auto,rss,atom,json');
});

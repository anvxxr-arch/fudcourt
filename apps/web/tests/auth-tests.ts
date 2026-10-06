/**
 * Auth unit tests: run OFFLINE, no Discord network.
 *
 * Contract under test (lib/auth.ts + lib/guard.ts):
 *  - a session cookie is HMAC-signed; tampering, truncation or a wrong key
 *    must degrade to "no session" rather than throwing or trusting the payload.
 *  - tier resolution is rank-ordered: admin >= team >= member >= public, and a
 *    missing guild/role env can only ever LOWER access (fail-closed).
 *  - the post-login `next` target is attacker-supplied: it must accept only a
 *    site-relative path, never a protocol-relative or traversing one.
 *
 * Usage: cd apps/web && npm run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.FUDCOURT_SESSION_SECRET = 'test-secret-at-least-32-characters-long!!';

// Imported after the env is set: readSession/sign are read at call time, but
// tierFromRoles reads env on every call, so the order still matters for clarity.
import { TIER_RANK, createSessionToken, hasTier, isSafeNext, readSession, requiredTierForPath, tierFromRoles, type SessionUser } from '@/server/auth';

const SECRET = process.env.FUDCOURT_SESSION_SECRET;

function user(tier: SessionUser['tier']): SessionUser {
  return { id: '1', username: 'u', globalName: 'U', avatar: null, tier, roles: [] };
}

test('session: a signed cookie round-trips to the same user', async () => {
  const u = user('team');
  const claims = await readSession(await createSessionToken(u));
  assert.ok(claims);
  assert.equal(claims.id, u.id);
  assert.equal(claims.tier, 'team');
});

test('session: a tampered payload is rejected (no privilege escalation)', async () => {
  const token = await createSessionToken(user('member'));
  const [payload, sig] = token.split('.');
  // Swap the tier in the payload but keep the original signature.
  const forged = Buffer.from(JSON.stringify({ ...user('admin'), exp: Math.floor(Date.now() / 1000) + 3600 }), 'utf8').toString('base64url');
  const result = await readSession(`${forged}.${sig}`);
  assert.equal(result, null, 'forged admin tier must not be accepted');
  assert.ok(payload && sig);
});

test('session: a cookie signed with a different key is rejected', async () => {
  const payload = Buffer.from(JSON.stringify({ ...user('admin'), exp: Math.floor(Date.now() / 1000) + 3600 }), 'utf8').toString('base64url');
  const foreignSig = createHmac('sha256', 'a-completely-different-secret-value-32ch').update(payload).digest('base64url');
  assert.equal(await readSession(`${payload}.${foreignSig}`), null);
});

test('session: truncated / malformed / empty values are all "no session"', async () => {
  for (const bad of ['', '.', 'abc', 'a.b', null, undefined]) {
    assert.equal(await readSession(bad as string | null), null);
  }
});

test('session: an expired cookie is rejected', async () => {
  const token = await createSessionToken(user('admin'), -10);
  assert.equal(await readSession(token), null);
});

test('tiers: rank ordering is public < member < team < admin', () => {
  assert.ok(TIER_RANK.public < TIER_RANK.member);
  assert.ok(TIER_RANK.member < TIER_RANK.team);
  assert.ok(TIER_RANK.team < TIER_RANK.admin);
});

test('guard: hasTier enforces the rank and refuses null sessions', () => {
  assert.equal(hasTier(null, 'public'), true);
  assert.equal(hasTier(null, 'member'), false);
  assert.equal(hasTier(user('member'), 'team'), false);
  assert.equal(hasTier(user('team'), 'team'), true);
  assert.equal(hasTier(user('team'), 'admin'), false);
  assert.equal(hasTier(user('admin'), 'member'), true);
});

test('guard: route policy gates treasury paths to team and admin to admin', () => {
  assert.equal(requiredTierForPath('/team/balance'), 'team');
  assert.equal(requiredTierForPath('/admin'), 'admin');
  assert.equal(requiredTierForPath('/member'), 'member');
  for (const p of ['/api/all', '/api/wallets', '/api/coins', '/api/reconcile', '/api/transactions/1']) {
    assert.equal(requiredTierForPath(p), 'team', `${p} must be team-gated`);
  }
  // Public market surface stays open.
  for (const p of ['/', '/ticker', '/dex', '/api/markets', '/api/news', '/robots.txt']) {
    assert.equal(requiredTierForPath(p), null, `${p} must stay public`);
  }
  // A prefix must not capture a lookalike path.
  assert.equal(requiredTierForPath('/teamspeak'), null);
  assert.equal(requiredTierForPath('/api/alloy'), null);
});

test('tierFromRoles: admin outranks team; unknown env can only lower access', () => {
  const saved = { g: process.env.FUDCOURT_GUILD_ID, t: process.env.FUDCOURT_ROLE_TEAM, a: process.env.FUDCOURT_ROLE_ADMIN };
  try {
    process.env.FUDCOURT_GUILD_ID = '1';
    process.env.FUDCOURT_ROLE_TEAM = 'role-team';
    process.env.FUDCOURT_ROLE_ADMIN = 'role-admin';
    assert.equal(tierFromRoles(['role-admin']), 'admin');
    assert.equal(tierFromRoles(['role-team']), 'team');
    assert.equal(tierFromRoles(['role-team', 'role-admin']), 'admin');
    assert.equal(tierFromRoles(['something-else']), 'member');
    assert.equal(tierFromRoles([]), 'member');

    // Fail-closed: no guild configured means nothing to resolve against.
    delete process.env.FUDCOURT_GUILD_ID;
    assert.equal(tierFromRoles(['role-admin']), 'public');
    // A missing role id lowers rather than escalates.
    process.env.FUDCOURT_GUILD_ID = '1';
    delete process.env.FUDCOURT_ROLE_TEAM;
    assert.equal(tierFromRoles(['role-admin']), 'public');
  } finally {
    process.env.FUDCOURT_GUILD_ID = saved.g;
    process.env.FUDCOURT_ROLE_TEAM = saved.t;
    process.env.FUDCOURT_ROLE_ADMIN = saved.a;
  }
});

test('open redirect: isSafeNext only accepts a site-relative path', () => {
  for (const ok of ['/', '/team/balance', '/admin']) {
    assert.equal(isSafeNext(ok), true, `${ok} should be allowed`);
  }
  for (const bad of [
    '//evil.example.com',       // protocol-relative -> another host
    'https://evil.example.com', // absolute
    '/team/../../etc',          // traversal
    '/x?y=1',                   // second target smuggled via query
    '/x#frag',                  // fragment
    '/a%2Fb',                   // ambiguous once decoded
    '',                          // empty
    'team/balance',             // not rooted
    '/\\evil.example.com',      // backslash normalizes to protocol-relative
    '/\\\\evil.example.com',    // double backslash
    '/\\/evil.example.com',     // escaped backslash then slash
    '%2F%2Fevil.example.com',   // percent-encoded leading slashes
    '/%5Cevil.example.com',     // percent-encoded backslash
    null,
    undefined,
  ]) {
    assert.equal(isSafeNext(bad as string | null), false, `${String(bad)} must be refused`);
  }
});

test('secret hygiene: no build-time auth secret reaches the client bundle', () => {
  // The client mutation headers used to inline a build-time token, which Next
  // baked into a public JS chunk. Guard that regression: only executable code
  // is checked, with comment lines stripped, so the explanatory note naming
  // the retired variable does not trip the assertion.
  const source = readFileSync(join(process.cwd(), 'src', 'lib', 'http.ts'), 'utf8')
    .split('\n')
    .filter(line => !line.trimStart().startsWith('//'))
    .join('\n');
  assert.ok(!/NEXT_PUBLIC_FUD_MUTATION_TOKEN/.test(source), 'client headers must not inline a secret');
  assert.ok(!/x-fud-token/.test(source), 'client headers must not send a static auth header');
});

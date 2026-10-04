/**
 * Inbound rate-limit tests: run OFFLINE, no network, no clock waiting.
 *
 * Contract under test (lib/rate-limit-inbound.ts):
 *  - a request is charged for the payload its route can serve, because the same
 *    route spans 1,190,228 B (cryptorank `chain`) to 835 B (`coin`);
 *  - the budget is per client and per window, and the window actually rolls;
 *  - the two regressions that would make this fix worse than the disease are
 *    covered: a real board mount must still fit the budget, and the operator's
 *    own harness / a signed-in treasury user must not be locked out;
 *  - a limiter error fails open rather than refusing traffic.
 *
 * Usage: cd frontend/web && npm run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTHED_MULTIPLIER,
  CR_MODE_COST,
  DEFAULT_COST,
  HEAVY_ALLOWANCE,
  LIGHT_ALLOWANCE,
  LOCAL_MULTIPLIER,
  MAX_CLIENTS,
  ROUTE_COST,
  WINDOW_MS,
  checkInbound,
  clientKey,
  costForRequest,
  __bucketCount,
  __resetRateLimit,
} from '@/platform/http/rate-limit-inbound';
import { limitedFetch, __resetLimiter } from '@/platform/http/rate-limit';
const T0 = 1_700_000_000_000;
const q = (mode?: string) => new URLSearchParams(mode === undefined ? {} : { mode });
const cost = (path: string, mode?: string) => costForRequest(path, q(mode));
test('cost: the payload each route can serve sets its price', () => {
  // The measured spread is the reason this is not a request counter.
  assert.equal(cost('/api/cryptorank', 'chain'), 20); // 1,190,228 B
  assert.equal(cost('/api/cryptorank', 'converter'), 20); // 921,588 B
  assert.equal(cost('/api/cryptorank', 'coin'), DEFAULT_COST); // 835 B
  assert.equal(cost('/api/cryptorank', 'funding'), DEFAULT_COST); // refused 503, tiny
  assert.equal(cost('/api/llama', 'chains'), 2); // 64,245 B
  assert.equal(cost('/api/llama', 'historical'), DEFAULT_COST); // 7,031 B
  assert.equal(cost('/api/ticker'), 2); // 69,445 B full board
  // Sub-paths inherit the family price: the instrument lookup is the same data
  // family as the ticker board and must not be a cheaper way in.
  assert.equal(cost('/api/ticker/instrument'), 2);
  assert.equal(cost('/api/ticker/instruments'), 2);
  // Empty envelopes and refusals stay cheap.
  for (const p of ['/api/all', '/api/wallets', '/api/coins', '/api/reconcile', '/api/transactions/1', '/api/auth/login']) {
    assert.equal(cost(p), DEFAULT_COST, `${p} must stay default-cost`);
  }
  // An unknown or malformed path is never free.
  for (const p of ['/api/', '/api', '/api/unknown-route', '']) {
    assert.ok(cost(p) >= DEFAULT_COST, `${p} must cost at least one unit`);
  }
});
test('cost: the priciest pinned modes are the ones measured above one unit', () => {
  // Every entry is a measurement; this keeps the table honest if a mode is
  // re-priced without evidence.
  assert.deepEqual(Object.keys(CR_MODE_COST).sort(), ['blockchains', 'chain', 'converter', 'gainers', 'losers', 'tag', 'tags']);
});
test('cost: every route-level entry above one unit is a measurement, and the table is exhaustive', () => {
  // Same guard as CR_MODE_COST, for the route-level table: adding a family
  // without measuring it (and without recording the figure here) fails.
  // `executor` is 8, not a measured payload: it is a COST-SURFACE price, because
  // the endpoints under it size a position, hit the venue for balances/markets
  // and (on POST) persist an execution. A flat request counter would let one
  // window buy hundreds of live orders; 8 units makes a window ≈ a handful, and
  // the comment above the table records that reasoning.
  assert.deepEqual(Object.keys(ROUTE_COST).sort(), ['executor', 'market', 'markets', 'ticker']);
});
test('cost: the executor family is priced above the default — placing an order is not a cheap read', () => {
  // Every sub-path must inherit the family price, so a nested route can never be
  // a cheaper way into the same surface (PRD §108).
  for (const path of [
    '/api/executor/executions',
    '/api/executor/preview',
    '/api/executor/accounts',
    '/api/executor/executions/abc/cancel',
    '/api/executor/executions/abc/start',
  ]) {
    assert.equal(costForRequest(path, new URLSearchParams()), ROUTE_COST.executor, path);
  }
  assert.ok(ROUTE_COST.executor > DEFAULT_COST, 'the executor must not fall through to the cheapest tier');
});
test('budget: a real cryptorank board mount still fits one window', () => {
  __resetRateLimit();
  // Measured mount (src/components/CryptorankPage.tsx §useEffect):
  // home + coin + exchanges + listings + blockchains + chain + news + tags + tag
  // = 1 + 1 + 1 + 1 + 2 + 20 + 1 + 2 + 3 = 32 units. Tuning the heavy allowance
  // below two mounts would break the board on the fix meant to protect it.
  const mount: Array<[string, string]> = [
    ['/api/cryptorank', 'home'],
    ['/api/cryptorank', 'coin'],
    ['/api/cryptorank', 'exchanges'],
    ['/api/cryptorank', 'listings'],
    ['/api/cryptorank', 'blockchains'],
    ['/api/cryptorank', 'chain'],
    ['/api/cryptorank', 'news'],
    ['/api/cryptorank', 'tags'],
    ['/api/cryptorank', 'tag'],
  ];
  const mountUnits = mount.reduce((sum, [p, m]) => sum + cost(p, m), 0);
  assert.equal(mountUnits, 32);
  assert.ok(mountUnits * 2 <= HEAVY_ALLOWANCE, `${mountUnits * 2} units for two mounts must fit ${HEAVY_ALLOWANCE}`);
  for (const [p, m] of mount) {
    assert.equal(checkInbound('mount', p, { now: T0, params: q(m) }).allowed, true, `${p}?mode=${m} must be served`);
  }
  // The cheapest mode must not be priced into the heavy tier by accident.
  assert.equal(checkInbound('mount', '/api/cryptorank', { now: T0, params: q('coin') }).limit, LIGHT_ALLOWANCE);
});
test('budget: the window is spent by cost and the next request is refused', () => {
  __resetRateLimit();
  const perWindow = Math.floor(HEAVY_ALLOWANCE / 20);
  assert.ok(perWindow >= 1, 'a 20-unit route must be reachable at least once per window');
  for (let i = 0; i < perWindow; i++) {
    assert.equal(
      checkInbound('198.51.100.7', '/api/cryptorank', { now: T0 + i, params: q('chain') }).allowed,
      true,
      `request ${i + 1} of ${perWindow} should fit the window`,
    );
  }
  const refused = checkInbound('198.51.100.7', '/api/cryptorank', { now: T0 + perWindow, params: q('chain') });
  assert.equal(refused.allowed, false);
  assert.equal(refused.remaining, 0);
  assert.ok(refused.retryAfterSeconds > 0, 'a refusal must tell the caller when to come back');
  assert.ok(refused.resetSeconds <= Math.ceil(WINDOW_MS / 1000));
});
test('budget: the window rolls over and the client is served again', () => {
  __resetRateLimit();
  const exhaust = LIGHT_ALLOWANCE + 5;
  for (let i = 0; i < exhaust; i++) checkInbound('198.51.100.8', '/api/news', { now: T0 + i });
  assert.equal(checkInbound('198.51.100.8', '/api/news', { now: T0 + exhaust }).allowed, false);
  const after = checkInbound('198.51.100.8', '/api/news', { now: T0 + WINDOW_MS });
  assert.equal(after.allowed, true, 'a client must recover once its window expires');
  assert.equal(after.remaining, after.limit - after.cost);
});
test('budget: two clients never share a window', () => {
  __resetRateLimit();
  for (let i = 0; i < LIGHT_ALLOWANCE; i++) checkInbound('a', '/api/news', { now: T0 + i });
  assert.equal(checkInbound('a', '/api/news', { now: T0 + 100 }).allowed, false);
  // A global (non-per-client) bucket would refuse this one too.
  assert.equal(checkInbound('b', '/api/news', { now: T0 + 100 }).allowed, true);
});
test('budget: the local scope and a signed-in caller are not locked out', () => {
  __resetRateLimit();
  // The operator's own harness on loopback sends no CF-Connecting-IP, so if it
  // shared the public budget the monitor and every verify-*.py run would start
  // failing on the fix meant to protect them.
  for (let i = 0; i < HEAVY_ALLOWANCE; i++) {
    assert.equal(checkInbound('local', '/api/cryptorank', { now: T0 + i, scope: 'local', params: q('chain') }).allowed, true);
  }
  assert.equal(
    checkInbound('local', '/api/cryptorank', { now: T0 + HEAVY_ALLOWANCE, scope: 'local', params: q('chain') }).allowed,
    true,
  );
  assert.equal(
    checkInbound('local', '/api/cryptorank', { now: T0, scope: 'local', params: q('chain') }).limit,
    HEAVY_ALLOWANCE * LOCAL_MULTIPLIER,
  );
  // A team member browsing the treasury gets AUTHED_MULTIPLIER times the
  // anonymous budget, not the same one.
  __resetRateLimit();
  const authed = checkInbound('u1', '/api/cryptorank', { now: T0, authed: true, params: q('chain') });
  assert.equal(authed.limit, HEAVY_ALLOWANCE * AUTHED_MULTIPLIER);
  // `authed` above is charge #1; fill the rest of the budget, then one more.
  const authedPerWindow = Math.floor(authed.limit / authed.cost);
  for (let i = 1; i < authedPerWindow; i++) {
    assert.equal(checkInbound('u1', '/api/cryptorank', { now: T0 + i, authed: true, params: q('chain') }).allowed, true);
  }
  assert.equal(checkInbound('u1', '/api/cryptorank', { now: T0 + authedPerWindow, authed: true, params: q('chain') }).allowed, false);
});
test('state: retained buckets are bounded under a flood of distinct clients', () => {
  __resetRateLimit();
  // The unbounded-cache bug class lib/rate-limit.ts documents: a limiter keyed
  // by a client-controlled value must bound its own retention.
  for (let i = 0; i < MAX_CLIENTS + 250; i++) checkInbound(`203.0.113.${i}`, '/api/news', { now: T0 + i });
  assert.ok(__bucketCount() <= MAX_CLIENTS, `retained ${__bucketCount()} > cap ${MAX_CLIENTS}`);
});
test('state: a limiter error fails open instead of refusing traffic', () => {
  __resetRateLimit();
  // Fail-open is deliberate: a counter bug must not take the public boards down.
  for (const [id, path] of [['', ''], ['x'.repeat(10_000), '/api/cryptorank'], ['null', '/api/news']]) {
    const d = checkInbound(id, path, { now: T0 });
    assert.equal(d.allowed, true, `${id.slice(0, 8)}/${path} must not be refused`);
  }
});
test('keying: Cloudflare wins, a private last hop is local, any public hop is not', () => {
  // CF-Connecting-IP is set by Cloudflare, not by the caller.
  assert.deepEqual(clientKey(new Headers({ 'cf-connecting-ip': '203.0.113.9' })), { key: '203.0.113.9', scope: 'public' });
  // Spoof-resistance: a client can pre-seed earlier hops, so the LAST hop is the
  // one a proxy observed. Trusting the first would let one caller mint unlimited
  // identities and walk around the limiter.
  assert.deepEqual(
    clientKey(new Headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.10' })),
    { key: '203.0.113.10', scope: 'public' },
  );
  // A FORGED first hop must not buy the local budget: only the observed last
  // hop decides, and a public last hop is public even behind "127.0.0.1, ".
  assert.deepEqual(
    clientKey(new Headers({ 'x-forwarded-for': '127.0.0.1, 203.0.113.12' })),
    { key: '203.0.113.12', scope: 'public' },
  );
  // THE MEASURED DEPLOYMENT CASE (2026-09-29 regression): Next.js synthesises
  // `x-forwarded-for` from the socket peer, so the operator's own loopback
  // harness arrives with exactly this header and no CF header. It must be
  // local — the "no headers" branch below is unreachable in production and was
  // the reason a full harness run was 429'd (DR-004 amendment).
  assert.deepEqual(
    clientKey(new Headers({ 'x-forwarded-for': '::ffff:127.0.0.1' })),
    { key: '::ffff:127.0.0.1', scope: 'local' },
  );
  // The private/loopback/link-local families the module treats as its own.
  for (const addr of ['127.0.0.1', '::1', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.100.6', '169.254.3.4', 'fd00::1', 'fc00::abcd', '[::1]', 'fe80::1%eth0']) {
    assert.equal(clientKey(new Headers({ 'x-forwarded-for': addr })).scope, 'local', `${addr} must be local`);
  }
  // …and their close neighbours must NOT be: 172.15/172.32 are public, and a
  // plain public v4/v6 address stays public.
  for (const addr of ['172.15.0.1', '172.32.0.1', '11.0.0.1', '192.169.0.1', '8.8.8.8', '2606:4700::1111', '127.0.0.999']) {
    assert.equal(clientKey(new Headers({ 'x-forwarded-for': addr })).scope, 'public', `${addr} must be public`);
  }
  // Hardening: an IPv4-mapped wrapper of private space is unwrapped and stays
  // local, while anything unparseable fails to the STRICTER scope — a parser
  // that answers "local" on input it did not understand would hand the big
  // budget to whoever can put junk in the last hop.
  for (const addr of ['::ffff:10.0.0.1', '::ffff:192.168.1.1', '[::ffff:127.0.0.1]']) {
    assert.equal(clientKey(new Headers({ 'x-forwarded-for': addr })).scope, 'local', `${addr} must be local`);
  }
  for (const addr of ['::ffff:999.1.1.1', '10.0.0.1:8080', 'not-an-ip']) {
    assert.equal(clientKey(new Headers({ 'x-forwarded-for': addr })).scope, 'public', `${addr} must fail strict`);
  }
  // No usable hop at all still means "nothing identified a remote client".
  assert.deepEqual(clientKey(new Headers()), { key: 'local', scope: 'local' });
  assert.deepEqual(clientKey(new Headers({ 'x-forwarded-for': '  ' })), { key: 'local', scope: 'local' });
  // A present CF header beats an XFF forged alongside it — the tunnel path, and
  // the reason a public caller cannot smuggle a loopback XFF into the local
  // scope by sending it through Cloudflare.
  assert.deepEqual(
    clientKey(new Headers({ 'cf-connecting-ip': '203.0.113.11', 'x-forwarded-for': '1.2.3.4' })),
    { key: '203.0.113.11', scope: 'public' },
  );
  assert.deepEqual(
    clientKey(new Headers({ 'cf-connecting-ip': '203.0.113.13', 'x-forwarded-for': '127.0.0.1' })),
    { key: '203.0.113.13', scope: 'public' },
  );
});
test('budget: a full harness run fits the local budget it is actually charged', () => {
  __resetRateLimit();
  // Measured 2026-09-29 over the full verify-cryptorank.py call table:
  // 53 calls = 137 units (chain x3 @20, converter @20, tag x3 @3, tags @2,
  // blockchains @2, everything else 1). Against the public heavy window (80)
  // the run was refused from call ~25; as local it must fit with room to
  // spare, because the operator's own verification may not be what breaks the
  // limiter that verification calibrated.
  const HARSH = 137;
  const localLimit = HEAVY_ALLOWANCE * LOCAL_MULTIPLIER;
  assert.ok(HARSH < localLimit, `a ${HARSH}-unit harness run must fit ${localLimit} local units`);
  __resetRateLimit();
  let spent = 0;
  for (const [path, mode, n] of [
    ['/api/cryptorank', 'chain', 3],
    ['/api/cryptorank', 'converter', 1],
    ['/api/cryptorank', 'tag', 3],
    ['/api/cryptorank', 'tags', 1],
    ['/api/cryptorank', 'blockchains', 1],
  ] as Array<[string, string, number]>) {
    for (let i = 0; i < n; i++) {
      const d = checkInbound('::ffff:127.0.0.1', path, { now: T0 + spent, scope: 'local', params: q(mode) });
      assert.equal(d.allowed, true, `${path}?mode=${mode} #${i + 1} must be served`);
      spent += d.cost;
    }
  }
  // Fill the remainder to the measured 137 units and confirm it still fits.
  const perCall = cost('/api/cryptorank', 'home');
  while (spent + perCall <= HARSH) {
    assert.equal(
      checkInbound('::ffff:127.0.0.1', '/api/cryptorank', { now: T0 + spent, scope: 'local', params: q('home') }).allowed,
      true,
    );
    spent += perCall;
  }
  assert.equal(spent, HARSH, `the harness mix must add up to the measured ${HARSH} units`);
  assert.equal(
    checkInbound('::ffff:127.0.0.1', '/api/cryptorank', { now: T0 + spent, scope: 'local', params: q('home') }).allowed,
    true,
    'a full harness run must not exhaust the local window',
  );
});
test('decision: every answer describes itself', () => {
  __resetRateLimit();
  const d = checkInbound('h1', '/api/dex', { now: T0 });
  for (const field of ['limit', 'remaining', 'cost', 'resetSeconds', 'retryAfterSeconds'] as const) {
    assert.equal(typeof d[field], 'number', `${field} must be a number`);
  }
  assert.equal(d.scope, 'public');
  assert.ok(d.remaining <= d.limit);
  assert.equal(d.remaining, d.limit - d.cost, 'the first request spends exactly its cost');
});

// --- outbound limiter (platform/http/rate-limit.ts) --------------------------
//
// The outbound limiter serialises every upstream call through ONE promise chain,
// so a fetch that never settles would stall the whole family, not just its own
// request. These prove the deadline is ALWAYS present -- with or without a
// caller-supplied signal -- without waiting on a real clock.
const realFetch = globalThis.fetch;
const stubFetch = (impl: typeof fetch) => {
  globalThis.fetch = impl;
};

test('outbound: a fetch always gets a deadline signal, even when the caller passes none', async () => {
  __resetLimiter();
  let seen: AbortSignal | null | undefined;
  stubFetch(((url: string, init?: RequestInit) => {
    seen = init?.signal;
    return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  }) as unknown as typeof fetch);
  try {
    await limitedFetch('http://example.test/no-signal');
    assert.ok(seen, 'the limiter must supply a deadline when the caller gives none');
    assert.ok(!seen!.aborted, 'a fresh deadline is not already aborted');
  } finally {
    globalThis.fetch = realFetch;
    __resetLimiter();
  }
});

test('outbound: a caller abort propagates through the composed signal', async () => {
  __resetLimiter();
  stubFetch(((url: string, init?: RequestInit) => {
    const sig = init?.signal;
    // Never settles on its own: only the composed abort can end it.
    return new Promise<Response>((_resolve, reject) => {
      sig?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  }) as unknown as typeof fetch);
  try {
    await assert.rejects(
      limitedFetch('http://example.test/caller-abort', { signal: AbortSignal.timeout(20) }),
      /abort/i,
    );
  } finally {
    globalThis.fetch = realFetch;
    __resetLimiter();
  }
});

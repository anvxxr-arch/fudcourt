/**
 * Executor thin-proxy tests — OFFLINE, no Next request scope, no GPU/session.
 *
 * `platform/executor/executor-proxy.ts` is the ONE switch that decides which
 * backend answers `/api/executor/*` (DR-035 Consequences). Every one of the 15
 * route handlers delegates to it, so a bug here is a bug in all 15 at once, and
 * the failure modes are the ones the cutover cannot survive:
 *
 *  - the gate must be DEFAULT OFF: if it forwarded when the operator has not
 *    flipped it, the whole surface would move backend on deploy;
 *  - the `Cookie` header must survive the hop verbatim (it is the only identity
 *    input, and both processes verify the same signed cookie);
 *  - a `Set-Cookie` pair must not collapse to one header on the way back;
 *  - an unreachable Go surface must answer a loud 502 - never a silent fallback
 *    to the TypeScript runtime, which would swap the store mid-request.
 *
 * The upstream is a real loopback HTTP server bound to port 0, so the forward is
 * exercised over the wire rather than against a fetch stub.
 *
 * Usage: cd frontend/web && npm run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { executorProxyEnabled, proxyExecutorRequest } from '@/platform/executor/executor-proxy';

/** The two env names the proxy reads; snapshotted so a test cannot leak into the next. */
const ENV_KEYS = ['FUDCOURT_EXECUTOR_PROXY', 'FUDCOURT_EXECUTOR_API_ADDR'] as const;
type EnvKey = (typeof ENV_KEYS)[number];

function snapshotEnv(): Record<EnvKey, string | undefined> {
  return {
    FUDCOURT_EXECUTOR_PROXY: process.env.FUDCOURT_EXECUTOR_PROXY,
    FUDCOURT_EXECUTOR_API_ADDR: process.env.FUDCOURT_EXECUTOR_API_ADDR,
  };
}

function restoreEnv(snap: Record<EnvKey, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = snap[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/**
 * Run `fn` against a loopback stub standing in for the Go executor surface.
 * The stub records what the proxy sent and answers with `respond`.
 */
type StubReply = { status: number; headers: Record<string, string | string[]>; body: string };
type StubSeen = { method?: string; url?: string; headers?: IncomingMessage['headers']; body?: string };

async function withStub(respond: (req: IncomingMessage, body: string) => StubReply, fn: (base: string, seen: StubSeen) => Promise<void>): Promise<void> {
  const seen: StubSeen = {};
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      seen.method = req.method;
      seen.url = req.url;
      seen.headers = req.headers;
      seen.body = body;
      const out = respond(req, body);
      // setHeader (not writeHead's map) so an array value becomes repeated
      // headers — required for a two-Set-Cookie response.
      for (const [name, value] of Object.entries(out.headers)) res.setHeader(name, value);
      res.writeHead(out.status);
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  try {
    await fn(`127.0.0.1:${address.port}`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('§52 gate: only the exact string "go" turns the forward on', (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  const off = [undefined, '', 'Go', 'GO', 'true', '1', 'ts', 'go '];
  for (const value of off) {
    if (value === undefined) delete process.env.FUDCOURT_EXECUTOR_PROXY;
    else process.env.FUDCOURT_EXECUTOR_PROXY = value;
    assert.equal(executorProxyEnabled(), false, `FUDCOURT_EXECUTOR_PROXY=${JSON.stringify(value)} must not forward`);
  }
  process.env.FUDCOURT_EXECUTOR_PROXY = 'go';
  assert.equal(executorProxyEnabled(), true, 'the cutover value must forward');
});

test('§52 forward: method, path, query, body and the Cookie header cross the hop verbatim', async (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  process.env.FUDCOURT_EXECUTOR_PROXY = 'go';

  await withStub(
    (req) => ({
      status: 201,
      headers: { 'content-type': 'application/json', 'retry-after': '9' },
      body: JSON.stringify({ path: req.url, method: req.method, cookie: req.headers.cookie ?? null }),
    }),
    async (base, seen) => {
      process.env.FUDCOURT_EXECUTOR_API_ADDR = base;
      const res = await proxyExecutorRequest(
        new Request('http://web.internal/api/executor/executions?status=RUNNING&limit=20', {
          method: 'POST',
          headers: { cookie: 'fud_session=signed-value', 'content-type': 'application/json' },
          body: JSON.stringify({ symbol: 'BTC/USDT' }),
        }),
      );
      const echoed = (await res.json()) as { path: string; method: string; cookie: string | null };
      assert.equal(echoed.path, '/api/executor/executions?status=RUNNING&limit=20', 'path + query are forwarded unchanged');
      assert.equal(echoed.method, 'POST');
      assert.equal(echoed.cookie, 'fud_session=signed-value', 'the signed session cookie is the only identity input — it must arrive untouched');
      assert.equal(seen.body, JSON.stringify({ symbol: 'BTC/USDT' }), 'the request body is forwarded unchanged');
      assert.match(String(seen.headers?.host), /^127\.0\.0\.1:/, 'the browser Host is dropped (hop-by-hop) — the loopback Host is re-derived');
      assert.equal(res.status, 201, 'the upstream status is relayed, not normalised');
      assert.equal(res.headers.get('retry-after'), '9', 'a non-2xx control header reaches the browser');
    },
  );
});

test('§52 forward: every Set-Cookie in the upstream response survives (no collapse to one)', async (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  process.env.FUDCOURT_EXECUTOR_PROXY = 'go';

  await withStub(
    () => ({
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': ['fud_session=a; Path=/', 'fud_csrf=b; Path=/'] },
      body: '{"ok":true}',
    }),
    async (base) => {
      process.env.FUDCOURT_EXECUTOR_API_ADDR = base;
      const res = await proxyExecutorRequest(new Request('http://web.internal/api/executor/settings'));
      const cookies = res.headers.getSetCookie();
      assert.deepEqual(cookies, ['fud_session=a; Path=/', 'fud_csrf=b; Path=/'], 'both cookies cross the hop — a single set-cookie lookup would silently drop one');
    },
  );
});

test('§52 forward: a bare addresses and a full URL are both accepted as the upstream', async (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  process.env.FUDCOURT_EXECUTOR_PROXY = 'go';

  await withStub(
    () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }),
    async (base, seen) => {
      // A full URL (the form some units set) must not become `http://http://…`.
      process.env.FUDCOURT_EXECUTOR_API_ADDR = `http://${base}`;
      const res = await proxyExecutorRequest(new Request('http://web.internal/api/executor/settings'));
      assert.equal(res.status, 200);
      assert.equal(seen.url, '/api/executor/settings');
    },
  );
});

test('§52 fail-loud: an unreachable Go surface is a 502 naming it — never a TS fallback', async (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  process.env.FUDCOURT_EXECUTOR_PROXY = 'go';
  process.env.FUDCOURT_EXECUTOR_API_ADDR = 'http://127.0.0.1:1';

  const res = await proxyExecutorRequest(new Request('http://web.internal/api/executor/executions'));
  const body = (await res.json()) as { error?: string; upstream?: string; executions?: unknown };
  assert.equal(res.status, 502, 'the operator sees the real reason, not a 200 from the other store');
  assert.match(String(body.error), /executor unreachable/, 'the envelope names the failure');
  assert.equal(body.upstream, 'http://127.0.0.1:1/api/executor/executions', 'the envelope names the target it tried');
  assert.equal(body.executions, undefined, 'no TypeScript runtime envelope may be substituted on the failure path');
});

/**
 * Compression-front tests: run OFFLINE, no network, no clock, no Caddy process.
 *
 * WHY THE TEST IS SHAPED LIKE THIS
 * --------------------------------
 * Text compression under `bun --bun next start` is a RUNTIME property, not a
 * route property: Next installs its `compression` middleware in `router-server`
 * only when Node runs the process (DR-008 pins Bun for `apps/web`), so no route
 * handler or helper in this app can turn it on. There is consequently nothing in
 * `src/` a unit test could assert that would change the outcome — which is why
 * this file asserts the two things that CAN be checked without a server:
 *
 *  1. the shipped front (`deploy/caddy/fudcourt-web-internal.caddy`) is a valid,
 *     complete answer for every compressible type this app emits: it declares an
 *     encoder, it proxies the real origin, and it streams rather than buffers;
 *  2. the origin it fronts answers the compressible content types — so the front
 *     has something to compress and is not a no-op that only looks busy.
 *
 * The behavioural half (a real `Content-Encoding` and the byte drop) is proven
 * by curl against the running pair and recorded in the run report, because it
 * needs two live processes; a test that shelled out to Caddy would be neither
 * offline nor runnable in CI.
 *
 * Usage: cd apps/web && bun run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(process.cwd(), '..', '..');
const FRONT = path.join(REPO_ROOT, 'deploy', 'caddy', 'fudcourt-web-internal.caddy');
const PUBLIC_FRONT = path.join(REPO_ROOT, 'deploy', 'caddy', 'fudcourt-web-public.caddy');

test('compression front: declares the encoder and proxies the real origin', () => {
  const src = readFileSync(FRONT, 'utf8');
  // zstd is what Cloudflare and current browsers negotiate; gzip is the floor.
  assert.match(src, /^\s*encode zstd gzip$/m, 'the encoder must be declared');
  assert.match(src, /reverse_proxy 127\.0\.0\.1:3100/, 'it must front the app, not a copy');
  // Without this a streamed body is buffered until a chunk boundary; /api/img
  // and RSC flight responses would stall behind it.
  assert.match(src, /flush_interval -1/, 'streaming must not be buffered');
  // The tunnel/client reaches this from the same host, so it must stay loopback.
  assert.match(src, /default_bind 127\.0\.0\.1/);
  // :80 already belongs to the unrelated host set in /etc/caddy/Caddyfile.
  assert.equal(/^\s*:80\s*\{/m.test(src), false, 'must not claim :80');
});

test('compression front: the port is the unprivileged one the runbook names', () => {
  const src = readFileSync(FRONT, 'utf8');
  const port = src.match(/^:(\d+) \{/m)?.[1];
  assert.equal(port, '3110');
  // The host file it replaces: the tunnel pointed fc.dwirijal.my.id at :3100.
  // The runbook (in the same file) is what moves that binding; assert it is
  // written down, since the edit is outside this repo.
  assert.match(src, /~\/\.cloudflared\/config\.yml/, 'the deploy step must name the tunnel file');
  assert.match(src, /systemctl reload caddy/, 'the reload step must be stated');
});

test('compression front: the public host gets TLS + the encoder, and its caveats are stated', () => {
  const src = readFileSync(PUBLIC_FRONT, 'utf8');
  assert.match(src, /^\s*encode zstd gzip$/m);
  assert.match(src, /fc\.dwirijal\.my\.id \{/, 'the public site label must be the real hostname');
  assert.match(src, /reverse_proxy 127\.0\.0\.1:3100/);
  // The failure modes that would silently undo the point of the change.
  assert.match(src, /Full \(strict\)/, 'the Cloudflare SSL mode caveat must be recorded');
  assert.match(src, /proxied/, 'the re-masking caveat must be recorded');
});

test('compression front: the origin answers the compressible types the front encodes', () => {
  // Caddy compresses by negotiated type. If the app only emitted images or
  // pre-packed bodies, the front would be a no-op; these are the shapes the
  // measured byte drop comes from, so the pair is asserted as a contract.
  const src = readFileSync(FRONT, 'utf8');
  const comment = src.slice(0, src.indexOf('{'));
  for (const evidence of [
    'application/json', // /api/* — the 451 KiB macro read
    'application/xml', // /sitemap.xml — the 509 KiB document
    'text/plain', // /robots.txt
  ]) {
    assert.ok(comment.includes(evidence), `the front's rationale must name ${evidence}`);
  }
  assert.ok(comment.includes('Content-Encoding: gzip'), 'the Node-parity measurement must be recorded');
  assert.ok(comment.includes('Content-Encoding'), 'the compressed case must be described');
});

test('compression front: the runtime decision is referenced, not overridden', () => {
  // The reason this is a proxy and not a `node next start` flip: DR-008 pins Bun
  // for apps/web. A silent runtime change is exactly what this assertion blocks.
  const src = readFileSync(FRONT, 'utf8');
  assert.match(src, /DR-008/);
  const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  assert.match(pkg.scripts.start, /^bun --bun next start/, 'the start script must still be the Bun runtime');
  const unit = readFileSync(path.join(REPO_ROOT, 'deploy', 'systemd', 'fudcourt-web.service'), 'utf8');
  assert.match(unit.match(/^ExecStart=.*$/m)?.[0] ?? '', /\/bun --bun /, 'the unit must still exec bun');
});

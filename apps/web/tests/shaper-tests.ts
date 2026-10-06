/**
 * Shaper unit tests (SG-4.1): run OFFLINE against recorded upstream fixtures.
 *
 * Contract under test (house rules, see lib/shapers.ts):
 *  - absent upstream metric -> null (UI renders em-dash). Never 0, never faked.
 *  - an envelope must round-trip through JSON identically: no `undefined`, no
 *    NaN/Infinity anywhere in the graph (those silently vanish or corrupt).
 *  - count must always equal the rows actually shipped.
 *  - EMPTY upstream payload must NOT invent rows (fabrication probe).
 *  - every fixture is pinned by sha256 in MANIFEST.json: a hand-edited fixture
 *    fails the tamper check, so a green suite cannot be bought by editing data.
 *
 * Usage: cd apps/web && npm run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CR_DISABLED, CR_MODES, CR_MODE_UPSTREAM, envelope, type CrLiveMode, type HelperOut } from '@/features/cryptorank';

// The fixtures moved out of apps/web (spec Phase 7): they are shared by the web
// shaper suites, the TS fixture tools and the Go parity gate, so they now live at
// the repo-root tests/fixtures. process.cwd() is apps/web (test:shapers runs
// there), so the tree is two levels up.
const FIX = path.join(process.cwd(), '..', '..', 'tests', 'fixtures');
const live = (CR_MODES as readonly string[])
  .filter((m) => !(CR_DISABLED as readonly string[]).includes(m)) as CrLiveMode[];

type Manifest = {
  liveModes: number;
  modes: Record<string, { gzBytes: number; jsonBytes: number; sha256: string; status?: number; flag: string; upstreamPath: string }>;
};

const manifest: Manifest = JSON.parse(readFileSync(path.join(FIX, 'MANIFEST.json'), 'utf8')) as Manifest;

function rawBytes(mode: string): Buffer {
  return gunzipSync(readFileSync(path.join(FIX, `${mode}.json.gz`)));
}

function fixture(mode: string): HelperOut {
  return JSON.parse(rawBytes(mode).toString('utf8')) as HelperOut;
}

/** Walk the whole object graph; anything that JSON cannot represent faithfully is a bug. */
function scanBad(v: unknown, trail = '$', out: string[] = []): string[] {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) out.push(`${trail}: NaN`);
    else if (!Number.isFinite(v)) out.push(`${trail}: ${String(v)}`);
    return out;
  }
  if (typeof v === 'undefined') {
    out.push(`${trail}: undefined`);
    return out;
  }
  if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') {
    out.push(`${trail}: ${typeof v}`);
    return out;
  }
  if (Array.isArray(v)) {
    v.forEach((item, i) => scanBad(item, `${trail}[${i}]`, out));
    return out;
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) scanBad(val, `${trail}.${k}`, out);
  }
  return out;
}

test('fixtures: every live mode has a recorded fixture + manifest entry', () => {
  assert.ok(existsSync(FIX), `fixtures dir missing: ${FIX}`);
  const missing = live.filter((m) => !existsSync(path.join(FIX, `${m}.json.gz`)) || !manifest.modes[m]);
  assert.deepEqual(missing, [], `live modes without a fixture: ${missing.join(', ')}`);
  assert.equal(manifest.liveModes, live.length);
});

test('fixtures: sha256 matches MANIFEST (tamper-evident, never hand-edited)', () => {
  for (const mode of live) {
    const bytes = rawBytes(mode);
    const got = createHash('sha256').update(bytes).digest('hex');
    assert.equal(got, manifest.modes[mode].sha256, `${mode}.json.gz sha256 drift (fixture edited without re-recording)`);
    assert.equal(bytes.length, manifest.modes[mode].jsonBytes, `${mode}.json.gz payload length drift`);
  }
});

test('fixtures: recorded payloads are real 200s (never a wall/decoy save)', () => {
  for (const mode of live) {
    const h = fixture(mode);
    assert.equal(h.ok, true, `${mode}: fixture ok !== true`);
    assert.equal(h.status, 200, `${mode}: fixture status !== 200`);
    assert.equal(typeof h.fetchedAt, 'number', `${mode}: fixture has no real fetchedAt`);
  }
});

for (const mode of live) {
  test(`shaper ${mode}: envelope is faithful, consistent and JSON-clean`, () => {
    const h = fixture(mode);
    const env = envelope(mode, h);

    assert.equal(env.kind, mode);
    assert.equal(typeof env.upstream, 'string');
    assert.ok(env.upstream.length > 0, 'upstream label empty');
    assert.equal(typeof env.fetchedAt, 'number');

    // recorder fidelity: the fixture was fetched from the same resource the
    // route maps for this mode (recorder and route cannot silently diverge)
    const recorded = manifest.modes[mode].upstreamPath;
    const mapped = CR_MODE_UPSTREAM[mode];
    assert.ok(
      env.upstream === mapped || env.upstream.endsWith(recorded),
      `upstream mismatch: route=${env.upstream} mapped=${mapped} recorded=${recorded}`,
    );

    const bad = scanBad(env);
    assert.deepEqual(bad, [], `non-JSON-representable values: ${bad.slice(0, 5).join(' | ')}`);

    // round-trip: unchanged through JSON (catches undefined/NaN drops)
    assert.deepEqual(JSON.parse(JSON.stringify(env)), env, 'envelope does not survive a JSON round-trip');

    // count consistency: what the UI labels "N" must be the rows actually shipped
    const rows = (env as { rows?: unknown[] }).rows;
    if (rows !== undefined) {
      assert.equal(env.count, rows.length, 'count !== rows.length');
      assert.ok(rows.length > 0, `${mode}: recorded live payload produced 0 rows`);
      assert.deepEqual(scanBad(rows), [], 'row graph contains non-JSON values');
    }
  });

  test(`shaper ${mode}: empty upstream invents nothing (fabrication probe)`, () => {
    const probes: HelperOut[] = [
      { ok: true, status: 200, pageProps: {}, fetchedAt: 1 },
      { ok: true, status: 200, fetchedAt: 1 },
    ];
    for (const probe of probes) {
      // Measured shaper contract: a structurally-empty upstream either yields
      // an EMPTY envelope (count 0) or throws naming what upstream withheld.
      // What must never happen: rows, or a count, invented from nothing.
      let env: { count?: number; rows?: unknown[] } | null = null;
      let err: unknown = null;
      try {
        env = envelope(mode, probe) as unknown as { count?: number; rows?: unknown[] };
      } catch (e) {
        err = e;
      }
      if (err) {
        const msg = String((err as Error)?.message ?? err);
        assert.ok(msg.length > 0, `${mode}: refusal must carry a message`);
        assert.ok(
          /missing|absent|no |empty|invalid|unknown/i.test(msg),
          `${mode}: refusal must name the withheld upstream data, got: ${msg}`,
        );
        assert.deepEqual(scanBad(err), [], `${mode}: refusal itself must be JSON-clean`);
        continue;
      }
      assert.ok(env, `${mode}: neither envelope nor loud refusal`);
      if (env.rows !== undefined) {
        assert.equal(env.rows.length, 0, 'empty upstream fabricated rows');
        assert.equal(env.count, 0, 'empty upstream fabricated a count');
      }
      assert.deepEqual(scanBad(env), [], 'empty-upstream envelope is not JSON-clean');
    }
  });
}

test('shapers: disabled modes are not in the live fixture set', () => {
  for (const d of CR_DISABLED as readonly string[]) {
    assert.ok(!existsSync(path.join(FIX, `${d}.json.gz`)), `${d} is CR_DISABLED but has a fixture`);
  }
});

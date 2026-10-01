/**
 * Freezes the CURRENT TypeScript envelope() output for every recorded upstream
 * fixture (SG-4.1) into tests/fixtures/expected/<mode>.json.
 *
 * Why: the CryptoRank proxy is being ported to Go. The port needs a frozen,
 * machine-checkable oracle: for each recorded HelperOut payload, the exact JSON
 * the live route ships today. This script is the only producer of that oracle,
 * so the Go service and the TS route are diffed against one artifact.
 *
 * Fidelity rules (mirrors app/api/cryptorank/route.ts GET exactly):
 *  - opts.key = the route's DEFAULT key for that mode, because the recorded
 *    fixtures are the recorder's default-key fetches (record-fixtures.ts
 *    resolveArgs is the same resolution). key drives real branches inside
 *    envelope() (exchanges venue wording, launchpool/nodesale variant), so it
 *    is not cosmetic.
 *  - opts.upstream = CR_MODE_UPSTREAM[mode], i.e. what the route leaves in
 *    place when no key is supplied over the wire.
 *  - nothing here touches a shaper to make a fixture pass: if envelope()
 *    refuses loudly (its missing-slice arms), that refusal is printed and the
 *    run exits non-zero. Real behaviour is the deliverable.
 *
 * Output is byte-stable: pretty-printed 2-space, object keys sorted recursively,
 * no undefined/NaN/Infinity (throws instead of silently dropping), and every
 * number verified to survive a JSON round-trip unchanged.
 *
 * Usage: cd frontend/web && npm run dump:envelopes
 *   (Same tsc -> node pattern as test:shapers / record:fixtures: plain
 *    `node scripts/tools/dump-envelopes.ts` cannot resolve the extensionless
 *    `../lib/cryptorank` / `../lib/shapers` imports. Equivalent one-liner:
 *      npx tsc lib/shapers.ts lib/cryptorank.ts scripts/tools/dump-envelopes.ts \
 *        --outDir .shaper-tests --module commonjs --moduleResolution node \
 *        --target es2020 --esModuleInterop --skipLibCheck --types node --noEmitOnError \
 *      && node .shaper-tests/scripts/tools/dump-envelopes.js
 *    then read the written files.)
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  CR_BASE,
  CR_DEFAULT_EXCHANGE,
  CR_DEFAULT_KEYS,
  CR_DEFAULT_LP,
  CR_DEFAULT_ND,
  CR_DISABLED,
  CR_KEYED_PATHS,
  CR_MODES,
  CR_MODE_ARGS,
  CR_MODE_UPSTREAM,
  type CrLiveMode,
} from '@/features/cryptorank/client';
import { envelope, type HelperOut } from '@/features/cryptorank/shapers';

// The fixtures moved to the repo-root tests/fixtures (spec Phase 7); process.cwd()
// is frontend/web, so the shared tree is two levels up.
const FIX = path.join(process.cwd(), '..', '..', 'tests', 'fixtures');
const OUT = path.join(FIX, 'expected');

type ManifestMode = {
  flag: string;
  upstreamPath: string;
  upstreamUrl: string;
  status?: number;
  file: string;
  gzBytes: number;
  jsonBytes: number;
  sha256: string;
};
type Manifest = { liveModes: number; modes: Record<string, ManifestMode> };

/**
 * The route's default key resolution, verbatim: keyed modes via
 * CR_KEYED_PATHS + CR_DEFAULT_KEYS, the three whitelisted list modes via their
 * default variant, everything else keyless. Returns the same value the
 * recorder fetched (asserted against CR_MODE_UPSTREAM below).
 */
function routeDefaults(mode: CrLiveMode): { key?: string; value: string; upstream: string } {
  let key: string | undefined;
  let value: string = CR_MODE_ARGS[mode][1];
  if (mode in CR_KEYED_PATHS) {
    const keyed = mode as keyof typeof CR_KEYED_PATHS;
    key = CR_DEFAULT_KEYS[keyed];
    value = CR_KEYED_PATHS[keyed](key);
  } else if (mode === 'exchanges') {
    key = CR_DEFAULT_EXCHANGE;
    value = `/exchanges/${key}`;
  } else if (mode === 'launchpool') {
    key = CR_DEFAULT_LP;
    value =
      key === 'upcoming' ? '/upcoming-launchpool' : key === 'active' ? '/active-launchpool' : '/past-launchpool';
  } else if (mode === 'nodesale') {
    key = CR_DEFAULT_ND;
    value =
      key === 'upcoming' ? '/upcoming-nodesale' : key === 'active' ? '/active-nodesale' : '/past-nodesale';
  }
  // Route invariant: with the default key in play, the mapped path IS the
  // canonical upstream URL. If this ever drifts the oracle would encode a
  // fetch the route never makes.
  const upstream = CR_MODE_UPSTREAM[mode];
  if (`${CR_BASE}${value}` !== upstream) {
    throw new Error(`${mode}: route default path ${value} != CR_MODE_UPSTREAM (${upstream})`);
  }
  return { key, value, upstream };
}

/** Recursively re-key objects; refuse anything JSON cannot carry faithfully. */
function sorted(v: unknown, trail = '$'): unknown {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`${trail}: non-finite number (${String(v)})`);
    return v;
  }
  if (typeof v === 'string' || typeof v === 'boolean' || v === null) return v;
  if (Array.isArray(v)) return v.map((item, i) => sorted(item, `${trail}[${i}]`));
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sorted(src[k], `${trail}.${k}`);
    return out;
  }
  throw new Error(`${trail}: not JSON-representable (${v === undefined ? 'undefined' : typeof v})`);
}

function main(): void {
  const manifest = JSON.parse(readFileSync(path.join(FIX, 'MANIFEST.json'), 'utf8')) as Manifest;
  mkdirSync(OUT, { recursive: true });

  const onDisk = readdirSync(FIX)
    .filter((f) => f.endsWith('.json.gz'))
    .map((f) => f.slice(0, -'.json.gz'.length))
    .sort();
  const declared = Object.keys(manifest.modes).sort();
  if (JSON.stringify(onDisk) !== JSON.stringify(declared)) {
    throw new Error(`fixture set != MANIFEST.modes\n  disk:     ${onDisk.join(', ')}\n  manifest: ${declared.join(', ')}`);
  }
  if (manifest.liveModes !== declared.length) {
    throw new Error(`MANIFEST.liveModes=${manifest.liveModes} but ${declared.length} mode entries`);
  }

  const failures: { mode: string; message: string }[] = [];
  console.log('mode         count  bytes    sha256');
  for (const mode of declared) {
    const m = manifest.modes[mode];
    try {
      if (!(CR_MODES as readonly string[]).includes(mode)) throw new Error(`mode ${mode} is not in CR_MODES`);
      if ((CR_DISABLED as readonly string[]).includes(mode)) throw new Error(`mode ${mode} is CR_DISABLED (no live envelope)`);
      const live = mode as CrLiveMode;

      // Fixture is the pinned recorder payload, not a hand-edited one.
      const raw = gunzipSync(readFileSync(path.join(FIX, m.file)));
      const sha = createHash('sha256').update(raw).digest('hex');
      if (sha !== m.sha256) throw new Error(`fixture ${m.file} sha256 ${sha} != MANIFEST ${m.sha256}`);
      if (raw.length !== m.jsonBytes) throw new Error(`fixture ${m.file} is ${raw.length}B, MANIFEST says ${m.jsonBytes}B`);

      const h = JSON.parse(raw.toString('utf8')) as HelperOut;
      // A missing fetchedAt/cache would make envelope() fall back to Date.now()
      // and the oracle would stop being byte-stable between runs.
      if (typeof h.fetchedAt !== 'number') throw new Error('fixture has no numeric fetchedAt (oracle would not be stable)');
      if (typeof h.cache !== 'string') throw new Error('fixture has no cache field (oracle would not be stable)');

      const { key, value, upstream } = routeDefaults(live);
      if (m.upstreamPath !== value) {
        throw new Error(`MANIFEST upstreamPath ${m.upstreamPath} != route default path ${value}`);
      }

      const env = envelope(live, h, { key, upstream });
      const out = sorted(env);
      const text = `${JSON.stringify(out, null, 2)}\n`;
      const back = JSON.parse(text) as unknown;
      if (!isDeepStrictEqual(back, out)) throw new Error('envelope lost precision through JSON (round-trip mismatch)');

      writeFileSync(path.join(OUT, `${mode}.json`), text);
      const count = typeof env.count === 'number' ? String(env.count) : 'n/a';
      console.log(
        `${mode.padEnd(12)} ${count.padStart(5)}  ${String(Buffer.byteLength(text)).padStart(6)}  ` +
          `${createHash('sha256').update(text).digest('hex')}`,
      );
    } catch (e) {
      failures.push({ mode, message: String((e as Error)?.message ?? e) });
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} fixture(s) failed to shape:`);
    for (const f of failures) console.error(`  ${f.mode}: ${f.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n${declared.length} modes -> ${path.relative(process.cwd(), OUT)}`);
}

try {
  main();
} catch (e) {
  console.error(`dump-envelopes: ${String((e as Error)?.message ?? e)}`);
  process.exitCode = 1;
}

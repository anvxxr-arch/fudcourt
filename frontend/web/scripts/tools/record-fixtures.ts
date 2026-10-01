/**
 * Records REAL CryptoRank upstream payloads into tests/fixtures/ (SG-4.1).
 *
 * Why: the shaper unit tests (frontend/web/tests/shaper-tests.ts) must run offline and
 * deterministically against the exact HelperOut shape the live route receives,
 * so upstream template drift shows up as a failing test instead of a silent
 * UI change. A fixture is the helper's raw stdout JSON, byte-for-byte -- never
 * hand-written, never trimmed. MANIFEST.json carries the sha256 of every file
 * so a hand-edited fixture fails the tamper check.
 *
 * Usage (fresh upstream fetch, per-mode default key):
 *   cd frontend/web && npx tsc lib/cryptorank.ts scripts/tools/record-fixtures.ts \
 *     --outDir .shaper-tests --module commonjs --moduleResolution node \
 *     --target es2020 --esModuleInterop --skipLibCheck --types node --noEmitOnError \
 *   && node .shaper-tests/scripts/tools/record-fixtures.js
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CR_DEFAULT_EXCHANGE,
  CR_DEFAULT_KEYS,
  CR_DEFAULT_LP,
  CR_DEFAULT_ND,
  CR_DISABLED,
  CR_KEYED_PATHS,
  CR_MODE_ARGS,
  CR_MODE_UPSTREAM,
  CR_MODES,
} from '@/features/cryptorank/client';

const PYTHON = process.env.CR_PYTHON ?? '/home/dwizzy/.venvs/crfetch/bin/python';
// The oracle and the recorded fixtures moved out of frontend/web in the Phase 7
// relocation: tests/oracle/cr_fetch.py and tests/fixtures (shared with the Go
// parity gate). process.cwd() is frontend/web.
const HELPER = path.join(process.cwd(), '..', '..', 'tests', 'oracle', 'cr_fetch.py');
const OUT = path.join(process.cwd(), '..', '..', 'tests', 'fixtures');

type KeyedMode = keyof typeof CR_KEYED_PATHS;
type ModeKey = keyof typeof CR_MODE_ARGS;

/**
 * Mirrors the route's default resolution exactly (route.ts GET): keyed modes
 * via CR_KEYED_PATHS + CR_DEFAULT_KEYS, explicit-list modes via their
 * whitelisted default, everything else straight from CR_MODE_ARGS.
 */
function resolveArgs(mode: string): { flag: '--path' | '--data-route'; value: string } {
  const m = mode as ModeKey;
  if (mode in CR_KEYED_PATHS) {
    const k = mode as KeyedMode;
    return { flag: CR_MODE_ARGS[m][0], value: CR_KEYED_PATHS[k](CR_DEFAULT_KEYS[k]) };
  }
  if (mode === 'exchanges') {
    return { flag: CR_MODE_ARGS[m][0], value: `/exchanges/${CR_DEFAULT_EXCHANGE}` };
  }
  if (mode === 'launchpool') {
    const v =
      CR_DEFAULT_LP === 'upcoming'
        ? '/upcoming-launchpool'
        : CR_DEFAULT_LP === 'active'
          ? '/active-launchpool'
          : '/past-launchpool';
    return { flag: CR_MODE_ARGS[m][0], value: v };
  }
  if (mode === 'nodesale') {
    const v =
      CR_DEFAULT_ND === 'upcoming'
        ? '/upcoming-nodesale'
        : CR_DEFAULT_ND === 'active'
          ? '/active-nodesale'
          : '/past-nodesale';
    return { flag: CR_MODE_ARGS[m][0], value: v };
  }
  return { flag: CR_MODE_ARGS[m][0], value: CR_MODE_ARGS[m][1] };
}

function fetchOnce(flag: string, value: string): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON,
      [HELPER, flag, value, '--ttl', '0'],
      { timeout: 90_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!stdout) {
          reject(new Error(`no stdout (${err ? String(err.message) : ''}) ${String(stderr).slice(-200)}`));
          return;
        }
        resolve({ stdout });
      },
    );
  });
}

/** Same transient-wall policy as the route: 429 is a hiccup, retry the same fetch. */
async function fetchWithRetry(flag: string, value: string): Promise<{ stdout: string; attempts: number }> {
  let last = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    const { stdout } = await fetchOnce(flag, value);
    const parsed = JSON.parse(stdout) as { ok?: boolean; status?: number };
    if (parsed.ok || parsed.status !== 429) return { stdout, attempts: attempt };
    last = stdout;
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
  return { stdout: last, attempts: 4 };
}

async function main() {
const live = (CR_MODES as readonly string[]).filter(
  (m) => !(CR_DISABLED as readonly string[]).includes(m),
);

mkdirSync(OUT, { recursive: true });
const manifest: Record<string, unknown> = {
  source: 'scripts/tools/record-fixtures.ts',
  recorder: 'frontend/web/scripts/tools/record-fixtures.ts',
  note: 'raw HelperOut stdout per mode, byte-for-byte, stored gzipped; sha256 is over the RAW json bytes (tamper-evidence)',
  recordedAt: Math.floor(Date.now() / 1000),
  python: PYTHON,
  liveModes: live.length,
  modes: {} as Record<string, unknown>,
};
const modes: Record<string, unknown> = manifest.modes as Record<string, unknown>;

let failures = 0;
for (const mode of live) {
  const { flag, value } = resolveArgs(mode);
  process.stdout.write(`${mode.padEnd(12)} ${flag} ${value} ... `);
  try {
    const { stdout, attempts } = await fetchWithRetry(flag, value);
    const parsed = JSON.parse(stdout) as {
      ok?: boolean;
      status?: number;
      fetchedAt?: number;
      route?: string;
      path?: string;
    };
    if (!parsed.ok) {
      failures += 1;
      console.log(`FAIL (status=${parsed.status ?? '?'} attempts=${attempts})`);
      continue;
    }
    const bytes = Buffer.from(stdout, 'utf8');
    // stored gzipped (repo hygiene: raw payloads total ~8 MiB); the sha256 in
    // the manifest is over the RAW json bytes, so tamper-evidence survives
    const gz = gzipSync(bytes, { level: 9 });
    writeFileSync(path.join(OUT, `${mode}.json.gz`), gz);
    modes[mode] = {
      flag,
      upstreamPath: value,
      upstreamUrl: `${CR_MODE_UPSTREAM[mode as ModeKey]}`,
      status: parsed.status,
      route: parsed.route,
      fetchedAt: parsed.fetchedAt,
      file: `${mode}.json.gz`,
      gzBytes: gz.length,
      jsonBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      attempts,
    };
    console.log(`ok ${(bytes.length / 1024).toFixed(1)} KiB -> gz ${(gz.length / 1024).toFixed(1)} KiB`);
  } catch (e) {
    failures += 1;
    console.log(`FAIL ${String(e).slice(0, 160)}`);
  }
}
writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`\nrecorded ${Object.keys(modes).length}/${live.length} fixtures, ${failures} failed`);
if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`record-fixtures crashed: ${String(e)}`);
  process.exit(1);
});

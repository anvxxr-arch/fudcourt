#!/usr/bin/env node
/**
 * tools/fud.ts — the one command surface for this repository.
 *
 *   node tools/fud.ts verify          # every offline gate (the canonical green check)
 *   node tools/fud.ts contracts       # the four contract drift gates
 *   node tools/fud.ts deploy          # the systemd unit guard
 *   node tools/fud.ts test [go|web|sync]
 *   node tools/fud.ts structure       # the frontend DR-018 structure gate
 *
 * Also runs under bun (`bun tools/fud.ts verify`) — the file is plain ESM
 * TypeScript with no imports beyond node builtins, so either runtime works and
 * neither needs a dependency install.
 *
 * WHY THIS EXISTS. The gates were already good; they were just scattered.
 * "Is the tree green?" meant knowing that the offline suite lives in
 * scripts/verify/verify-all.sh, that the structure gate is a python file under
 * apps/web/scripts/checks, that the deploy guard is another python file, and
 * that the contract gates are four node scripts under contracts/scripts. This
 * file is a dispatcher over those same gates — it reimplements none of them.
 * Every subcommand shells out to the script that already owns the check, so
 * there is exactly one implementation of each gate and one place to read about
 * all of them.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not run the live/network harnesses
 * (scripts/verify/verify-*.py, the FUDCOURT_DATA_LIVE=1 Go tests, real exchange
 * calls). Those touch upstreams and are slow; they stay manual, exactly as
 * verify-all.sh has always documented.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Run one command, streaming its output, and report pass/fail. */
function run(label: string, cmd: string, args: string[], cwd = ROOT): boolean {
  process.stdout.write(`\n== ${label}\n`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) {
    process.stdout.write(`!! FAILED: ${label}\n`);
    return false;
  }
  return true;
}

/**
 * The offline suite. This is the same ordered list scripts/verify/verify-all.sh
 * carries; the shell script stays the authority for the *order and the failure
 * policy*, and this subcommand delegates to it rather than forking the list.
 */
function verify(): boolean {
  return run('offline verification suite', 'bash', [path.join(ROOT, 'scripts/verify/verify-all.sh')]);
}

/** The four contract drift gates. */
function contracts(): boolean {
  const g = path.join(ROOT, 'contracts/scripts');
  let ok = true;
  ok = run('contract drift (enums, openapi, events, routes)', 'node', [path.join(g, 'check-contract.mjs')]) && ok;
  ok = run('schema tree (refs, $id, README index)', 'node', [path.join(g, 'check-schemas.mjs')]) && ok;
  ok = run('doc citations (every cited path resolves)', 'node', [path.join(g, 'check-doc-citations.mjs')]) && ok;
  ok = run('markdown table shape', 'node', [path.join(g, 'check-table-shape.mjs')]) && ok;
  return ok;
}

/** The systemd unit guard: ExecStart paths exist, timer pairs present. */
function deploy(): boolean {
  return run('deploy unit guard', 'python3', [path.join(ROOT, 'scripts/verify/check-deploy.py')]);
}

/** The frontend structure gate (DR-018). */
function structure(): boolean {
  return run('frontend structure gate', 'python3', [path.join(ROOT, 'apps/web/scripts/checks/check-structure.py')]);
}

/** Test suites. No argument runs all three. */
function test(which?: string): boolean {
  let ok = true;
  if (!which || which === 'go') {
    ok = run('go build/vet/test', 'go', ['test', './...']) && ok;
  }
  if (!which || which === 'web') {
    ok = run('web typecheck + shaper tests', 'bun', ['run', 'test:shapers'], path.join(ROOT, 'apps/web')) && ok;
  }
  if (!which || which === 'sync') {
    ok = run('rust reconciler', 'cargo', ['test', '--release'], path.join(ROOT, 'apps/reconciler')) && ok;
  }
  return ok;
}

const USAGE = `fud — the FUDCourt command surface

  node tools/fud.ts verify            every offline gate (the canonical green check)
  node tools/fud.ts contracts         the four contract drift gates
  node tools/fud.ts deploy            the systemd unit guard
  node tools/fud.ts structure         the frontend DR-018 structure gate
  node tools/fud.ts test [go|web|sync]   test suites (all three when omitted)

Every subcommand delegates to the script that already owns the check; none of
them is reimplemented here. Live/network harnesses stay manual on purpose.
`;

const [command, argument] = process.argv.slice(2);
let ok: boolean;
switch (command) {
  case 'verify': ok = verify(); break;
  case 'contracts': ok = contracts(); break;
  case 'deploy': ok = deploy(); break;
  case 'structure': ok = structure(); break;
  case 'test': ok = test(argument); break;
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    process.stdout.write(USAGE);
    ok = true;
    break;
  default:
    process.stderr.write(`fud: unknown command '${command}'\n\n${USAGE}`);
    ok = false;
}

process.exit(ok ? 0 : 1);

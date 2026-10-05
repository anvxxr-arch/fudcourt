#!/usr/bin/env node
/**
 * check-schemas.mjs — offline drift gate for the canonical JSON-Schema tree
 * (shared/contracts/schemas/**), the counterpart of check-contract.mjs (which pins
 * openapi/events/executor types). Same verdict idiom: collect every failure, print
 * one `SCHEMA_FAIL <file>: <reason>` line per failure and exit 1; print a single
 * `SCHEMAS_OK files=<N> refs=<M> enums=<E>` summary on success.
 *
 *   node shared/contracts/scripts/check-schemas.mjs            # the repo tree
 *   node shared/contracts/scripts/check-schemas.mjs --root D   # hermetic copy at D
 *
 * `--root D` reads `D/shared/contracts/schemas/**` and `D/shared/contracts/schemas/
 * README.md`, so the gate can be proven to fail against a perturbed copy without
 * touching the repository. It is also what makes every check below demonstrable.
 *
 * WHAT IT CHECKS
 *   1. every schemas/**\/*.json parses as JSON;
 *   2. every file declares `$schema` as the 2020-12 dialect AND `$id` exactly
 *      `https://fudcourt.local/contracts/schemas/<path-relative-to-schemas/>`;
 *   3. every local `$ref` resolves: the relative file exists AND its `#/...` JSON
 *      pointer lands on a real node (pointer walker below, incl. ~0/~1 unescaping
 *      and array indices). `$ref`s that are neither `#...` nor a relative path are
 *      external and are a FAILURE unless listed in EXTERNAL_REF_ALLOWANCE (empty);
 *   4. no dangling `$ref`: every failure names the referring file + the exact
 *      pointer and the missing target;
 *   5. README.md index <-> disk drift, BOTH directions: every `*.json` under
 *      schemas/ (excluding README and the two pre-existing envelopes) is linked
 *      from README.md, and every README link to a schemas-relative `*.json`
 *      resolves to a real file. This is the check that stops the catalog rotting;
 *   6. structural sanity: `type` or `$defs` present; every `enum` is a non-empty
 *      array of UNIQUE SCALARS; every object-typed schema states
 *      `additionalProperties` explicitly (boolean or schema).
 *
 * NAMED EXEMPTIONS (kept explicit, so a future failure cannot be explained away as
 * "probably an exemption"):
 *   - JSON parsing / dialect / $id / ref / enum / additionalProperties checks apply
 *     to the pre-existing `error-envelope.json` and `event-envelope.json` TOO:
 *     both already conform (verified), so there is NO exemption for them.
 *   - `README.md` is the index, not a schema: it is excluded from checks 1-4 and 6
 *     (it is an input to check 5 only).
 *   - DEFS_ONLY_CARRIERS below list files that legitimately carry no root `type`
 *     (pure `$ref` aliases composing another file). They are allowed to omit `type`
 *     only if they have neither `type` nor `$defs AND` they are exactly these
 *     five files; any OTHER file without a `type` fails check 6.
 *   - EXTERNAL_REF_ALLOWANCE is empty: no external `$ref` is permitted today.
 *
 * INITIAL STATE OF THE TREE (recorded 2026-10-01, deliberately in the header so the
 * README's §5 "not covered by a gate yet" claim and this gate's verdict are
 * comparable): 56 JSON files, 344 `$ref`s, all local; no drift in either direction
 * between README.md and disk. The five aliases have NO `type` (they are object
 * schemas carried by `$ref`); no check is relaxed for them beyond omitting `type`.
 *
 * DROPPED CHECKS (nothing shipped that cannot fail): none. Every check above is
 * implemented with node builtins only.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { repoRoot as discoverRepoRoot } from './lib.mjs';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
let repoRoot = discoverRepoRoot();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root') {
    const v = argv[i + 1];
    if (!v) {
      console.log('SCHEMA_FAIL --root: missing directory argument');
      process.exit(1);
    }
    repoRoot = path.resolve(v);
    i++;
  } else {
    console.log(`SCHEMA_FAIL argv: unknown argument '${argv[i]}' (only --root <dir> is accepted)`);
    process.exit(1);
  }
}
const SCHEMAS_DIR = path.join(repoRoot, 'shared', 'contracts', 'schemas');
const README = path.join(SCHEMAS_DIR, 'README.md');
const ID_PREFIX = 'https://fudcourt.local/contracts/schemas/';
const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const PREEXISTING_ENVELOPES = new Set(['error-envelope.json', 'event-envelope.json']);
const DEFS_ONLY_CARRIERS = new Set([
  'common/money.json',
  'common/percentage.json',
  'common/price.json',
  'common/quantity.json',
  'common/ratio.json',
]);
const EXTERNAL_REF_ALLOWANCE = [];

const failures = [];
const fail = (file, reason) => failures.push(`SCHEMA_FAIL ${file}: ${reason}`);

// ---------------------------------------------------------------------------
// Walk helpers
// ---------------------------------------------------------------------------
function listJson(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listJson(full));
    else if (entry.endsWith('.json')) out.push(full);
  }
  return out;
}

/** Visit every node with its JSON pointer path. */
function walk(node, visit, ptr = '') {
  visit(node, ptr);
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, visit, `${ptr}/${i}`));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walk(v, visit, `${ptr}/${k}`);
  }
}

/** RFC 6901 pointer resolution. Returns {ok, node} — never throws. */
function resolvePointer(doc, pointer) {
  if (pointer === '' || pointer === '/') return { ok: true, node: doc };
  const parts = pointer.replace(/^\//, '').split('/');
  let cur = doc;
  for (const raw of parts) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return { ok: false, reason: `'${seg}' is not an array index at /${parts.join('/')}` };
      const i = Number(seg);
      if (i >= cur.length) return { ok: false, reason: `array index ${i} out of range at /${parts.join('/')}` };
      cur = cur[i];
    } else if (cur && typeof cur === 'object') {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) {
        return { ok: false, reason: `no such key '${seg}' at /${parts.join('/')}` };
      }
      cur = cur[seg];
    } else {
      return { ok: false, reason: `cannot descend into a ${cur === null ? 'null' : typeof cur} at /${parts.join('/')}` };
    }
  }
  return { ok: true, node: cur };
}

const isRelRef = (r) => r.startsWith('./') || r.startsWith('../') || (!r.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(r));

// ---------------------------------------------------------------------------
// Load the tree
// ---------------------------------------------------------------------------
if (!existsSync(SCHEMAS_DIR)) {
  fail('schemas/', `no schema directory at ${SCHEMAS_DIR}`);
  console.log(failures.join('\n'));
  process.exit(1);
}
const files = listJson(SCHEMAS_DIR);
const docs = new Map(); // abs path -> parsed (only successfully parsed)
const rel = (p) => path.relative(SCHEMAS_DIR, p).split(path.sep).join('/');

let refCount = 0;
let enumCount = 0;

// check 1 — parse
for (const f of files) {
  try {
    docs.set(f, JSON.parse(readFileSync(f, 'utf8')));
  } catch (err) {
    fail(rel(f), `invalid JSON (${err.message})`);
  }
}

// checks 2 and 6 — dialect, $id, structure
for (const f of files) {
  const doc = docs.get(f);
  if (doc === undefined) continue;
  const r = rel(f);

  if (doc.$schema !== DIALECT) {
    fail(r, `$schema must be '${DIALECT}' (found ${JSON.stringify(doc.$schema)})`);
  }
  const wantId = ID_PREFIX + r;
  if (doc.$id !== wantId) {
    fail(r, `$id must be '${wantId}' (found ${JSON.stringify(doc.$id)})`);
  }

  const hasType = typeof doc.type === 'string' || Array.isArray(doc.type);
  const hasDefs = doc.$defs && typeof doc.$defs === 'object' && Object.keys(doc.$defs).length > 0;
  if (!hasType && !hasDefs && !DEFS_ONLY_CARRIERS.has(r)) {
    fail(r, 'neither `type` nor `$defs` present (a defs-only carrier must be named in DEFS_ONLY_CARRIERS)');
  }

  walk(doc, (node, ptr) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (Array.isArray(node.enum)) {
      enumCount++;
      if (node.enum.length === 0) fail(r, `enum at ${ptr || '(root)'} is empty`);
      const bad = node.enum.filter((v) => v !== null && typeof v === 'object');
      if (bad.length) fail(r, `enum at ${ptr || '(root)'} contains non-scalar value(s)`);
      const seen = new Set();
      const dups = new Set();
      for (const v of node.enum) {
        const k = JSON.stringify(v);
        if (seen.has(k)) dups.add(k);
        seen.add(k);
      }
      if (dups.size) fail(r, `enum at ${ptr || '(root)'} has duplicate value(s): ${[...dups].join(', ')}`);
    }
    const declaresObject = node.type === 'object' || Array.isArray(node.properties) || node.properties || node.patternProperties;
    if (declaresObject && !('additionalProperties' in node)) {
      fail(r, `object at ${ptr || '(root)'} does not state additionalProperties`);
    }
  });
}

// checks 3 and 4 — refs resolve, nothing dangles
for (const f of files) {
  const doc = docs.get(f);
  if (doc === undefined) continue;
  const r = rel(f);
  const baseAbs = path.dirname(f);
  walk(doc, (node, ptr) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const ref = node.$ref;
    if (typeof ref !== 'string') return;
    refCount++;
    const at = `$ref at ${ptr || '(root)'}`;

    if (ref.startsWith('#')) {
      const res = resolvePointer(doc, ref.slice(1));
      if (!res.ok) fail(r, `${at} -> '${ref}' does not resolve in this file (${res.reason})`);
      return;
    }
    if (!isRelRef(ref)) {
      if (!EXTERNAL_REF_ALLOWANCE.includes(ref)) {
        fail(r, `${at} -> external '${ref}' is not allowed (add it to EXTERNAL_REF_ALLOWANCE only with a reason)`);
      }
      return;
    }
    const hashAt = ref.indexOf('#');
    const filePart = hashAt === -1 ? ref : ref.slice(0, hashAt);
    const pointerPart = hashAt === -1 ? '' : ref.slice(hashAt + 1);
    const targetAbs = path.resolve(baseAbs, decodeURIComponent(filePart));
    if (!existsSync(targetAbs) || !statSync(targetAbs).isFile()) {
      fail(r, `${at} -> '${ref}' is dangling: ${path.relative(repoRoot, targetAbs)} does not exist`);
      return;
    }
    const targetDoc = docs.get(targetAbs);
    if (targetDoc === undefined) {
      fail(r, `${at} -> '${ref}' points at ${rel(targetAbs)}, which is not a parseable schema in this tree`);
      return;
    }
    if (pointerPart !== '') {
      const res = resolvePointer(targetDoc, pointerPart);
      if (!res.ok) {
        fail(r, `${at} -> '${ref}' is dangling: ${rel(targetAbs)}${pointerPart} does not exist (${res.reason})`);
      }
    }
    // A ref chain must terminate on a non-ref node: a cycle would be a real defect.
    const seen = new Set([targetAbs + '#' + pointerPart]);
    let curFile = targetAbs;
    let curDoc = targetDoc;
    let curPtr = pointerPart;
    for (let hop = 0; hop < 32; hop++) {
      let cur = curDoc;
      if (curPtr !== '') {
        const res = resolvePointer(curDoc, curPtr);
        if (!res.ok) return; // already reported above
        cur = res.node;
      }
      if (!cur || typeof cur !== 'object' || typeof cur.$ref !== 'string') return;
      const nextRef = cur.$ref;
      if (nextRef.startsWith('#')) {
        curPtr = nextRef.slice(1);
      } else {
        const h = nextRef.indexOf('#');
        const nf = path.resolve(path.dirname(curFile), decodeURIComponent(h === -1 ? nextRef : nextRef.slice(0, h)));
        curPtr = h === -1 ? '' : nextRef.slice(h + 1);
        if (!docs.has(nf)) return;
        curDoc = docs.get(nf);
        curFile = nf;
      }
      const key = curFile + '#' + curPtr;
      if (seen.has(key)) {
        fail(r, `${at} -> '${ref}' is part of a $ref cycle reaching ${rel(curFile)}${curPtr}`);
        return;
      }
      seen.add(key);
    }
  });
}

// check 5 — README index <-> disk, both directions
if (!existsSync(README)) {
  fail('README.md', `no ${path.relative(repoRoot, README)} to index this tree`);
} else {
  const md = readFileSync(README, 'utf8');
  const linked = new Set();
  for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) {
    let href = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) continue; // external / anchor
    href = href.split('#')[0].split('?')[0];
    if (!href.toLowerCase().endsWith('.json')) continue;
    const abs = path.resolve(path.dirname(README), decodeURIComponent(href));
    if (!existsSync(abs)) {
      fail('README.md', `link '${href}' points at a file that does not exist (${path.relative(repoRoot, abs)})`);
      continue;
    }
    linked.add(abs);
  }
  for (const f of files) {
    if (f === README) continue;
    if (PREEXISTING_ENVELOPES.has(path.basename(f)) && path.dirname(f) === SCHEMAS_DIR) continue;
    if (!linked.has(f)) {
      fail('README.md', `${rel(f)} exists on disk but is not linked from README.md (index drift)`);
    }
  }
  if (files.filter((f) => !PREEXISTING_ENVELOPES.has(path.basename(f))).length === 0) {
    fail('README.md', 'no schemas found to index (is this the right root?)');
  }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
if (failures.length > 0) {
  console.log(failures.join('\n'));
  console.log(`SCHEMAS_FAILED failures=${failures.length}`);
  process.exit(1);
}
const fileCount = docs.size;
console.log(`SCHEMAS_OK files=${fileCount} refs=${refCount} enums=${enumCount}`);

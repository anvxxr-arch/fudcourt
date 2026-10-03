#!/usr/bin/env node
/**
 * check-table-shape.mjs — offline gate for malformed markdown tables in the tree.
 *
 * WHY THIS EXISTS. A markdown table row with MORE cells than its header is not a
 * rendering warning: GFM silently DROPS the excess cells, so the text vanishes from
 * the rendered document while remaining visible in the raw source. Three such rows
 * were found in docs/architecture/ on 2026-10-02 — a documented evidence citation
 * (ARCHITECTURE.md:410), a comparison row (canonical-model.md:498), and a debt item's
 * whole Evidence cell (final-review.md:133). Each had been read many times as raw
 * text and never noticed, because the raw text looks fine. This is the only gate that
 * can catch that class, so it is the one place it is checked.
 *
 *   node shared/contracts/scripts/check-table-shape.mjs            # the repo tree
 *   node shared/contracts/scripts/check-table-shape.mjs --root D   # hermetic copy at D
 *
 * Same verdict idiom as its siblings (check-schemas.mjs, check-contract.mjs,
 * check-doc-citations.mjs): one `MDTABLE_FAIL <file>:<line>: <reason>` line per
 * failure, then `MDTABLES_FAILED failures=<N>` and exit 1; a single
 * `MDTABLES_OK files=<N> rows=<M>` on success. `--root D` walks `D` for markdown,
 * so the gate is proven to fail against a perturbed copy without touching the repo.
 *
 * WHAT IT CHECKS (per GFM table, which starts at a `|`-row immediately followed by a
 * delimiter row):
 *   1. the header row and the delimiter row have the same cell count; and
 *   2. no body row has MORE cells than the header — a row with FEWER is legal
 *      (GFM pads it) and is not flagged.
 *
 * CELL SPLITTING honours the two things that make `|` not a cell boundary: an
 * escaped `\|`, and a pipe inside an inline code span (variable-length backtick
 * runs, per CommonMark). Without both, a correct row like
 * ``(type-overloaded: USD \| quantity \| percent)`` is a false positive.
 *
 * SCOPE: every `*.md` in the tree except the build/vendor directories below. This is
 * deliberately broader than check-doc-citations.mjs, whose DOCS list is a curated set
 * of canonical docs; a malformed table is malformed in any document.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
let repoRoot = path.resolve(scriptDir, '..', '..', '..');
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root') {
    const v = argv[i + 1];
    if (!v) {
      console.log('MDTABLE_FAIL --root: missing directory argument');
      process.exit(1);
    }
    repoRoot = path.resolve(v);
    i++;
  } else {
    console.log(`MDTABLE_FAIL argv: unknown argument '${argv[i]}' (only --root <dir> is accepted)`);
    process.exit(1);
  }
}

// Directories that are build output, vendor, or tool caches — never source docs.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', '.shaper-tests', 'target', '.turbo', '.venv', 'dist', 'build']);

// A delimiter row: |---|:--:|---| (leading/trailing pipe optional).
const DELIM = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Split a table row into GFM cells, respecting `\|` escapes and inline code spans. */
function splitCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let buf = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n && s[i + 1] === '|') {
      buf += '|';
      i += 2;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      const run = j - i;
      const close = s.indexOf('`'.repeat(run), j);
      if (close !== -1) {
        buf += s.slice(i, close + run);
        i = close + run;
        continue;
      }
      buf += c;
      i += 1;
      continue;
    }
    if (c === '|') {
      cells.push(buf);
      buf = '';
      i += 1;
      continue;
    }
    buf += c;
    i += 1;
  }
  cells.push(buf);
  return cells;
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(path.join(dir, e.name));
    }
  }
}

const failures = [];
const fail = (file, line, reason) => failures.push(`MDTABLE_FAIL ${file}:${line}: ${reason}`);

const files = [];
walk(repoRoot, files);
let rows = 0;
for (const abs of files.sort()) {
  const rel = path.relative(repoRoot, abs) || abs;
  let lines;
  try {
    lines = readFileSync(abs, 'utf8').split('\n');
  } catch {
    continue;
  }
  let i = 0;
  while (i < lines.length - 1) {
    if (lines[i].trimStart().startsWith('|') && DELIM.test(lines[i + 1].trim())) {
      const headerCells = splitCells(lines[i]).length;
      const sepCells = splitCells(lines[i + 1]).length;
      if (headerCells !== sepCells) {
        fail(rel, i + 1, `header has ${headerCells} cells but the delimiter row has ${sepCells}`);
      }
      let j = i + 2;
      while (j < lines.length && lines[j].trimStart().startsWith('|')) {
        const rowCells = splitCells(lines[j]).length;
        rows++;
        if (rowCells > headerCells) {
          fail(
            rel,
            j + 1,
            `row has ${rowCells} cells but the header has ${headerCells} — GFM drops the ${rowCells - headerCells} excess cell(s), losing their text`,
          );
        }
        j++;
      }
      i = j;
    } else {
      i++;
    }
  }
}

if (failures.length > 0) {
  console.log(failures.join('\n'));
  console.log(`MDTABLES_FAILED failures=${failures.length}`);
  process.exit(1);
}
console.log(`MDTABLES_OK files=${files.length} rows=${rows}`);

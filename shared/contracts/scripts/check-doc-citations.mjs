#!/usr/bin/env node
/**
 * check-doc-citations.mjs — offline drift gate for the canonical data-architecture docs.
 *
 * Every repository path those documents cite in backticks must still resolve on disk. This is the
 * gate against the exact failure mode the canonical workstream hit twice: a doc names a file, a
 * rename happens elsewhere, and the prose keeps pointing at a path that no longer exists. It is the
 * third member of the family, with the same verdict idiom as its siblings:
 *
 *   node shared/contracts/scripts/check-doc-citations.mjs            # the repo tree
 *   node shared/contracts/scripts/check-doc-citations.mjs --root D   # hermetic copy at D
 *
 * `--root D` reads `D/<doc>` for each document below and resolves citations against `D`, so the gate
 * can be proven to fail on a perturbed copy without touching the repository (as check-schemas.mjs
 * does). Same verdict shape: one `DOC_FAIL <file>: <detail>` line per failure, then
 * `DOCS_FAILED failures=<N>` and exit 1; on success a single `DOCS_OK docs=<N> citations=<M>`.
 *
 * WHAT IT SCANS (exactly these nine documents; nothing else)
 *   docs/architecture/{canonical-model,canonical-placement,source-catalog,data-catalog,
 *     data-classification,database-classification,canonical-acceptance,symbol-key-inventory}.md
 *   shared/contracts/schemas/README.md
 *   (`symbol-key-inventory.md` was added here after `fd49b3a`; it had been written and committed
 *    while this list still held eight, so its cited paths went unchecked. Adding a document to the
 *    `DOCS` array is the only way to bring one under the gate — the list is explicit, never a walk.)
 *
 * WHAT COUNTS AS A CITATION
 *   A backticked token that resolves to a repo path: it starts with a known top-level directory
 *   (`backend/`, `frontend/`, `shared/`, `scripts/`, `tests/`, `database/`, `infrastructure/`,
 *   `.github/`) or is one of the SHORT FORMS the documents' own citation-convention paragraphs
 *   declare. Tokens containing whitespace, glob/placeholder punctuation (`* ? { } < > | … , [ ] @ $`)
 *   or a trailing `/` are NOT paths and are skipped — a prose tree block, a `features/<family>/client.ts`
 *   family and a command template are not citations of one file. Citations inside table cells are
 *   scanned the same way as citations in paragraphs (the token walk is textual, not markdown-aware);
 *   a trailing `:line` / `:a-b`, a `#pointer` and a trailing `.`/`:`/`;` are stripped before
 *   resolution. Repeated tokens are counted once per occurrence (`citations=<M>` is occurrences).
 *
 * SHORT-FORM EXPANSIONS (declared by the documents; see canonical-placement.md header and
 * canonical-model.md §7)
 *   `reference/<rest>`  → backend/api/internal/markets/reference/<rest>      (placement header)
 *   `finance/<rest>`    → backend/api/internal/finance/<rest>                (placement header)
 *   `accounts/<rest>`   → backend/api/internal/accounts/<rest>               (placement header)
 *   `markets/<rest>`    → backend/api/internal/markets/<rest>, or, when the token ends in `.json`
 *                         or starts with a schemas/ directory, shared/contracts/schemas/<rest>
 *                         (`markets/instrument.json` is the schema; `markets/overview/market.go`
 *                          is the Go package)
 *   `common/<rest>`, `assets/<rest>`, `trading/<rest>`, `defi/<rest>`, `research/<rest>`,
 *   `signals/<rest>`, `finance/<rest>.json`, `accounts/<rest>.json` (dir ∈ {assets,accounts,
 *   finance,markets,trading,defi,research,signals} plus a trailing `.json`) → shared/contracts/schemas/<tok>
 *   `schemas/<rest>`    → shared/contracts/schemas/<rest>
 *   These are the expansions the docs declare ("`finance/…` abbreviates backend/api/internal/<same>",
 *   "`common/symbol.json` … abbreviate shared/contracts/schemas/<same>"). A token is a FAILURE only
 *   when NONE of its candidate expansions resolves on disk.
 *
 * NAMED ALLOWANCES — the four tokens that legitimately do not resolve, each deliberately retained
 *   as a historical reference, not a stale path. A citation here is not a failure; the summary
 *   reports the total as `allowances=<N>`. A token NOT on this list that does not resolve IS a
 *   failure — that is the entire point. (Stale paths were rewritten to their post-relocation home
 *   rather than excused; see the note on the 2026-10-01 tightening below.)
 *
 *   1. `frontend/web/scripts/tools/dump-envelopes.ts` (1) — canonical-model.md's "path
 *      re-verification" note: "*it was `frontend/web/scripts/tools/dump-envelopes.ts` when this note
 *      was written*". The sentence names the file's new home (`tests/oracle/dump-envelopes.ts`) one
 *      clause earlier; the old path is kept as the record of the move.
 *   2. `frontend/web/src/platform/executor/ui.tsx` (1) — the same note's "→" clause, naming the old
 *      path and its new home (`frontend/web/src/features/executor/ui.tsx`) in one sentence.
 *   3. `backend/api/bin/fudcourt-api` (2) — a build artifact (`go build -o bin/fudcourt-api`), absent
 *      from a clean tree by design; both citations say so ("build artifact, absent from a clean tree").
 *   4. `database/schema/analytics.sql` (2) — cited as a reference that does NOT exist; the citation
 *      *is* the finding ("**Does not exist** (referenced by an older doc)").
 *  Deliberately NOT on this list, though they look similar: `backend/api markets/instruments` and
 *  its siblings (whitespace ⇒ skipped as prose, never counted), `database/migrations/` (trailing `/`
 *  ⇒ skipped, never counted), and every `{...}` / `…` / glob form. Nothing counted is excused without
 *  a reason. Until 2026-10-01 this list also excused 20 stale executor/script paths (singular
 *  `internal/exchange/*`, `internal/{orders,executor,decimal,idempotency,strategy,worker,lock}`,
 *  `frontend/web/scripts/tools/{dump-envelopes.ts,sync-live.py}`); they were rewritten in the docs
 *  to their post-`d4119ca` homes, so the allowance list is now history-only.
 *
 * WHAT IT CANNOT CATCH (stated here, not implied)
 *   - a path that exists on disk but is the WRONG file (rename with a same-named sibling) — this is
 *     existence, not identity;
 *   - a phantom directory named only in a prose tree block that is not backticked (`schemas/events/`
 *     in an unmarked code block, `database/migrations/`) — the walk sees backticked tokens only;
 *   - a citation to a file that was deleted in the SAME commit that removed the last reader — the
 *     path resolving is not the same claim as the path being correct;
 *   - anything about the CONTENT of a cited file (a line number, a symbol, a count). `:NNN` suffixes
 *     are stripped, never checked. The docs' own §"verification" sections carry the `path:symbol`
 *     claims; this gate only proves the file is there.
 *
 * INITIAL STATE OF THE TREE (re-measured 2026-10-01 after the post-relocation path sweep, so this
 * gate's verdict and the acceptance scorecard are comparable): 8 documents, 897 path-shaped citation
 * occurrences (distinct tokens counted in the run), of which all but 6 occurrences (the four
 * deliberate historical references above) resolve. No unallowed miss. The citation count is reported
 * but deliberately NOT pinned as a threshold, so the gate fails on a broken citation and never on a
 * doc edit that adds a valid one. (Before the sweep: 900 occurrences, 45 across 24 allowance tokens.)
 *
 * QUOTING A VERDICT (`docs=`/`citations=`). Both numbers move whenever a scanned doc is edited, so a
 * quoted verdict is a SNAPSHOT and must be read as one, per `docs/operations/CHANGELOG.md`'s own
 * convention ("each row is a snapshot of the moment it shipped"; "every number here was measured on
 * this host, never estimated"). The policy, stated once here and applied throughout:
 *   - a verdict quoted in a DATED row or as the evidence of a past run is point-in-time — label it
 *     ("at the time of that run", "as observed on <date>") or leave it inside the dated row, and
 *     never update it to today's number (that would rewrite history);
 *   - a verdict presented as the CURRENT state is updated to the newest observed line.
 * Latest observed: `DOCS_OK docs=9 citations=969 allowances=6` (2026-10-02, after
 * `docs/architecture/symbol-key-inventory.md` was added to `DOCS`; the row that quotes
 * `docs=8 citations=904` records the state when that document was written and is left as history).
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Arguments (same contract as check-schemas.mjs)
// ---------------------------------------------------------------------------
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
let repoRoot = path.resolve(scriptDir, '..', '..', '..');
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root') {
    const v = argv[i + 1];
    if (!v) {
      console.log('DOC_FAIL --root: missing directory argument');
      process.exit(1);
    }
    repoRoot = path.resolve(v);
    i++;
  } else {
    console.log(`DOC_FAIL argv: unknown argument '${argv[i]}' (only --root <dir> is accepted)`);
    process.exit(1);
  }
}

const DOCS = [
  'docs/architecture/canonical-model.md',
  'docs/architecture/canonical-placement.md',
  'docs/architecture/source-catalog.md',
  'docs/architecture/data-catalog.md',
  'docs/architecture/data-classification.md',
  'docs/architecture/database-classification.md',
  'docs/architecture/canonical-acceptance.md',
  'docs/architecture/symbol-key-inventory.md',
  'shared/contracts/schemas/README.md',
];

const TOP_LEVEL = [
  'backend/', 'frontend/', 'shared/', 'scripts/',
  'tests/', 'database/', 'infrastructure/', '.github/',
];
// Directory names under shared/contracts/schemas/ (the layout block in schemas/README.md §1).
const SCHEMA_DIRS = ['common', 'accounts', 'assets', 'markets', 'trading', 'finance', 'defi', 'research', 'signals'];

// ---------------------------------------------------------------------------
// Named allowances — see header. Keys are the exact citation token; values are one-line reasons.
// ---------------------------------------------------------------------------
const ALLOWANCES = new Map([
  // Deliberately retained historical references — the citation is the record of the move / the
  // absence itself, never a stale path that should have been rewritten.
  ['frontend/web/scripts/tools/dump-envelopes.ts', 'deliberately retained historical reference: canonical-model.md "path re-verification" note records "*it was frontend/web/scripts/tools/dump-envelopes.ts when this note was written*" beside the new home tests/oracle/dump-envelopes.ts'],
  ['frontend/web/src/platform/executor/ui.tsx', 'deliberately retained historical reference: the same note names the old path and its new home (frontend/web/src/features/executor/ui.tsx) in one "→" clause'],
  ['backend/api/bin/fudcourt-api', 'build artifact (go build -o bin/fudcourt-api), absent from a clean tree by design; both citations say so'],
  ['database/schema/analytics.sql', 'cited reference that does NOT exist — the citation is the finding ("**Does not exist** (referenced by an older doc)")'],
]);
// Tokens that are glob/prose shapes the walk must not even consider. Kept explicit so an unexpected
// token cannot be excused as "probably one of these".
const GLOB_OR_PROSE = /[\s*?{}<>|…,[\]@$]/;

// ---------------------------------------------------------------------------
// Extraction + resolution
// ---------------------------------------------------------------------------
const failures = [];
const fail = (file, reason) => failures.push(`DOC_FAIL ${file}: ${reason}`);
const allowed = new Map(); // token -> occurrences

/** Candidate repo-relative paths a citation token may resolve to, most specific first. */
function candidatesFor(token) {
  const hasTop = TOP_LEVEL.some((t) => token.startsWith(t));
  if (hasTop) return [token];
  const seg = token.split('/')[0];
  const rest = token.slice(seg.length + 1);
  const isJson = token.endsWith('.json');
  const out = [];
  if (seg === 'schemas') {
    out.push(`shared/contracts/schemas/${rest}`);
  } else if (SCHEMA_DIRS.includes(seg) && (isJson || seg === 'common' || seg === 'research' || seg === 'defi')) {
    out.push(`shared/contracts/schemas/${token}`);
  }
  if (['reference', 'finance', 'accounts', 'markets', 'access'].includes(seg)) {
    out.push(seg === 'reference'
      ? `backend/api/internal/markets/reference/${rest}`
      : `backend/api/internal/${token}`);
  }
  return out;
}

let citations = 0;
let docsScanned = 0;
for (const doc of DOCS) {
  const abs = path.join(repoRoot, doc);
  if (!existsSync(abs)) {
    fail(doc, 'document itself is missing from the tree');
    continue;
  }
  docsScanned++;
  const lines = readFileSync(abs, 'utf8').split('\n');
  for (let n = 0; n < lines.length; n++) {
    for (const m of lines[n].matchAll(/`([^`\n]+)`/g)) {
      let token = m[1].trim();
      // strip a trailing parenthetical, punctuation, a #pointer and a :line / :a-b suffix
      token = token.replace(/\(.*$/, '').replace(/[.,;:]$/, '');
      if (GLOB_OR_PROSE.test(token) || token.endsWith('/')) continue;
      token = token.split('#')[0].split(':')[0];
      if (!token || token.endsWith('/')) continue;
      const cands = candidatesFor(token);
      if (cands.length === 0) continue; // not path-shaped: prose, a symbol, a short form we do not claim
      citations++;
      if (cands.some((c) => existsSync(path.join(repoRoot, c)))) continue;
      if (ALLOWANCES.has(token)) {
        allowed.set(token, (allowed.get(token) || 0) + 1);
        continue;
      }
      fail(`${doc}:${n + 1}`, `cited path '${token}' does not exist under ${repoRoot} (tried: ${cands.join(', ')})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
if (failures.length > 0) {
  console.log(failures.join('\n'));
  console.log(`DOCS_FAILED failures=${failures.length}`);
  process.exit(1);
}
const allowanceCount = [...allowed.values()].reduce((a, b) => a + b, 0);
console.log(`DOCS_OK docs=${docsScanned} citations=${citations} allowances=${allowanceCount}`);

#!/usr/bin/env node
/**
 * check-doc-citations.mjs — offline drift gate for the canonical data-architecture docs.
 *
 * Every repository path those documents cite in backticks must still resolve on disk. This is the
 * gate against the exact failure mode the canonical workstream hit twice: a doc names a file, a
 * rename happens elsewhere, and the prose keeps pointing at a path that no longer exists. It is the
 * third member of the family, with the same verdict idiom as its siblings:
 *
 *   node contracts/scripts/check-doc-citations.mjs            # the repo tree
 *   node contracts/scripts/check-doc-citations.mjs --root D   # hermetic copy at D
 *
 * `--root D` reads `D/<doc>` for each document below and resolves citations against `D`, so the gate
 * can be proven to fail on a perturbed copy without touching the repository (as check-schemas.mjs
 * does). Same verdict shape: one `DOC_FAIL <file>: <detail>` line per failure, then
 * `DOCS_FAILED failures=<N>` and exit 1; on success a single `DOCS_OK docs=<N> citations=<M>`.
 *
 * WHAT IT SCANS (exactly these ten documents; nothing else)
 *   docs/architecture/{canonical-model,canonical-placement,source-catalog,data-catalog,
 *     data-classification,database-classification,canonical-acceptance,symbol-key-inventory}.md
 *   docs/architecture/DESIGN-SYSTEM.md
 *   contracts/schemas/README.md
 *   (`symbol-key-inventory.md` was added here after `fd49b3a`; it had been written and committed
 *    while this list still held eight, so its cited paths went unchecked. `DESIGN-SYSTEM.md` was
 *    added the same day it landed (DR-037) — it cites the token module, the emitter, the two gates
 *    and the generated artifacts, exactly the kind of prose that goes stale on a rename. Adding a
 *    document to the `DOCS` array is the only way to bring one under the gate — the list is
 *    explicit, never a walk.)
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
 *   `reference/<rest>`  → apps/api/internal/markets/reference/<rest>      (placement header)
 *   `finance/<rest>`    → apps/api/internal/finance/<rest>                (placement header)
 *   `accounts/<rest>`   → apps/api/internal/accounts/<rest>               (placement header)
 *   `markets/<rest>`    → apps/api/internal/markets/<rest>, or, when the token ends in `.json`
 *                         or starts with a schemas/ directory, contracts/schemas/<rest>
 *                         (`markets/instrument.json` is the schema; `markets/overview/market.go`
 *                          is the Go package)
 *   `common/<rest>`, `assets/<rest>`, `trading/<rest>`, `defi/<rest>`, `research/<rest>`,
 *   `signals/<rest>`, `finance/<rest>.json`, `accounts/<rest>.json` (dir ∈ {assets,accounts,
 *   finance,markets,trading,defi,research,signals} plus a trailing `.json`) → contracts/schemas/<tok>
 *   `schemas/<rest>`    → contracts/schemas/<rest>
 *   These are the expansions the docs declare ("`finance/…` abbreviates apps/api/internal/<same>",
 *   "`common/symbol.json` … abbreviate contracts/schemas/<same>"). A token is a FAILURE only
 *   when NONE of its candidate expansions resolves on disk.
 *
 * NAMED ALLOWANCES — the four tokens that legitimately do not resolve, each deliberately retained
 *   as a historical reference, not a stale path. A citation here is not a failure; the summary
 *   reports the total as `allowances=<N>`. A token NOT on this list that does not resolve IS a
 *   failure — that is the entire point. (Stale paths were rewritten to their post-relocation home
 *   rather than excused; see the note on the 2026-10-01 tightening below.)
 *
 *   1. `apps/web/scripts/tools/dump-envelopes.ts` (1) — canonical-model.md's "path
 *      re-verification" note: "*it was `apps/web/scripts/tools/dump-envelopes.ts` when this note
 *      was written*". The sentence names the file's new home (`tests/oracle/dump-envelopes.ts`) one
 *      clause earlier; the old path is kept as the record of the move.
 *   2. `apps/web/src/platform/executor/ui.tsx` (1) — the same note's "→" clause, naming the old
 *      path and its new home (`apps/web/src/features/executor/ui.tsx`) in one sentence.
 *   3. `apps/api/bin/fudcourt-api` (2) — a build artifact (`go build -o bin/fudcourt-api`), absent
 *      from a clean tree by design; both citations say so ("build artifact, absent from a clean tree").
 *   4. `db/schema/analytics.sql` (2) — cited as a reference that does NOT exist; the citation
 *      *is* the finding ("**Does not exist** (referenced by an older doc)").
 *  Deliberately NOT on this list, though they look similar: `apps/api markets/instruments` and
 *  its siblings (whitespace ⇒ skipped as prose, never counted), `database/migrations/` (trailing `/`
 *  ⇒ skipped, never counted), and every `{...}` / `…` / glob form. Nothing counted is excused without
 *  a reason. Until 2026-10-01 this list also excused 20 stale executor/script paths (singular
 *  `internal/exchange/*`, `internal/{orders,executor,decimal,idempotency,strategy,worker,lock}`,
 *  `apps/web/scripts/tools/{dump-envelopes.ts,sync-live.py}`); they were rewritten in the docs
 *  to their post-`d4119ca` homes, so the allowance list is now history-only.
 *
 * GITIGNORED CITATIONS — a cited path that `.gitignore` excludes can never exist in a clean
 *   checkout: build output (`apps/web/.next`), the secrets file (`apps/web/.env.local`), CMS
 *   uploads (`apps/web/media/`), a module binary (`apps/data/bin/fudcourt-data`). Requiring one
 *   to resolve is a gate bug of its own kind — the check would pass on the developer's dirty tree and
 *   fail in CI, which is the very local/CI divergence this file exists to prevent. Those tokens are
 *   classified with ONE batched `git check-ignore --no-index --stdin` and reported as `ignored=<N>`:
 *   deterministic, and never silent. When git is unavailable nothing is excused and the gate stays
 *   strict. This is the same rationale allowance 3 already carried for `apps/api/bin/fudcourt-api`;
 *   the general rule replaces the need to hand-list each build artifact as docs cite new ones.
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
 * Latest observed: `DOCS_OK docs=13 citations=1028 allowances=4 ignored=0` on a developer tree (2026-10-06,
 * after `bot.md` joined `DOCS`). Its `apps/bot/bin/fudcourt-bot` citations are gitignored, so a clean
 * checkout classifies them as `ignored` instead of resolving them — the same dirty/clean divergence
 * described below. The prior current-state reading was `docs=12 citations=1216 allowances=4 ignored=0` on a
 * developer tree and `docs=12 citations=1216 allowances=6 ignored=10` on a clean checkout (2026-10-03); the
 * tree changed between the two runs (DR-043 deleted the TS executor and rewrote the docs that cited it), so
 * the two citation totals are not comparable — each is a snapshot of its own moment. (`citations=1167` was
 * the reading after `coinmarketcap` was folded into the
 * catalogs; `citations=1158` when `data-categorization.md` was added to `DOCS`; the earlier `docs=11
 * citations=1031` reading is when `design-debt.md` was added the day it landed, DR-037 follow-up, the
 * `docs=10 citations=985` reading is when `DESIGN-SYSTEM.md` was added, and `docs=9 citations=969
 * allowances=6` / `docs=8 citations=904` are the current-state snapshots taken before that widening —
 * the older three are left as history).
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { repoRoot as discoverRepoRoot } from './lib.mjs';
// ---------------------------------------------------------------------------
// Arguments (same contract as check-schemas.mjs)
// ---------------------------------------------------------------------------
let repoRoot = discoverRepoRoot();
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
  'docs/architecture/DESIGN-SYSTEM.md',
  'docs/architecture/design-debt.md',
  // Added 2026-10-02 with the data-categorization refresh; its cited paths are now gated.
  'docs/architecture/data-categorization.md',
  // Added 2026-10-06 with the Telegram bot; every repo path it names is now gated.
  'docs/architecture/bot.md',
  'contracts/schemas/README.md',
];

const TOP_LEVEL = [
  'backend/', 'frontend/', 'shared/', 'scripts/',
  'tests/', 'database/', 'infrastructure/', '.github/',
  'apps/', 'core/', 'contracts/', 'db/', 'tools/', 'deploy/', 'docs/',
];
// Directory names under contracts/schemas/ (the layout block in schemas/README.md §1).
const SCHEMA_DIRS = ['common', 'accounts', 'assets', 'markets', 'trading', 'finance', 'defi', 'research', 'signals'];

// ---------------------------------------------------------------------------
// Named allowances — see header. Keys are the exact citation token; values are one-line reasons.
// ---------------------------------------------------------------------------
const ALLOWANCES = new Map([
  // Deliberately retained historical references — the citation is the record of the move / the
  // absence itself, never a stale path that should have been rewritten.
  ['apps/web/scripts/tools/dump-envelopes.ts', 'deliberately retained historical reference: canonical-model.md "path re-verification" note records "*it was apps/web/scripts/tools/dump-envelopes.ts when this note was written*" beside the new home tests/oracle/dump-envelopes.ts'],
  ['apps/web/src/platform/executor/ui.tsx', 'deliberately retained historical reference: the same note names the old path and its new home (apps/web/src/features/executor/ui.tsx) in one "→" clause'],
  ['apps/api/bin/fudcourt-api', 'build artifact (go build -o bin/fudcourt-api), absent from a clean tree by design; both citations say so'],
  ['db/schema/analytics.sql', 'cited reference that does NOT exist — the citation is the finding ("**Does not exist** (referenced by an older doc)")'],
  ['db/client.ts', 'historical reference: the pre-DR-040 frontend db module (platform/db/pg.ts), retired with the treasury move to src/server/db.ts; the citation records the old layout'],
  ['db/README', 'historical reference: the pre-DR-040 db module README, retired with the same move'],
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
const missing = []; // citations that resolve to nothing on disk; classified after the walk

/** Candidate repo-relative paths a citation token may resolve to, most specific first. */
function candidatesFor(token) {
  const hasTop = TOP_LEVEL.some((t) => token.startsWith(t));
  const seg = token.split('/')[0];
  const rest = token.slice(seg.length + 1);
  const isJson = token.endsWith('.json');
  const out = [];
  if (hasTop) {
    out.push(token);
    // `core/` and `db/` are real top-levels in the target tree AND short forms the
    // canonical docs use for the Go executor packages and the frontend db module.
    // Try the literal path first, then the pre-migration home, so a citation stays
    // valid across the relocation.
    if (seg === 'core') out.push(`apps/executor/internal/${rest}`);
    if (seg === 'db') out.push(`apps/web/src/server/${rest}`);
    return out;
  }
  if (seg === 'schemas') {
    out.push(`contracts/schemas/${rest}`);
  } else if (SCHEMA_DIRS.includes(seg) && (isJson || seg === 'common' || seg === 'research' || seg === 'defi')) {
    out.push(`contracts/schemas/${token}`);
  }
  if (['reference', 'finance', 'accounts', 'markets', 'access'].includes(seg)) {
    out.push(seg === 'reference'
      ? `apps/api/internal/markets/reference/${rest}`
      : `apps/api/internal/${token}`);
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
      missing.push({ doc, line: n + 1, token, cands });
    }
  }
}

// A cited path `.gitignore` excludes can never exist in a clean checkout, so requiring it to resolve
// is a gate bug: the check would pass on a dirty developer tree and fail in CI. Classify those tokens
// in one batched `git check-ignore`; everything else is a real failure. See the header.
const ignoredTokens = gitIgnoredSet([...new Set(missing.map((m) => m.token))], repoRoot);
const ignored = new Map();
for (const m of missing) {
  if (ignoredTokens.has(m.token)) {
    ignored.set(m.token, (ignored.get(m.token) || 0) + 1);
    continue;
  }
  fail(`${m.doc}:${m.line}`, `cited path '${m.token}' does not exist under ${repoRoot} (tried: ${m.cands.join(', ')})`);
}

/**
 * The subset of `tokens` that `.gitignore` excludes, in ONE `git check-ignore` call.
 * Exit 0 means at least one matched, 1 means none; any other outcome (no git, not a repo, a git
 * error) returns an empty set so the caller treats every token as a real failure — a missing tool
 * can only make the gate stricter, never looser.
 */
function gitIgnoredSet(tokens, root) {
  const out = new Set();
  if (tokens.length === 0) return out;
  // Ask in BOTH forms. A `.gitignore` directory pattern (`media/`, `.next/`) matches only once git
  // knows the path is a directory, and in a clean checkout that directory is absent — the trailing
  // slash is what tells git to test it as one (without it the pattern silently does not match, which
  // is how `apps/web/media` and `apps/web/.next` slipped through the first pass). Every hit
  // is mapped back to its bare token.
  const probes = [];
  for (const t of tokens) {
    probes.push(t, `${t}/`);
  }
  const r = spawnSync('git', ['-C', root, 'check-ignore', '--no-index', '-z', '--stdin'], {
    input: probes.join('\0'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || (r.status !== 0 && r.status !== 1)) return out;
  for (const t of (r.stdout || '').split('\0')) {
    if (t) out.add(t.endsWith('/') ? t.slice(0, -1) : t);
  }
  return out;
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
const ignoredCount = [...ignored.values()].reduce((a, b) => a + b, 0);
console.log(`DOCS_OK docs=${docsScanned} citations=${citations} allowances=${allowanceCount} ignored=${ignoredCount}`);

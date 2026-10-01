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
 * WHAT IT SCANS (exactly these eight documents; nothing else)
 *   docs/architecture/{canonical-model,canonical-placement,source-catalog,data-catalog,
 *     data-classification,database-classification,canonical-acceptance}.md
 *   shared/contracts/schemas/README.md
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
 * NAMED ALLOWANCES — the 24 tokens that legitimately do not resolve today, each with its reason.
 *   A citation on this list is not a failure; the summary reports the total as `allowances=<N>`.
 *   The list is exactly the miss set measured on 2026-10-01 (45 occurrences over the 8 documents).
 *   A token NOT on this list that does not resolve is a failure — that is the entire point.
 *
 *   1. Pre-relocation script paths (2 tokens, 6 occurrences). A concurrent actor relocated
 *      `frontend/web/scripts/**` (the move landed as commit `d4119ca`, "phase-7 relocation of
 *      repo-level tooling out of frontend/web/scripts"): `tools/` went to `tests/oracle/` +
 *      `tests/e2e/executor/`, `checks/`/`verify/` to `scripts/verify/`. The canonical docs were
 *      written before that move and cite the old shape as history, so
 *      `frontend/web/scripts/tools/dump-envelopes.ts` (new home `tests/oracle/dump-envelopes.ts`) and
 *      `frontend/web/scripts/tools/sync-live.py` (new home `tests/oracle/sync-live.py`) still miss
 *      as written. NOTE: the docs also cite `frontend/web/scripts/tools/pg-load.ts` (source-catalog.md
 *      §6) and `frontend/web/scripts/checks/check-structure.py`, both of which RESOLVE (those tools
 *      were not among the relocated ones), so neither is on this list.
 *   2. `backend/api/bin/fudcourt-api` (2) — a build artifact (`go build -o bin/fudcourt-api`), absent
 *      from a clean tree by design; source-catalog.md §6 says so at the citation.
 *   3. Executor pre-regroup shapes (12 tokens, 20 occurrences): `internal/exchange`,
 *      `internal/exchange/{binance/binance.go,binance/parse.go,bybit/parse.go,mexc/parse.go}`,
 *      `internal/orders`, `internal/executor`, `internal/decimal/decimal.go`,
 *      `internal/idempotency/idempotency.go`, `internal/strategy/strategies.go`,
 *      `internal/worker/tick.go`, `internal/lock/valkey.go`. The executor tree was regrouped
 *      mid-audit to `internal/{exchanges,core/orders,core/execution,platform/decimal,
 *      runtime/idempotency,strategies}`; the documents record the move and keep the old shapes as
 *      evidence of it (canonical-model.md header "path flux"). `internal/repository` is NOT on this
 *      list — that one still resolves.
 *   4. `database/schema/analytics.sql` (2) — cited as a reference that does NOT exist, which is the
 *      documents' own finding ("**Does not exist** (referenced by an older doc)").
 *   5. `finance/treasury.go` (1) — short form dropping the package directory; the file is
 *      `backend/api/internal/finance/treasury/treasury.go`, not `.../finance/treasury.go`.
 *   6. `backend/api/markets/reference` (4) — short form eliding the `internal` segment; the real
 *      package prefix is `backend/api/internal/markets/reference` (schemas/README.md §2.2).
 *   7. `frontend/web/src/platform/executor/ui.tsx` (1) — a pre-move path, recorded in the same
 *      sentence as its new home (`frontend/web/src/features/executor/ui.tsx`) as evidence of the move.
 *   8. `scripts/check-contract.mjs` (2) — the pre-relocation path of the contracts gate; it is now
 *      `shared/contracts/scripts/check-contract.mjs` and schemas/README.md §3/§6 cite the old shape.
 *   9. `accounts/exchange.ExchangeAccount` (2) — a symbol, not a path: the doc concatenates the
 *      package path and the Go type in one token (`accounts/exchange` + `.ExchangeAccount`).
 *  10. `markets/client.ts` (3), `research/llama/shape.go` (1), `research/chainrank` (1) —
 *      de-contextualised short forms inside a cell that repeats the family prefix earlier
 *      (`features/markets/client.ts`, `…/research/llama/shape.go`); the expansions resolve, the
 *      truncated token does not.
 *  Deliberately NOT on this list, though they look similar: `backend/api markets/instruments` and
 *  its siblings (whitespace ⇒ skipped as prose, never counted) and `database/migrations/`
 *  (trailing `/` ⇒ skipped, never counted). Nothing that is counted is excused without a reason.
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
 * INITIAL STATE OF THE TREE (recorded 2026-10-01, deliberately in the header so this gate's verdict
 * and the acceptance scorecard are comparable): 8 documents, 900 path-shaped citation occurrences
 * (269 distinct tokens), of which 855 occurrences resolve and 45 occurrences (24 distinct tokens,
 * the allowance list above) are covered by a named reason. No unallowed miss. The citation count is
 * reported but deliberately NOT pinned as a threshold, so the gate fails on a broken citation and
 * never on a doc edit that adds a valid one.
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
  // 1. pre-relocation script paths (concurrent relocation staged-but-uncommitted as of 2026-10-01)
  ['frontend/web/scripts/tools/dump-envelopes.ts', 'pre-relocation path; the tooling relocation landed as d4119ca (new home tests/oracle/dump-envelopes.ts) but the canonical docs still cite the old shape as history'],
  ['frontend/web/scripts/tools/sync-live.py', 'pre-relocation path; the tooling relocation landed as d4119ca (new home tests/oracle/sync-live.py) but the canonical docs still cite the old shape as history'],
  // 2. build artifact
  ['backend/api/bin/fudcourt-api', 'build artifact, absent from a clean tree by design (source-catalog.md §6)'],
  // 3. executor pre-regroup shapes (the tree was regrouped mid-audit; the docs keep the old shapes as evidence)
  ['backend/workers/executor/internal/exchange', 'executor pre-regroup package path (→ internal/exchanges); recorded as evidence of the mid-audit move'],
  ['backend/workers/executor/internal/exchange/binance/binance.go', 'executor pre-regroup path (→ internal/exchanges/binance/binance.go)'],
  ['backend/workers/executor/internal/exchange/binance/parse.go', 'executor pre-regroup path (→ internal/exchanges/binance/parse.go)'],
  ['backend/workers/executor/internal/exchange/bybit/parse.go', 'executor pre-regroup path (→ internal/exchanges/bybit/parse.go)'],
  ['backend/workers/executor/internal/exchange/mexc/parse.go', 'executor pre-regroup path (→ internal/exchanges/mexc/parse.go)'],
  ['backend/workers/executor/internal/orders', 'executor pre-regroup package path (→ internal/core/orders)'],
  ['backend/workers/executor/internal/executor', 'executor pre-regroup package path (→ internal/core/execution)'],
  ['backend/workers/executor/internal/decimal/decimal.go', 'executor pre-regroup path (→ internal/platform/decimal/decimal.go)'],
  ['backend/workers/executor/internal/idempotency/idempotency.go', 'executor pre-regroup path (→ internal/runtime/idempotency/idempotency.go)'],
  ['backend/workers/executor/internal/strategy/strategies.go', 'executor pre-regroup path (→ internal/strategies/strategies.go)'],
  ['backend/workers/executor/internal/worker/tick.go', 'executor pre-regroup path (worker not yet landed in the regrouped tree)'],
  ['backend/workers/executor/internal/lock/valkey.go', 'executor pre-regroup path (lock package regrouped under internal/runtime)'],
  // 4. a cited reference that does not exist — the documents' own finding
  ['database/schema/analytics.sql', 'cited reference that does not exist — the documents\' own finding ("**Does not exist**")'],
  // 5-10. de-contextualised short forms and a symbol token (the real target resolves; the token as written does not)
  ['finance/treasury.go', 'short form dropping the package directory (the file is backend/api/internal/finance/treasury/treasury.go)'],
  ['backend/api/markets/reference', 'short form eliding the `internal` segment (the real prefix is backend/api/internal/markets/reference)'],
  ['frontend/web/src/platform/executor/ui.tsx', 'pre-move path, recorded in the same sentence as its new home (→ frontend/web/src/features/executor/ui.tsx)'],
  ['scripts/check-contract.mjs', 'pre-relocation path of the contracts gate (→ shared/contracts/scripts/check-contract.mjs)'],
  ['accounts/exchange.ExchangeAccount', 'symbol, not a path; the doc writes package + type in one token (`accounts/exchange` + `.ExchangeAccount`)'],
  ['markets/client.ts', 'de-contextualised short form of features/markets/client.ts inside a cell that repeats the family prefix'],
  ['research/llama/shape.go', 'de-contextualised short form of backend/data/internal/research/llama/shape.go (the `…/` prefix is prose)'],
  ['research/chainrank', 'de-contextualised short form of backend/data/internal/research/chainrank'],
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

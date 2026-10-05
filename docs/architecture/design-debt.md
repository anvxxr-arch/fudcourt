# Design System Debt Ledger

A read-only ledger of what the design system does **not** yet cover. Every number below is
MEASURED, with the command that produced it next to it, so the owner can re-run each one. This
document records; it does not decide. Nothing here is a work item unless the owner makes it one.

Scope: the design system as landed — `frontend/web/src/styles/tokens.ts` as the single source of
truth, the generated `frontend/web/src/app/(frontend)/globals.css` `:root` block and
`tailwind.tokens.json`, the atom shelf under `frontend/web/src/components/ui/`, the hard gate
`frontend/web/scripts/checks/check-design-tokens.py`, and the pixel harness
`frontend/web/tests/design/fingerprint.py`. The harness's own coverage is enforced by
`routes --check` and documented in `docs/architecture/design-inventory.md` §E.

Measured 2026-10-02 against the live worktree (the market-IA rework is uncommitted there).
Provenance: `git rev-parse HEAD` = `f50f9a608d25b0e116f37d94555f174f8650ecb8`; `git status --porcelain -- frontend/web | sha1sum`
= `1ba0adc1f59260c3182bd61ed5f95b46c72d51e3` (84 entries — the worktree is DIRTY, so these are
worktree measurements, not HEAD-bytes measurements).

Every command below is run from the repo root unless it says otherwise. The harness venv is
`/home/dwizzy/farming/.venv/bin/python` (see §E.1 of the inventory — `/usr/bin/python3` has no
playwright).

---

## 1. Soft-value debt (layout decisions, not substitutions)

The gate separates two things. A **hard** value (a raw colour, or a `fontSize` / `borderRadius` /
`lineHeight` / `letterSpacing` / `zIndex` / `fontWeight` literal) can be mechanically re-pointed at
a token and MUST NOT survive — that is what `DESIGN_TOKENS_OK` certifies. A **soft** value is a
numeric or string literal in `padding*`, `margin*`, `gap*`, `top|left|right|bottom` or
`width|height|min*|max*`. Those are a *layout system*, not a rename: normalising `5px 6px` to a
token is a visual redesign with its own review. The gate counts them and **never fails on them, by
design** (see the gate header: "SOFT REPORT (never fails)").

The soft report prints only on a failing run, so re-measure it with this one-liner (it imports the
gate as a module and runs its own scans; `python3`, no playwright needed):

```bash
python3 -c "import importlib.util,sys; s=importlib.util.spec_from_file_location('g','frontend/web/scripts/checks/check-design-tokens.py'); g=importlib.util.module_from_spec(s); sys.modules['g']=g; s.loader.exec_module(g); g.scan_module_files(); g.scan_style_files(); g.print_soft_report()"
```

Result (verbatim):

```
DESIGN_SOFT: total=266 padding=128 margin=55 gap=4 position=0 size=79
DESIGN_SOFT top-5 padding: '5px 6px'x51, '6px 5px'x13, '5px 5px'x13, '7px 10px'x7, '5px 8px'x6
DESIGN_SOFT top-5 margin: '0'x24, '2'x11, '5'x4, 'auto'x3, '0 auto'x2
DESIGN_SOFT top-5 gap: '7'x2, '5'x2
DESIGN_SOFT top-5 position: (none)
DESIGN_SOFT top-5 size: '100%'x23, '260'x9, '100vh'x6, '300'x5, '200'x4
```

Hard counters on the same scan: `color=0 scale=0 dead=0` — the tree is clean on every rule the
gate can fail on. Re-run the hard verdict as the owner's normal gate:

```bash
cd frontend/web && python3 scripts/checks/check-design-tokens.py   # DESIGN_TOKENS_OK (files=164 exemptions=6)
```

> **Snapshot.** The block above is verbatim from the measurement moment. The market-IA rework is
> uncommitted and under active edit, so the soft numbers move between runs: a re-run minutes later
> read `DESIGN_SOFT: total=264 padding=128 margin=55 gap=4 position=0 size=77` (the two `size`
> literals moved, in the market families being rewritten). Re-run the command for the current
> numbers; treat the *shape* of the debt (padding-dominant, fixed pixel widths in `size`) as the
> durable reading.

Readings the owner may act on (all from the histogram above):

| family | total | observation |
|---|---:|---|
| `padding` | 128 | one shorthand (`5px 6px`, 51 sites) is 40% of the family; it repeats per-cell in the tables |
| `size` | 79 | `100%` (23), then fixed pixel widths `260` (9), `300` (5), `200` (4) — board column sizing |
| `margin` | 55 | 24 of them are `0` (reset, not a choice) |
| `gap` | 4 | negligible |
| `position` | 0 | the tree writes none |

These are **layout decisions for the owner**, not mechanical token substitutions. The gate will
never fail on them by design, so their only alarm is this count.

---

## 2. Atom adoption census

Every exported atom under `frontend/web/src/components/ui/`, with today's call sites. A "call site"
is a file that imports the atom from `@/components/ui/<shelf>`; `jsx` counts `<Atom` occurrences in
those files. Measured with an import-resolving scan (a bare name-match over-reports:
`Stat`/`Table`/`Button` also appear as local type names and `useState`):

```bash
cd frontend/web && python3 - <<'PY'
import re, pathlib
src = pathlib.Path('src'); used = {}
for p in src.rglob('*.tsx'):
    if 'components/ui/' in p.as_posix(): continue
    t = p.read_text(encoding='utf-8', errors='replace')
    for m in re.finditer(r"import\s*\{([^}]*)\}\s*from\s*'@/components/ui/(\w+)'", t):
        for n in m.group(1).split(','):
            n = n.strip().split(' as ')[0].strip()
            if n: used.setdefault(n, set()).add(p.as_posix())
for e in ['Badge','Banner','EmptyState','Loading','Dash','Button','Input','Select','TextArea',
          'Modal','Label','Card','Stat','Table','THead','TBody','TFoot','TR','TH','TD','Toolbar']:
    fs = sorted(used.get(e, []))
    jsx = sum(len(re.findall(rf"<{re.escape(e)}(?=[\s/>])", pathlib.Path(f).read_text(encoding='utf-8'))) for f in fs)
    print(f"{e:12s} files={len(fs):2d} jsx={jsx:3d}  {', '.join(fs) if fs else '-- ZERO --'}")
PY
```

Result (verbatim, condensed file lists):

| atom | shelf | call sites (files) | `<Atom` uses | files |
|---|---|---:|---:|---|
| `Badge` | `badge.tsx` | 1 | 1 | `src/features/home/ui.tsx` |
| `Banner` | `banner.tsx` | 4 | 11 | `src/features/dex/ui.tsx`, `src/features/home/ui.tsx`, `src/features/llama/ui.tsx`, `src/features/market/stock/ui.tsx` |
| `EmptyState` | `feedback.tsx` | 2 | 2 | `src/features/news/ui.tsx`, `src/features/treasury/reconciliation.tsx` |
| `Loading` | `feedback.tsx` | 10 | 17 | `src/features/dex/ui.tsx`, `src/features/home/ui.tsx`, `src/features/market/forex/ui.tsx`, `src/features/market/quote-board.tsx`, `src/features/news/ui.tsx`, `src/features/scoreboard/ui.tsx`, `src/features/signals/ui.tsx`, `src/features/ticker/detail.tsx`, `src/features/ticker/ui.tsx`, `src/features/tracker/ui.tsx` |
| `Button` | `primitives.tsx` | 2 | 11 | `src/features/transactions/ui.tsx`, `src/features/wallets/ui.tsx` |
| `Input` | `primitives.tsx` | 1 | 4 | `src/features/transactions/ui.tsx` |
| `Select` | `primitives.tsx` | 1 | 4 | `src/features/transactions/ui.tsx` |
| `Modal` | `primitives.tsx` | 2 | 2 | `src/features/transactions/ui.tsx`, `src/features/wallets/ui.tsx` |
| `Label` | `primitives.tsx` | 3 | 13 | `src/features/executor/ui.tsx`, `src/features/transactions/ui.tsx`, `src/features/wallets/ui.tsx` |
| `Card` | `primitives.tsx` | 5 | 21 | `src/features/dashboard/ui.tsx`, `src/features/executor/ui.tsx`, `src/features/portfolio/ui.tsx`, `src/features/treasury/reconciliation.tsx`, `src/features/wallets/ui.tsx` |
| `Stat` | `stat.tsx` | 1 | 6 | `src/features/home/ui.tsx` |
| `Table` | `table.tsx` | 7 | 20 | `src/features/dex/ui.tsx`, `src/features/home/ui.tsx`, `src/features/llama/ui.tsx`, `src/features/market/forex/ui.tsx`, `src/features/market/quote-board.tsx`, `src/features/scoreboard/ui.tsx`, `src/features/signals/ui.tsx` |
| `THead` | `table.tsx` | 7 | 20 | same 7 as `Table` |
| `TBody` | `table.tsx` | 7 | 20 | same 7 as `Table` |
| `TR` | `table.tsx` | 4 | 36 | `src/features/home/ui.tsx`, `src/features/llama/ui.tsx`, `src/features/market/forex/ui.tsx`, `src/features/market/quote-board.tsx` |
| `TH` | `table.tsx` | 4 | 61 | same 4 as `TR` |
| `TD` | `table.tsx` | 4 | 65 | same 4 as `TR` |
| `Toolbar` | `toolbar.tsx` | 5 | 5 | `src/features/market/forex/ui.tsx`, `src/features/market/quote-board.tsx`, `src/features/news/ui.tsx`, `src/features/scoreboard/ui.tsx`, `src/features/signals/ui.tsx` |

> **Re-measured 2026-10-05** (`git rev-parse HEAD` = `be6fec4`). Since the 2026-10-02 baseline the
> `home` surface landed and adopted `Badge`, `Stat`, `Banner`, `Loading` and the table atoms, while
> three exports that measured **0** call sites were **removed** (the "delete or adopt" branch, below):
> `Dash` (`feedback.tsx`), `TextArea` (`primitives.tsx`) and `TFoot` (`table.tsx`). The shelf is now
> 7 files; every exported atom has at least one call site.

### Zero call sites — resolved (2026-10-05)

The 2026-10-02 baseline listed five exports with **no call site anywhere in the tree**. All five
are now closed — two adopted, three deleted:

| atom | shelf | disposition |
|---|---|---|
| `Badge` | `frontend/web/src/components/ui/badge.tsx` | **adopted** — `src/features/home/ui.tsx` |
| `Stat` | `frontend/web/src/components/ui/stat.tsx` | **adopted** — `src/features/home/ui.tsx` (6 uses) |
| `Dash` | `frontend/web/src/components/ui/feedback.tsx` | **deleted** — the house `—` literal lives at the call sites |
| `TextArea` | `frontend/web/src/components/ui/primitives.tsx` | **deleted** — no caller; `transactions`/`wallets` write a raw `<textarea>` where needed |
| `TFoot` | `frontend/web/src/components/ui/table.tsx` | **deleted** — no caller |

`Stat` was the sharpest case because it was **actively re-implemented** rather than adopted:

```bash
cd frontend/web && grep -rnE "^(export )?function Stat\b" src
```

- `frontend/web/src/components/ui/stat.tsx` — the shelf atom, now adopted by the `home` surface.
- `frontend/web/src/features/ticker/detail.tsx:417` — a local `Stat` (`tone`), used 7 times.

The shelf atom now has a caller. The local one in `ticker/detail.tsx` remains (it carries a `tone`
the shelf atom does not) and is the remaining adoption candidate if the two are ever folded.

---

## 3. Coverage gap — routes the pixel harness cannot see

The fingerprint harness only covers the routes in its own `ROUTES` list, and it cannot render a
session-gated page at all: it has **no cookie/session mechanism**, and `frontend/web/src/middleware.ts`
redirects an anonymous request for those prefixes to `/login` (the policy table is `TIER_PAGES` in
`frontend/web/src/platform/auth/guard.ts`). Those routes therefore have **no pixel-level guarantee**
from a token change. The harness names each as an explicit, reasoned exclusion in
`EXCLUDED_ROUTES` and fails if a new one appears unlisted:

```bash
/home/dwizzy/farming/.venv/bin/python frontend/web/tests/design/fingerprint.py routes --check
```

The 13 page routes with no pixel guarantee (all redirect `307` to `/login` when anonymous):

| route | why the harness cannot probe it |
|---|---|
| `/admin` | `TIER_PAGES` `/admin` → `admin` tier |
| `/member` | `TIER_PAGES` `/member` → `member` tier |
| `/executor` | `TIER_PAGES` `/executor` → `team` tier |
| `/executor/[id]` | under the `/executor` → `team` prefix |
| `/executor/accounts` | under the `/executor` → `team` prefix |
| `/executor/history` | under the `/executor` → `team` prefix |
| `/executor/new` | under the `/executor` → `team` prefix |
| `/executor/settings` | under the `/executor` → `team` prefix |
| `/team/balance` | under the `/team` → `team` prefix (treasury surface) |
| `/team/portfolio` | under the `/team` → `team` prefix |
| `/team/reconciliation` | under the `/team` → `team` prefix |
| `/team/transactions` | under the `/team` → `team` prefix |
| `/team/wallets` | under the `/team` → `team` prefix |

One further page route is excluded as a **third-party surface**, not a session gate:
`/blog/cms/admin/[[...segments]]` — the Payload admin SPA under `frontend/web/src/app/blog/(payload)/**`,
which styles itself through its own stylesheets and is already colour-exempt in the token gate
(`COLOR_EXEMPT_DIRS` `src/app/blog/(payload)` in `frontend/web/scripts/checks/check-design-tokens.py`).
It is not product chrome, so it is neither probed nor a gap.

The 14 routes the harness **does** see are listed in `docs/architecture/design-inventory.md` §C.
`routes --check` prints `ROUTES: covered=14 probed=14 excluded=14 missing=0 app=28` on the reconciled
tree.

---

## 4. Where the design system is not yet the source of truth

The token layer is the source of truth for *values*, but the *leaves* that consume them are still
hand-rolled in places the atom shelf already covers. Measure raw elements outside the shelf:

```bash
cd frontend/web && python3 - <<'PY'
import re, pathlib
pats = {'<table':r"<table[\s>]", '<button':r"<button[\s>]", '<input':r"<input[\s>]",
        '<select':r"<select[\s>]", '<textarea':r"<textarea[\s>]"}
for k, rx in pats.items():
    tot, files = 0, []
    for p in sorted(pathlib.Path('src').rglob('*.tsx')):
        if 'components/ui/' in p.as_posix(): continue
        n = len(re.findall(rx, p.read_text(encoding='utf-8', errors='replace')))
        if n: files.append((n, p.as_posix())); tot += n
    print(f"{k}: {tot} in {len(files)} files")
    for n, f in sorted(files, reverse=True)[:6]: print(f"    {n:3d}  {f}")
PY
```

Result (verbatim):

| raw element | count | files | the atom that covers it |
|---|---:|---:|---|
| `<button` | 33 | 19 | `Button` (`frontend/web/src/components/ui/primitives.tsx:11`) |
| `<input` | 20 | 11 | `Input` (`frontend/web/src/components/ui/primitives.tsx:46`) |
| `<table` | 16 | 12 | `Table` (`frontend/web/src/components/ui/table.tsx:42`) |
| `<select` | 15 | 8 | `Select` (`frontend/web/src/components/ui/primitives.tsx:64`) |
| `<textarea` | 2 | 2 | **no atom** — `TextArea` was removed 2026-10-05; the two sites write a raw `<textarea>` |

> **Re-measured 2026-10-05** (`HEAD` = `be6fec4`). The counts moved with the `home` surface landing
> (which adopts the atoms rather than hand-rolling) and the removal of `Dash`/`TextArea`/`TFoot`;
> `TextArea` no longer has a shelf entry, so its row names no covering atom.

The sharpest cases are surfaces that import **no** atom at all while hand-rolling chrome the shelf
covers — the shell itself:

| `file:line` | what it hand-rolls |
|---|---|
| `frontend/web/src/components/layout/store-shell.tsx:162` | a full `<button>` (padding, radius, accent background) — the primary nav/tab chrome |
| `frontend/web/src/components/layout/market-hub.tsx:130` | hub tab `<button>` |
| `frontend/web/src/components/layout/market-hub.tsx:146` | hub tab `<button>` |
| `frontend/web/src/components/layout/market-hub.tsx:162` | hub tab `<button>` |
| `frontend/web/src/app/(frontend)/(admin)/admin/page.tsx:81` | a raw `<table>` |
| `frontend/web/src/features/admin/members-table.tsx:82` | a raw `<table>` (and `frontend/web/src/features/admin/members-table.tsx:128`, a raw `<button>`) |

Files that hand-roll raw chrome *while also importing atoms* — the migrated half, where the same
element still appears both ways:

| `file:line` (first raw element) | raw elements | imports atoms? |
|---|---|---|
| `frontend/web/src/features/dex/ui.tsx:214` | 2 `<button>`, 4 `<input>`, 2 `<select>` | yes (`Banner`, `Loading`, `Table`) |
| `frontend/web/src/features/executor/ui.tsx:118` | 1 `<select>`, 1 `<input>`, 5 `<table>` | yes (`Card`, `Label`) |
| `frontend/web/src/features/ticker/detail.tsx:270` | 1 `<button>`, 3 `<select>`, 1 `<table>` | yes (`Loading`) and a local `Stat` |
| `frontend/web/src/features/ticker/ui.tsx:207` | 3 `<button>`, 1 `<table>` | yes (`Loading`) |
| `frontend/web/src/features/tracker/ui.tsx:55` | 1 `<button>`, 1 `<table>` | yes (`Loading`) |
| `frontend/web/src/features/transactions/ui.tsx:142` | 1 `<table>`, 3 `<input>`, 1 `<textarea>` | yes (`Button` ×8, `Input` ×4, `Select` ×4, `Modal`, `Label` ×7) |
| `frontend/web/src/features/wallets/ui.tsx:57` | 2 `<input>`, 2 `<button>`, 1 `<textarea>` | yes (`Button` ×3, `Modal`, `Label` ×4, `Card`) |
| `frontend/web/src/features/dashboard/ui.tsx:51` | 1 `<table>` | yes (`Card`) |
| `frontend/web/src/features/dex/trench.tsx:42` | 1 `<button>` | no (bespoke state) |
| `frontend/web/src/features/news/ui.tsx:47` | 1 `<button>` | yes (`EmptyState`, `Loading`, `Toolbar`) |
| `frontend/web/src/features/scoreboard/ui.tsx:97` | 1 `<button>` | yes (`Loading`, `Table`, `Toolbar`) |
| `frontend/web/src/features/signals/ui.tsx:190` | 1 `<button>` | yes (`Loading`, `Table`, `Toolbar`) |
| `frontend/web/src/features/llama/ui.tsx:122` | 1 `<button>` | yes (`Banner`, `Table`) |
| `frontend/web/src/features/treasury/reconciliation.tsx:113` | 1 `<table>` | yes (`EmptyState`, `Card`) |

Note: several of these files (`ticker/*`, `tracker/*`, `llama/*`, `dex/*`) belong to families the
market-IA rework absorbs into the `/market` hub; the counts above are the state of the live worktree
today, not a claim about the post-rework tree.

---

## 5. How to re-measure

Run from the repo root. Interpreter for the harness: `/home/dwizzy/farming/.venv/bin/python`.

```bash
# Hard gate verdict (green = nothing mechanical left):
cd frontend/web && python3 scripts/checks/check-design-tokens.py

# Soft-value report (the gate prints it only on failure; this forces it):
python3 -c "import importlib.util,sys; s=importlib.util.spec_from_file_location('g','frontend/web/scripts/checks/check-design-tokens.py'); g=importlib.util.module_from_spec(s); sys.modules['g']=g; s.loader.exec_module(g); g.scan_module_files(); g.scan_style_files(); g.print_soft_report()"

# Atom adoption census (the inline script in §2), then list zero-use exports:
cd frontend/web && grep -rn "@/components/ui/" src --include=*.tsx

# Harness route coverage vs the app tree (exit 1 on drift):
/home/dwizzy/farming/.venv/bin/python frontend/web/tests/design/fingerprint.py routes --check

# Raw-chrome census (the inline script in §4):
cd frontend/web && grep -rn "<table\|<button\|<input\|<select\|<textarea" src --include=*.tsx

# Local re-implementations of a shelved atom:
cd frontend/web && grep -rnE "^(export )?function Stat\b" src
```

The gate and the harness are the two alarms: the gate is the *value* alarm (it fails on a
hand-written colour/scale), the harness's `routes --check` is the *surface* alarm (it fails when the
fingerprint stops covering a route the app serves). Neither one, on its own, tells the owner what
the debt above costs — that is this ledger's only job.

---

## 6. Operational notes

### 6.1 A build in place arms a trap on the live `:3100` unit

The `fudcourt-web` user unit serves **the same** `frontend/web/.next` directory that
`unset NODE_ENV && bun run build` rewrites (unit: `WorkingDirectory=/home/dwizzy/fudcourt/frontend/web`,
`NODE_ENV=production`, `next start -p 3100`), and a build does **not** restart the unit. So a build
run in place swaps the served build out from under a live process: routes keep answering 200 from
already-rendered HTML while a `/_next/static/chunks/*.js` that HTML still references returns
**500**, because the build replaced that file. A peer workstream measured exactly this on `:3100`
today (unit started 16:16:59 UTC, `.next/BUILD_ID` rewritten 27 min later at 16:43:47 UTC).

Prove the mismatch read-only, without touching the unit:

```bash
systemctl --user show fudcourt-web -p ExecMainStartTimestamp --value
stat -c %y frontend/web/.next/BUILD_ID
```

A BUILD_ID written **after** the unit started means the unit is serving a build whose chunks have
since been replaced.

Two ways to arm it, both avoided by this ledger's own runs:

* `frontend/web/tests/design/fingerprint.py` — the §E cutover procedure's step 1 IS
  `cd frontend/web && unset NODE_ENV && bunx tsc --noEmit && bun run build`. Following it in place
  while the unit is live arms the trap.
* the repo-wide gates — CI, `scripts/verify/verify-all.sh` and the pre-push hook all build. This is
  a property of the whole repo, not of the design system; the design harness merely has a reason to
  build at an arbitrary time.

**Rule.** Run a fingerprint build against a **frozen copy** of the app (the inventory's E.1/E.7
recipe: `git archive HEAD` or a worktree snapshot, hardlinked `node_modules`, the env files), never
in `frontend/web` while the unit is live. If a build in place is unavoidable, say so explicitly and
tell the operator the unit needs a restart afterwards — the restart is the operator's call, and no
fingerprint procedure restarts or reconfigures the unit.

The baseline behind this ledger's §1–§4 measurements was taken the WRONG-OF-THE-RULE way, which is
why this note exists: the worktree was built **in place** in `frontend/web` and served on scratch
port 3214 directly from `frontend/web/.next` (an in-place `bun run build` was part of the sequence).
That build rewrote the same `.next` the live `:3100` unit serves — the unit was never restarted, and
`.next/BUILD_ID` advanced to `qC0G2FIyUxOwFNkLOqQUP` during that window. The capture itself is
unaffected (the harness read the rendered pages), but the in-place build is exactly the trap this
section warns against, and it is recorded here rather than hidden. A future re-baseline MUST use
the frozen-copy route above.

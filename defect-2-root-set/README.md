# Defect 2 — the tsconfig root-set collection

`deno lsp` decides which files seed each TypeScript program by walking the
filesystem from every tsconfig's base, and that walk is bounded by almost
nothing: not by version control, not by a vendor folder, and **not by the
tsconfig's own `include`**. Only `exclude` prunes it.

On the reproduction in [`diagnosis/`](diagnosis/README.md) it is **2,008 of 3,006
directory opens — 66.8%** — and it grows without bound with untracked mass while
everything that could stop it stays constant. On the traced real workspace it is
`refresh_compiler_options_resolver`: 9,332 opens, 21.9%.

```
initialized                                       cli/lsp/language_server.rs:4265
  Inner::refresh_compiler_options_resolver
    LspCompilerOptionsResolver::from_inner         cli/lsp/compiler_options.rs:87
      collect_specifiers                           cli/util/fs.rs:91
        FileCollector::collect_file_patterns
          sys.fs_read_dir                          libs/config/glob/collector.rs:178
```

## It is the same line as defect 1

`libs/config/glob/collector.rs:178` is where defects 1 and 2 both bottom out. One
`while let Some(next_dir) = pending_dirs.pop_front()`, reached by two call paths
that share nothing else:

| | defect 1 | defect 2 |
|---|---|---|
| entered from | `refresh_config_tree` → `WorkspaceDirectory::discover` | `refresh_compiler_options_resolver` → `from_inner` |
| searching for | `package.json` / `deno.json` under a member glob | every script and JSON file under a tsconfig base |
| its `FilePatterns.exclude` | empty by construction | whatever the tsconfig says |
| its `FilePatterns.include` | the member globs | the tsconfig's `include`, or absent |
| `vendor_folder` | the workspace's, when `"vendor": true` | `None`, always |
| `use_gitignore` | off | off |
| how often | once per `ConfigData::load`, i.e. per scope | once per distinct `FilePatterns` |
| on the real workspace, opens into `/dist` | 1,721 | 1,557 |

The last row is carried from the tracing of the 53-project workspace and is not
reproduced by anything here; every other figure in this directory is produced by
a script in it.

So these are **two policies over one mechanism**, not two patches. A change to
`is_ignored_dir` or to the descent rule at line 177 lands on both; a change to
what each caller passes in lands on one. The recommendation below is deliberately
a caller-side change so that it cannot disturb the other site.

Measured, not assumed: a build carrying `.use_gitignore()` on the **member**
collector — defect 1's rejected mechanism — was run against `diagnosis/sample`
and made **3,006** opens against the stock traced binary's **3,006**. Fixing
defect 1 moves defect 2 by nothing, which is what "different policies at one call
site" predicts.

## What the walk costs, attributed differentially

`diagnosis/evidence/walk-attribution.sh`, on a workspace with 200 directories in
each of `.venv`, `dist` and `src/.cache` per member and no `exclude` anywhere.
Complete `opendir` path log, one configuration field varied per arm. A tsconfig
`exclude` reaches `collect_specifiers` and nothing else, so what it removes is
what `collect_specifiers` was doing.

```
arm                 opendir    .venv     dist src/.cache
as-built               3006     1382      804      806
root-exclude           1400      580      402      404
member-exclude         2604     1382      804      404
all-excluded            998      580      402        2
root-files-empty       1394      580      402      404
no-root-tsconfig       1395      581      402      404
root-include-glob      3005     1382      804      806
root-include-path      1798      580      402      806
```

| quantity | opens | how |
|---|---:|---|
| the root tsconfig's collection | **1,606** | `as-built` − `root-exclude` |
| the member tsconfigs' collections | **402** | `as-built` − `member-exclude` |
| **the root-set collection, total** | **2,008** | `as-built` − `all-excluded`, 66.8% of the run |
| everything else | 998 | `refresh_workspace_files`, at its 1,000-entry cap |

The differences are exact, not approximate: 1,606 = 2 × (401 + 201 + 201), the
three untracked trees in both members; 402 = 2 × 201, the `.cache` tree inside
each member's `include` root, walked a second time by that member's own tsconfig.

**Every member's tsconfig gets its own walk.** `ts_config_roots_cache` is a
`HashMap<FilePatterns, _>` keyed on exact equality (`compiler_options.rs:91`) and
no two members share a base. `src/.cache` is opened 806 times for 402 directories
— by the root tsconfig, by the member's own, and by `refresh_workspace_files`.

**A root tsconfig carrying only `references` walks the entire workspace.**
`root-files-empty` (1,394) and `no-root-tsconfig` (1,395) agree to within the
handful of tracked directories the excluded arm still descends before it stops.
With no `include` and no `files`, the `FilePatterns` base is the workspace root
and the walk is the whole tree.

**`include` bounds where the walk starts, and only if it has no wildcard.**
`include: ["packages/*/src"]` and `include: ["packages/alpha/src",
"packages/beta/src"]` name the same two directories and cost **3,005 and 1,798**.
`FilePatterns::matches_path_detail` **ignores the include list for
`PathKind::Directory`** unless a negated glob matches (`glob_mod.rs:85–119`);
only `split_by_base` uses `include`, and it can only use the wildcard-free
prefix. A user who narrows `include` to exactly their source directories still
pays for every virtualenv beside them.

## How it grows

`diagnosis/evidence/scale-control.sh`, untracked mass varied, everything else
fixed. `vcs-ignored` is the `all-excluded` arm — the `.gitignore` contents
written by hand into every tsconfig's `exclude`, the closest stand-in for
`.use_gitignore()` available on a released binary.

```
n        arm             opendir untracked
50       as-built            928      914
50       vcs-ignored         420      406
200      as-built           3006     2992
200      vcs-ignored         998      984
800      as-built           9008     8994
800      vcs-ignored        1000      986
```

One side is linear in untracked mass — about 10 opens per unit of `n` — and the
other is constant. The constant is `refresh_workspace_files` hitting its own
entry cap and is not this subsystem at all. **At n = 800 the root-set collection
is 8,008 opens against 0.**

## The fix: R1, honour the version-control ignore set

At `cli/lsp/compiler_options.rs:99–104`, the `CollectSpecifiersOptions` literal,
plus the one field it needs in `cli/util/fs.rs`:

```rust
// cli/util/fs.rs:81
pub struct CollectSpecifiersOptions {
  pub file_patterns: FilePatterns,
  pub vendor_folder: Option<PathBuf>,
  pub include_ignored_specified: bool,
  pub use_gitignore: bool,          // added
}

// cli/util/fs.rs:135
let collected_files = FileCollector::new(predicate)
  .ignore_git_folder()
  .ignore_node_modules()
  .set_vendor_folder(vendor_folder)
  .set_use_gitignore(use_gitignore)          // added, in the style of set_vendor_folder
  .collect_file_patterns(&CliSys::default(), &file_patterns);
```

with `use_gitignore: true` at `compiler_options.rs:99`. `FileCollector` already
carries the field and the `use_gitignore()` builder at `collector.rs:37` and
`collector.rs:66`. The option exists at all because `collect_specifiers` has
other callers — `deno test`, `deno check` — whose behaviour must not move as a
side effect of an LSP fix; if it is decided they should all honour it, the change
collapses to a single `.use_gitignore()` and no new field.

| | measured on the `reported` preset | |
|---|---:|---|
| deno today | 29,258 opens | T2 + T3 |
| R1 | **532** | 98.2% |
| R1 + R4 | 320 | 98.9% |

**Nothing else clears 1%.** Passing the scope's real vendor folder instead of
`None` (R2) is 0.0% — it prunes one exact path and the mass is `.venv`, `.cache`
and `dist`. Sharing one traversal across overlapping bases (R4) is 0.7%. Defect
1's glob bound, pointed here (R3), is 0.0% in the default configuration, because
with no `include` the pattern *is* the base and stays alive at every depth.

**It changes the growth term.** Today's collection is Θ(untracked mass inside the
tsconfig bases); a version-control-bounded one is Θ(tracked files) and flat in
that mass. On the real binary the walk goes from 8,008 opens to 0 as the
untracked trees grow. Modelled at the largest scale, 102,345 opens against 320 —
a factor of 320, still widening, because one side does not move.

Two things go with it:

- **X2 — a bare `exclude` entry matched by name at any depth below the config
  that declares it** — as semantics, not performance. With R1 in it is worth 0%,
  because R1 has already removed the mass. It is worth doing because
  `exclude: [".venv"]` currently parses, validates and silently does nothing, and
  because after R1 lands the `exclude` list becomes the only way a user re-states
  an intention about a *tracked* directory. Note this changes an existing
  meaning, unlike its counterpart at defect 1 where `exclude` is not consulted at
  all.
- **R4 — key the traversal cache on base containment rather than exact
  `FilePatterns` equality** (`compiler_options.rs:91`) — for the last factor of
  1.7: 532 opens become 320. Alone it is 0.7% and not worth doing.

**Do not adopt R2.** 0.0% on every preset; it replaces one hardcoded name with
one hardcoded path. **Do not wait for R3, and take it if defect 1 lands it
anyway** — it is the same change at `collector.rs:177`, worth 0% by default and
99.1% once a user has narrowed `include` with a glob.

`apply-r1.py` applies it to a deno checkout:

```
python3 apply-r1.py /path/to/deno    # a v2.9.5 checkout
```

It adds `set_use_gitignore` beside the existing `use_gitignore()` builder, threads
the field through `CollectSpecifiersOptions`, passes `true` at
`compiler_options.rs`, and passes `false` at every other `collect_specifiers`
caller — `deno test`, `deno bench`, `deno doc`, the graph container — so no
behaviour outside the LSP moves. It exits non-zero if any anchor is not found
exactly once rather than patching something else.

A binary carrying it was built from a clean v2.9.5 checkout and measured on the
real workspace together with M5: the compiler-options stack — this traversal —
fell from **9,331 ms to 5,447 ms** while total directory opens fell 39,014 →
5,910. It falls by 42% rather than to nothing, which is R1 behaving as it is
specified to: it bounds the walk by the version-control ignore set, and tracked
mass is still walked. **42% is a long way from the 98.2% modelled below**, and
the two are not the same quantity — one is wall time on this stack in one run,
the other is modelled opens on a preset that puts nearly all of its mass in
untracked trees. What the 42% says about this repository is that a large part of
what its tsconfig bases contain is tracked. The full table is in
[`../real-workspace/`](../real-workspace/README.md#what-the-patches-are-worth).
Nothing else in this directory runs the patch: every other figure here is a model
or a stock-binary measurement.

## Why gitignore-by-default is safe here and not at defect 1

The same mechanism, the opposite verdict, for two measured reasons.

**This walk chooses seeds, and deno's module graph reaches everything a seed
imports.** Verified on the real binary in [`graph/`](graph/README.md), not
inherited from `tsc`: with the seed removed, hover still reports the literal type
and go-to-definition still lands in the file, for a `.ts` target and a generated
`.js` target alike, with no diagnostics in either arm. Dropping an untracked file
from the seed set drops it from the program only if nothing imports it — which
for build output, virtualenvs and caches is the intent, and for generated code
that *is* imported is not a drop at all.

**A tsconfig's `include` is where users write literal paths, so the include-path
override fires.** `GitIgnoreTree::new(sys, include_paths)` exempts explicitly
named include **paths** and deliberately not globs. Measured on the real binary
through `deno fmt`, which reaches the same collector with the flag on
(`diagnosis/evidence/gitignore-semantics.sh`):

```
arm            fmt include          src/  dist/  dist/sub/  dist/cache/  vendored/
no-include     absent                  1      0          0            0          1
literal-path   ["dist"]                0      1          1            0          0
glob-path      ["**/dist"]             0      0          0            0          0
literal-both   ["src","dist"]          1      1          1            0          0
```

`.gitignore` names `dist/` and `cache/`. Four facts, each load-bearing:

1. **With no `include` at all, the bound fires.** `dist/` is pruned and nothing
   else is. This is the case that mattered most: if the walk's base counted as an
   explicitly specified include path, the override would exempt the entire tree
   and the mechanism would be worth nothing. It does not.
2. **Naming a path literally in `include` re-admits it and its whole subtree** —
   `dist/`, `dist/sub/`, and deeper.
3. **A glob does not re-admit.** `include: ["**/dist"]` leaves `dist` ignored,
   exactly as the source comment says.
4. **A separate ignore rule below a re-admitted path still applies.**
   `dist/cache/` stays pruned under `include: ["dist"]`.

Fact 2 is what defect 1 could never have: member expansion reaches the collector
*because* its members are globs, so the override can never fire there. Here it
fires in the case that needs it — a workspace whose members all live under
`dist/` loses nothing, because each member's tsconfig says `include: ["src"]`,
that is a literal path, and the override re-admits its subtree. That same
workspace shape loses 2 of 2 members at defect 1.

## R1's one false negative

Six adversarial workspaces; `subject` is the fate of the one file each case is
about — `seed` (still collected), `graph` (dropped but reachable by import),
`gone`.

```
  case                      candidate      T2+T3  dropped  recov  lost  subject
  orphan-in-ignored         deno             206        0      0     0  seed
  orphan-in-ignored         R1                 4      201      0     0  gone
  imported-from-ignored     deno             206        0      0     0  seed
  imported-from-ignored     R1                 4      201      1     0  graph
  generated-js-imported     deno             206        0      0     0  seed
  generated-js-imported     R1                 4      201      1     0  graph
  include-names-untracked   deno             408        0      0     0  seed
  include-names-untracked   R1               206        0      0     0  seed
  member-inside-ignored     deno               8        0      0     0  seed
  member-inside-ignored     R1                 3        0      0     0  seed
  member-no-include         deno               6        0      0     0  seed
  member-no-include         R1                 1        1      0     1  gone
  tracked-only              deno               4        0      0     0  seed
  tracked-only              R1                 4        0      0     0  seed
```

R2, R3, X1 and X2 drop nothing in any of the six. R4 drops nothing by
construction: sharing a traversal cannot change what a walk collects. Only R1 has
anything to answer for, and it is **`member-no-include`**: a workspace member
inside a gitignored directory whose tsconfig names no `include`. With no literal
include path there is no override, the base is inside an ignored directory, and
the member's sources leave the root set with nothing importing them to bring them
back. **Carry that shape as a regression test if R1 ships.**

**The safety asymmetry holds, and it is narrower than "gitignore is safe here".**
At defect 1 a false negative means the workspace loses a member and the user gets
wrong answers everywhere. Here it means one file is not a *seed*: it is still
enumerated by `walk_workspace`, still opens as a document, still resolves as an
import target. What it loses is project-wide service without being opened — the
`orphan-in-ignored` row. For the file class this defect is about (virtualenvs,
`dist`, `.cache`, `__pycache__`) losing that is the stated intent.

## Two mitigations that work today, and are not patches

A user can mitigate this defect by hand and cannot mitigate defect 1 at all.
Adding `**/.venv`, `**/__pycache__` and `**/.pytest_cache` to the root
`tsconfig.json` of the 53-project workspace took
`refresh_compiler_options_resolver` from 103,000 ms to 13,900 ms while
`refresh_config_tree` stayed where it was. Read the direction, not the factor —
[`../real-workspace/`](../real-workspace/README.md) explains why those
milliseconds are not comparable; in opens, that exclusion removed 17% of the run,
and it removed it from this subsystem and not from defect 1's.

- `"files": []` in a root solution-style tsconfig removes 1,606 of 3,006 opens.
- `exclude: ["**/name"]` in every tsconfig removes 2,008 of 3,006.

Both point in opposite directions at once. They **lower the urgency**: anyone who
reads the right documentation, guesses the right spelling and repeats it in every
tsconfig gets most of the win on a released binary. And they **raise the severity
of the semantics**: the spelling that works is `**/.venv`; the spelling a
developer writes first is `.venv`, which parses, validates and does nothing. The
mitigation exists and is hidden behind a rule nobody has a reason to know.

## Against the recommendation

**`member-no-include` is a real loss and the study contains exactly one instance
of it.** It is one constructed workspace, not an observed one, and the argument
that it is tolerable rests on seeds not being reachability — measured with four
probes in one workspace shape, not proven.

**The `roots-pruned` arm is a stand-in, not the patch.** `graph/` removes files
from the root set with `exclude`, because `.use_gitignore()` cannot be switched
on from outside the binary. That the two are interchangeable is a claim about
`is_pattern_matched` — both predicates gate the same `handle_entry` — read from
the source at `collector.rs:143`, not measured end to end. A build carrying R1
now exists and was measured for **cost**; it was never re-run through `graph/`'s
probes, so what it collects has still not been compared against what the
`exclude` stand-in collects.

**`.gitignore` is someone else's statement of intent, and this reads it as
consent.** Defect 1 rejects the identical mechanism on that ground and the
rejection is right there. The difference claimed here is consequence, not
principle. Someone who holds that a tool should never infer intent from a file
written for another tool would reject R1 at both sites, and should read the
false-negative table as the cost of doing so — 98.2%.

**The model's coverage of the gitignore bound is four arms wide.** The override
rules are read from `collector.rs:100–124` and checked against `deno fmt` in four
configurations. A `.gitignore` with negations, globs, or per-directory files at
several levels is outside both the model — which throws rather than guessing —
and the check. The presets' `.gitignore` is written by the generator and it is
tidy: nine bare directory names, no negations, one file at the root. The 98.2% is
a figure for a tidy ignore file.

**The 66.8% is one workspace shape.** Three untracked trees, two members, one
tree inside the `include` root. A repository whose untracked mass sits outside
every tsconfig base pays none of this; one with fifty members pays the member
walks fifty times. The scale control varies mass, not shape.

**R1 changes what the LSP reports without being asked.** Diagnostics that today
appear for a generated file nobody imports will stop appearing. That is the
intent, and it is still a behaviour change someone may be relying on. X2 gives
them the way back only if they know to write it.

**Every projected second here is a projection.** Opens are the measurement.

## Layout

| path | what it is |
|---|---|
| [`diagnosis/`](diagnosis/README.md) | the stack capture, the differential attribution, the scale control, the gitignore semantics |
| [`matrix/`](matrix/README.md) | 46 controlled configurations characterising exactly this subsystem's `include`/`exclude` behaviour |
| [`graph/`](graph/README.md) | the real-binary test of whether the module graph recovers a dropped seed |
| [`arena/`](arena/README.md) | six candidate mechanisms, five conditions, six adversarial workspaces, the scaling law |
| `apply-r1.py` | the patch, applied to a deno v2.9.5 checkout |

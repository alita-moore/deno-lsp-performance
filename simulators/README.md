# The models

Two executable models: `deno.mjs` reproduces what `deno lsp` walks,
`typescript.mjs` reproduces which files `tsc` puts in a program. Both arenas
ablate fixes against them, so this exists to establish that they are faithful
enough to draw conclusions from — and to say exactly where they are not.

Both are pure functions over the `fs` port in `../lib/fs.mjs`. They read no
globals, open no sockets, and never touch `node:fs` directly, so the same model
runs against a real tree or an in-memory one.

```
denoResolve(fs, entryFile, corpus, order)
  -> { files, opendir, trace, phases, opens, globMembers, root }
tscResolve (fs, entryFile, corpus, order) -> { files, opendir, trace, root }
```

`opendir` counts directory opens; `trace` is the ordered list of directories
opened; `phases` is parallel to `trace` and names the traversal that made each
open, and `opens` is the per-traversal total — so any single traversal can be
counted or ablated on its own. `order` is the directory-ordering policy, injected
rather than fixed; everything here passes the identity policy. `corpus` is
accepted for the strategy interface and never consulted.

```
node calibrate.mjs [matrix-dir] [case-dir]
```

Exits non-zero on any mismatch. `matrix-dir` defaults to `$MATRIX_BUILD_ROOT`,
where `../harness/matrix.py` built the 46 workspaces; `case-dir` defaults to
`../defect-2-root-set/matrix/configs`.

---

## `deno.mjs` — four traversals

Deno's cost is not one walk. `denoResolve` runs four, in this order, and their
opens add up:

| | traversal | driven by | pruned | scope |
|---|---|---|---|---|
| T0 | `expandGlobMembers` | glob members of the root `package.json` `workspaces` and of the root `deno.json` `workspace` | `node_modules`, `.git`, one exact vendor path | **everything** below the globs' literal prefix |
| T1 | `walkWorkspace` | nothing | `node_modules`, `vendor`, `coverage`, `.git` | the entire workspace root |
| T2 | `collectSpecifiers` | root `tsconfig.json` | `node_modules` | its `include`, pruned by its `exclude` |
| T3 | `collectSpecifiers` | each workspace member's `tsconfig.json` | `node_modules` | its `include`, pruned by its own `exclude` |

T0 is [defect 1](../defect-1-member-globs/README.md); T2 and T3 are
[defect 2](../defect-2-root-set/README.md), one call site the model separates by
which config drives it. T1 consults no configuration at all.

```js
const globMembers = expandGlobMembers(fs, order, ctx, root);
walkWorkspace(fs, order, ctx, root);
collectTsconfigAt(fs, order, ctx, root);
for (const member of workspaceMembers(fs, root)) collectTsconfigAt(fs, order, ctx, member);
```

Four properties of T0 are modelled, each taken from the source at v2.9.5:

- **It expands glob workspace members.** `discovery.rs:889-903` partitions the
  members of the root `package.json`'s `workspaces` into glob patterns and
  literal paths and hands the glob ones to
  `collect_member_config_folders("npm", …, &["package.json"])`. The same
  collector is reached at `discovery.rs:822` for glob members of a `deno.json`
  `workspace`, there searching for `deno.json`, `deno.jsonc` **and**
  `package.json`. Both call sites are modelled; a literal, wildcard-free member
  is never expanded and costs nothing.
- **It prunes almost nothing.** `is_ignored_dir` skips `node_modules`, `.git`,
  and one exact vendor-folder path — the last only when `deno.json` sets
  `"vendor": true`. `include` patterns filter *files*, never directories.
- **It is breadth-first and de-duplicates across bases.** `collector.rs:177` pops
  from a `VecDeque` and `visited_paths` is shared across every pattern base in
  one call, so the model is a queue, not the recursion T1–T3 use.
- **It is bounded only by the globs' literal prefix.** `split_by_base` starts the
  walk at the longest wildcard-free prefix of each pattern.

T0 is charged **once per `ConfigData::load`**, i.e. once per scope, and
`denoResolve` charges exactly one. The measured session performs it at least
twice; multiplying is the arena's job, not the model's.

Deno's glob dialect is modelled separately from TypeScript's, in this file,
because the two disagree: **deno's `**` matches one-or-more segments,
TypeScript's matches zero-or-more.** `../lib/glob.mjs` implements the TypeScript
dialect and `deno.mjs` does not use it.

A `!`-prefixed workspace member throws `negated_workspace_member` rather than
being silently walked as if the negation were absent; a `workspaces` field that
is present but not an array throws `unmodelled_workspaces_shape`. An unmodelled
shape can never be mistaken for a measured result.

## `typescript.mjs` — root set, then import closure

Two phases, and the separation between them is the point:

1. `collectRootSet` — `files` entries are added verbatim, then each `include`
   pattern's literal prefix is walked, pruned by `exclude` and by the
   package-folder skip (`node_modules`, `bower_components`, `jspm_packages`).
   This is the only phase that opens directories.
2. `followImports` — a work queue over the root set, resolving relative
   specifiers to files on disk. It opens no directories and is not subject to
   `exclude`.

That split is TypeScript's actual semantics: **`exclude` governs seeds, never
reachability.** A file an included file imports is compiled even if `exclude`
names it, and `files` entries are not subject to `exclude` at all. This is the
property defect 2's recommendation rests on — for deno it was established
separately, on the real binary, in
[`../defect-2-root-set/graph/`](../defect-2-root-set/graph/README.md).

One quirk is modelled deliberately: the package-folder skip is overridden when an
`include` pattern names the folder *literally* (`include: ["node_modules"]`
enters it; `include: ["**/*"]` does not).

---

## Calibration

| check | compared against | result |
|---|---|---|
| `deno.mjs` T1–T3, 46 workspace configurations | `opendir` counts measured from deno 2.9.5 under an `LD_PRELOAD` shim | **46/46 exact** |
| `deno.mjs` T0, the member-glob expansion | the symbolised captures in `../defect-1-member-globs/diagnosis/evidence` | **exact on the sample, positional law reproduced** |
| `typescript.mjs`, the same 46 trees | real `tsc 7.0.2 --listFiles` | **46/46 match** |
| `typescript.mjs`, purpose-built semantics fixture | real `tsc 7.0.2 --listFiles` | **11/11 match** |

> **The 46 cases cannot exercise T0 at all.** `matrix.py` emits only
> `deno.json {"workspace": [explicit paths]}` — no root `package.json`, no globs
> — so the expansion has nothing to expand and opens **zero** directories in
> every one of them. The 46/46 was earned in a regime that structurally excludes
> defect 1. The calibrator prints `T0 fires on none of them` in its summary so
> this can never be read off as broader coverage than it is.

### The deno matrix

Both quantities are compared — total directory opens, and opens landing inside
the noise tree — and every case is exact on both.

| family | what it varies | opens range |
|---|---|---|
| A01–A10 | the noise tree's **name** and **position** | 408 – 1,219 |
| B01–B04 | `node_modules` in four positions | 7 – 13 |
| C01–C08 | `include` widened, `exclude` removed or emptied | 4 – 1,211 |
| D01–D09 | five `exclude` spellings in the package, four at the root | 408 – 809 |
| E01–E06 | tsconfig deleted, `files` list, `composite`, `references`, noise at root | 7 – 809 |
| F01–F50 | 1 → 50 workspace members | 809 – 1,054 |
| G01–G50 | 1 → 50 members each with `node_modules` | 7 – 252 |

The model has no per-case branches. One structure reproduces a range spanning two
orders of magnitude, including the cases that differ by exactly one open (`D07`
408 against `D08` 409, where `**/.venv/**` matches the tree's *contents* so the
directory itself is opened once before its children are pruned).

### The member-glob expansion

Two fixtures, built in memory by `control.mjs`, both mirroring a real tree
exactly.

**The sample.** `sampleRepo(1500)` reproduces
`../defect-1-member-globs/diagnosis/sample` after `generate-noise.sh` at
`NOISE=1500`: two members under `packages/`, a `.venv` and a `dist` of 1,500
packages inside each, a `node_modules` inside one, and a `.venv-at-root` outside
the glob prefix.

| | opens |
|---|---|
| deno 2.9.5, the `refresh_config_tree` stack, measured | **12,009** of 21,192 |
| `deno.mjs` T0 | **12,009** |

Open-for-open, not an order-of-magnitude estimate. The count decomposes as
`packages` + 2 members + 2 × (`src` + 3,001 `.venv` + 3,001 `dist`), with
`node_modules` pruned and `.venv-at-root` never reached.

**The positional control.** `positionControlRepo(800, position)` is
`position-control.sh` in memory: one identical 1,601-directory `.venv`, moved.
The script reports one number per arm — every stack summed — so it was re-run
with the stacks kept apart, by setting `ST_MATCH="/.venv"` and symbolising rather
than summing `TOTAL` lines:

| arm | stack | deno | `deno.mjs` |
|---|---|---|---|
| `inside-member` | member-glob expansion, under `initialized` | **1,601** | **T0 = 1,601** |
| `inside-member` | `Inner::refresh_workspace_files` | 985 | T1 = 1,601 |
| `inside-member` | member-glob expansion, under `did_change_configuration` | 1 | not charged |
| `inside-member` | *total* | *2,587* | *3,202, being T0 + T1* |
| `at-root` | member-glob expansion | **0** — the stack does not appear | **T0 = 0** |
| `at-root` | `Inner::refresh_workspace_files` | 1 | T1 = 1,601 |
| `at-root` | *total* | *1* | *1,601* |

**The traversal under calibration is open-for-open exact in both arms.** The
aggregate 2,587 was never a single quantity — it is 1,601 + 985 + 1 across three
stacks. Both divergences are T1's and both are stated in the limits below rather
than averaged away.

One incidental finding from the same capture: the second expansion, under
`did_change_configuration`, cost **1** open here and **8,192** on the sample. The
per-scope charge is real; multiplying a single expansion by a fixed number of
config loads is an upper bound, not a law.

**The four presets.** `../lib/realistic.mjs` places vendor trees inside
glob-matched members; `small` deliberately has none, as a negative control.

| preset | dirs in tree | T0 | T1 | T2 | T3 | total | T0 inside member trees | member trees |
|---|---|---|---|---|---|---|---|---|
| `small` | 383 | 21 | 22 | 22 | 10 | 75 | **0** | none |
| `medium` | 4,343 | 2,541 | 2,542 | 2,542 | 60 | 7,685 | 2,420 | `.venv` |
| `large` | 22,483 | 14,821 | 14,822 | 14,822 | 240 | 44,705 | 14,460 | `.venv` |
| `reported` | 36,372 | 29,045 | 29,046 | 29,046 | 212 | 87,349 | 28,726 | `.venv`, `.cache` |

The calibrator also asserts, on every preset, that the member set T0 discovers is
exactly the member set the repository declares. A pruning change that made T0
cheap by losing a member would fail calibration rather than look like a win.

### The semantics fixture

`fixture.mjs` materialises eleven single-purpose trees. Each case states its
expected file set independently, in the fixture definition; the calibrator checks
that real `tsc` agrees with the stated expectation **and** that the simulator
agrees with real `tsc`. A case passes only if all three coincide.

| case | claim |
|---|---|
| `include-dir` | `include` selects a directory subtree |
| `import-escapes-include` | the import closure reaches outside every include root |
| `exclude-imported-dir` | `exclude` of a directory does not drop a file imported from inside it |
| `exclude-imported-file` | `exclude` of a file does not drop it when an included file imports it |
| `exclude-unimported-file` | `exclude` of a file nothing imports does drop it |
| `files-only` | `files` seeds the program and nothing else is enumerated |
| `files-ignores-exclude` | `exclude` does not apply to a `files` entry |
| `files-with-include` | `files` and `include` union |
| `default-skips-node-modules` | an absent `include` defaults to `**/*` and still skips `node_modules` |
| `glob-skips-node-modules` | a glob that would match `node_modules` does not override the skip |
| `literal-include-enters-node-modules` | naming `node_modules` literally in `include` overrides the skip |

### Build artifacts

`tsc -p` on a `composite: true` config **writes into the tree it is pointed at**.
The calibrator redirects `--outDir`, `--declarationDir` and `--tsBuildInfoFile`
to a scratch directory (`$CALIBRATE_WORK`, default under the system temp dir) for
exactly that reason, then audits the matrix for `*.js`, `*.d.ts` and
`*.tsbuildinfo`. A non-empty audit is a calibration failure, not a warning.

---

## Limits

### What the calibration does not prove

**The 46-case matrix cannot exercise T0, and T0 is the dominant real-world
cost.** Read literally, the 46/46 says: *in a regime that structurally excludes
the traversal responsible for 12,009 of 21,192 opens on the traced sample, the
model is open-for-open correct.* That is worth having, and it is not evidence
about defect 1. T0's evidence is one sample, one positional control and four
presets — a far smaller body than 46.

**The tsc 46/46 is weaker than it sounds.** The matrix noise trees are all `.py`,
invisible to TypeScript, so 44 of those 46 programs are a single file and the
other 2 are empty. Agreeing on a one-file program mostly proves the simulator
does not *over*-collect. **The 11 purpose-built cases are the load-bearing
evidence for `typescript.mjs`;** the 46 are a non-regression check.

**The `sim_into` column reproduces the measurement harness's counting convention,
not an ideal one.** The `LD_PRELOAD` shim counted an open as "inside the tree"
when the absolute path contained the tree's leaf name; for `A05`, `A06`, `A07`
and `A08` the case directory itself is named after the tree, so both the measured
and the simulated figure include the 7 opens outside it. `in_tree` is the
segment-accurate count and is printed so the difference is never hidden.

**`sim_dirs` in the tsc table is not calibrated.** Only the resulting file set is
compared against real `tsc`. TypeScript's actual syscall count was never
measured; do not quote those directory counts as tsc's real cost.

### `deno.mjs`

Models one cold resolve of deno 2.9.5's file enumeration. It does not model:

- **The 1,000-entry document-preload limit on T1.** `walk_workspace` stops after
  1,000 file-system entries; T1 walks to exhaustion. No matrix case could expose
  this — T1 peaks at 502 opens across all 46 — but the positional control does:
  with the `.venv` inside a member that traversal stops at 985 where T1 makes
  1,601, and with the tree at the repository root it makes **1** where T1 still
  makes 1,601. **T1 over-counts, and over-counts most where a tree sits outside
  every member glob.** T0 is unaffected: it makes zero opens there, which is the
  property the calibration checks.
- **Repeat work.** This counts one pass. T0 is charged once per
  `ConfigData::load` and the traced session performs it at least twice, and the
  second pass is not a repeat of the first — 8,192 against 12,009 on the sample,
  1 against 1,601 on the positional control. Per-resolve opens are the right unit
  for comparing strategies, not for predicting a session's total.
- **Time.** Opens are counted, never costed.
- **`deno.json` `include`/`exclude` and `deno.enablePaths`.** Only
  `tsconfig.json` drives T2/T3 here, and whether `collect_specifiers` honours
  `enablePaths` at all is an open question, not a modelled fact.
- **`extends`, project `references`, nested workspaces.** `references` is present
  in the matrix and removing it changes nothing (`E04`), which is evidence it is
  inert *for these shapes*, not that reference graphs are never walked.
- **The npm/JSR module graph, remote specifiers, symlinks, `realpath`.**
- **File contents.** No source file is read; anything import-driven is out of
  scope for this model.
- **`.gitignore`.** The traced collector is constructed without
  `.use_gitignore()`, so ignoring it is faithful for T0 as measured — but the
  model cannot answer what a gitignore-aware collector would cost. That is the
  arenas' ablation, not this model's.
- **Any deno other than 2.9.5.**

The 46 trees are synthetic and shallow: one `.ts` file per member, one noise
tree, at most 50 members. T0's fixtures are narrower still: two shapes, both
`packages/*`. A member glob with a wildcard in a middle segment, several member
globs with different literal prefixes, or a `!` negation are all unmeasured.

### `typescript.mjs`

Models which files land in a program. It does not model:

- **Parsing.** The import closure is a regex over source text. It catches
  relative `import`/`export … from "…"` and bare `import "…"`. It does not handle
  dynamic `import()`, `require`, `/// <reference>`, or specifiers inside comments
  and strings, which it will match as if they were real.
- **Non-relative resolution.** Bare specifiers, `paths`/`baseUrl`, package
  `exports`, `typeRoots` and automatic `@types` inclusion are all absent.
- **Default libs.** `lib.*.d.ts` is filtered out of the comparison entirely.
- **`extends`, `references`, solution-style configs.** A single `tsconfig.json`
  is read.
- **`allowJs`, `.json` modules, declaration-only inputs.**
- **`outDir` self-exclusion.** Real `tsc` adds `outDir` to the default `exclude`;
  the calibrator redirects `outDir` out of the tree, so this path is never
  exercised.
- **Resolution modes other than the one tested.** The fixture uses
  `moduleResolution: "bundler"`; `nodenext` differs in ways not covered.

`tsc 7.0.2` is the only version compared against.

# The 46-case configuration matrix

46 workspaces, identical except for the field under test, measured on the real
binary. This is the precise characterisation of **this** subsystem: what
`include` and `exclude` actually do to the traversals they reach.

**It cannot reach defect 1.** `../../harness/matrix.py` emits a root `deno.json`
with explicit member paths and **no root `package.json` at all**, so
`handle_workspace_folder_with_members` never runs and the member-glob expansion
opens zero directories in every one of the 46 cases. Everything below is a
statement about `collect_specifiers` under `refresh_compiler_options_resolver`,
plus the workspace-root walk — and about 22% of the real workspace's opens.

```
DENO_BIN=... DIRLOG_SO=... MATRIX_BUILD_ROOT=... python3 ../../harness/matrix.py
python3 ../../harness/matrix.py D          # one group
python3 ../../harness/matrix.py A01 D06    # named cases
```

Each case is the same workspace — a root `deno.json` listing one member `app`, a
root `tsconfig.json`, a package `deno.json`, a package `tsconfig.json` with
`include: ["src"]`, and one source file `app/src/index.ts` — plus one **noise
tree** of 401 directories containing no TypeScript, placed where the case calls
for it. The probe opens the source file and asks for a definition. Full run:
`evidence/matrix-46-configs.txt`.

Two properties make the totals readable:

- One full walk of a noise tree is **401 opens**. Fixed overhead for the
  surrounding workspace is **7 opens**. Every total is `7 + 401 × walks`, plus a
  few for intermediate directories where the tree is placed deep. The `walks`
  column below is that arithmetic.
- `into_tree` matches the tree's name anywhere in the path, so in the four cases
  whose id contains the tree's own name (`A05`, `A06`, `A07`, `A08`) it matches
  the build directory too and equals the total. **`opendir` is the column to
  read**; `into_tree` is a cross-check everywhere else.

## Three traversals, bounded to the matrix

A noise tree here is walked zero, one, two or three times, and the three walks
respond to different settings. They separate from the measurements alone:

| | traversal | identified by | what it skips |
|---|---|---|---|
| T1 | the workspace-root walk | `vendor` and `coverage` lose one walk while `.venv` and `target` do not (A05, A08 against A01, A06) — only one traversal has a name skip list | a hardcoded name list: `node_modules`, `vendor`, `coverage`, `.git` |
| T2 | the root tsconfig's file collection | the root tsconfig's `exclude` removes exactly one walk (D06, D07 against D01) | `node_modules` |
| T3 | the package tsconfig's file collection | the package tsconfig's `include`/`exclude` adds or removes a walk, and only within its own `include` root (C01, C02, C08) | `node_modules` |

T1 is `walk_workspace` and T2/T3 are `collect_specifiers` calls, per the source
of deno 2.9.5:

| location | what is there |
|---|---|
| `cli/lsp/language_server.rs:1065` | `walk_workspace`; the four-name skip list; the 1,000-entry cap; honours `deno.enablePaths` |
| `cli/lsp/compiler_options.rs:87` | `from_inner`, which calls `collect_specifiers` once per distinct tsconfig `FilePatterns` |
| `cli/util/fs.rs:91` | `collect_specifiers`, the recursive walk |
| `cli/lsp/tsc.rs:5589` | `op_script_names`, which consumes the resolver's completed entry set |

That identification is inference from behaviour and source; the stack capture was
run against the real workspace and the reproduction in `../diagnosis`, not
against this grid. None of the counts depend on it.

**T1's 1,000-entry cap is why this structure does not scale up.** A 401-directory
noise tree fits under the cap, so T1 walks all of it here. The real workspace does
not fit, so T1 stops after 1,000 entries and contributes 0.2% of its opens. A
matrix result about T1 is a result about small workspaces.

## A — the directory's name decides whether it is walked

Config held at `include: ["src"], exclude: ["node_modules", "dist"]`. Only the
noise tree's name and position change.

| case | tree | position | `opendir` | `into_tree` | walks |
|---|---|---|---:|---:|---:|
| A01-sibling | `.venv` | `app/.venv` | 809 | 802 | 2 |
| A02-in-src | `.venv` | `app/src/.venv` | 1,210 | 1,203 | 3 |
| A03-deep | `.venv` | `app/src/a/b/c/.venv` | 1,219 | 1,203 | 3 |
| A04-dotcache | `.cache` | `app/.cache` | 809 | 802 | 2 |
| A05-vendor | `vendor` | `app/vendor` | 408 | 408 | 1 |
| A06-target | `target` | `app/target` | 809 | 809 | 2 |
| A07-build | `build` | `app/build` | 809 | 809 | 2 |
| A08-coverage | `coverage` | `app/coverage` | 408 | 408 | 1 |
| A09-next | `.next` | `app/.next` | 809 | 802 | 2 |
| A10-pycache | `__pycache__` | `app/__pycache__` | 809 | 802 | 2 |

`vendor` and `coverage` are on T1's skip list but not on T2's, so they are walked
once. `.venv`, `.cache`, `target`, `build`, `.next` and `__pycache__` are on
neither, so they are walked twice — three times when they sit inside the
package's `include` root, where T3 reaches them as well.

Position, holding the name constant: beside `src` costs two walks, inside `src`
costs three, and depth below that changes nothing — A03 adds 9 opens over A02,
the three intervening directories seen by three traversals.

## B — `node_modules` in four positions

| case | tree | `opendir` | `into_tree` |
|---|---|---:|---:|
| B01-nm-sibling | `app/node_modules` | 7 | 0 |
| B02-nm-in-src | `app/src/node_modules` | 7 | 0 |
| B03-nm-deep | `app/src/a/b/node_modules` | 13 | 0 |
| B04-nm-nested | `app/node_modules/.deno/x/node_modules` | 7 | 0 |

Skipped by all three traversals in every position, including nested inside
another `node_modules`. B03's 13 is the two intervening directories walked by
three traversals each. **This is the control: 7 opens is what the workspace costs
when nothing walks the noise tree.**

## C — configurations that explicitly ask for the excluded tree

| case | config | `opendir` | `into_tree` |
|---|---|---:|---:|
| C01-include-nm | package `include: ["src", "node_modules"]` | 408 | 401 |
| C02-include-nm-only | package `include: ["node_modules"]` | 407 | 401 |
| C03-include-venv | package `include: ["src", ".venv"]` | 1,210 | 1,203 |
| C04-include-star | package `include: ["**/*"]` | 1,211 | 1,203 |
| C05-include-nm-root | root `include: ["node_modules"]` | 4 | 0 |
| C06-no-exclude-at-all | package `include: ["src"]`, no `exclude` | 809 | 802 |
| C07-empty-exclude | package `exclude: []` | 809 | 802 |
| C08-exclude-src | package `exclude: ["src"]` | 808 | 802 |

**`include` overrides the hardcoded skip; nothing else does.** A package that
names `node_modules` in `include` gets it walked — once, by T3 (C01, C02, against
B01's 0). T1 and T2 still skip it.

**`exclude` is live, and it is scoped to the walk that was already cheap.**
`exclude: ["src"]` in the package tsconfig removes T3's only walk: 809 → 808. One
open, because `src` is one directory. That single open is the entire reach of a
package-level `exclude` in this layout. The 802 opens into the noise tree are
unaffected, because T3 never went there.

**C05 is confounded and proves nothing on its own.** Its root
`include: ["node_modules"]` changes two things at once: it introduces a root
`include` where there was none, and it names a path — `<root>/node_modules` —
that does not exist in this layout, the tree being at `<root>/app/node_modules`.
The 4-open total is consistent with the anchoring rule and equally consistent
with any root `include` narrowing T2 to nothing. The anchoring rule is
established by H1–H3 below, which vary the path with the spelling held fixed, and
the wildcard question by the `root-include-glob` / `root-include-path` arms in
[`../diagnosis`](../diagnosis/README.md), which vary the spelling with the path
held fixed. C05 is reported for completeness and is evidence for neither.

## D — nine spellings of one exclusion

The tree is at `app/.venv` in every case. The exclusion is written in the package
tsconfig (D01–D05) or the root tsconfig (D06–D09).

| case | file | `exclude` entry | `opendir` | `into_tree` | walks |
|---|---|---|---:|---:|---:|
| D01-pkg-plain | package | `.venv` | 809 | 802 | 2 |
| D02-pkg-glob | package | `**/.venv` | 809 | 802 | 2 |
| D03-pkg-slash | package | `.venv/` | 809 | 802 | 2 |
| D04-pkg-starstar | package | `**/.venv/**` | 809 | 802 | 2 |
| D05-pkg-abs | package | `./.venv` | 809 | 802 | 2 |
| D06-root-plain | root | `app/.venv` | 408 | 401 | 1 |
| D07-root-glob | root | `**/.venv` | 408 | 401 | 1 |
| D08-root-starstar | root | `**/.venv/**` | 409 | 402 | 1 |
| D09-root-bare | root | `.venv` | 809 | 802 | 2 |

**No spelling in the package tsconfig changes anything** — D01–D05 all equal C06,
the no-`exclude` case. Not because the setting is ignored, C08 proved it is live,
but because the walk it governs is confined to `include: ["src"]` and never
approaches `.venv`.

**In the root tsconfig, three of four spellings bind and the fourth fails for a
specific reason.** A wildcard-free entry is a literal path resolved against its
own config's directory:

| entry | resolves to | tree at `app/.venv` |
|---|---|---|
| `app/.venv` | `<root>/app/.venv` | matched |
| `**/.venv` | pattern | matched |
| `**/.venv/**` | pattern over the tree's *contents* | directory opened once, its 400 children pruned — the +1 in D08 |
| `.venv` | `<root>/.venv`, which does not exist | not matched, nothing excluded |

Deno's pattern parser treats an entry without a wildcard as a path, not as a name
to look for at any depth. **The exclusion a developer would write first is the
one that silently does nothing.**

Three controls, run with the same harness outside the grid
(`evidence/exclude-anchoring-controls.txt`), separate the spelling from the path:

| control | root `exclude` | tree at | `opendir` | `into_tree` |
|---|---|---|---:|---:|
| H1 | `.venv` | `<root>/.venv` | 408 | 401 |
| H2 | `**/.venv` | `<root>/.venv` | 408 | 401 |
| H3 | `.venv` | `app/.venv` | 809 | 802 |

H1 against H3: the same entry, in the same file, excludes the tree when the tree
is where the entry points and does nothing when it is one directory deeper. D09
names a path that does not exist; it is not a spelling that is ignored.

H2 against D07: `**/.venv` matches `<root>/.venv` and `<root>/app/.venv` alike,
so **`**` absorbs zero path segments as well as one.**

```
cd ../../harness
DENO_BIN=... DIRLOG_SO=... MATRIX_BUILD_ROOT=... python3 - <<'EOF'
import matrix
for cid, exc, at in (("H1", ".venv", ".venv"), ("H2", "**/.venv", ".venv")):
    c = matrix.case(cid, pkg_tsconfig=matrix.INC_SRC,
                    root_tsconfig={"exclude": ["node_modules", exc]}, noise_at_root=at)
    print(cid, matrix.measure(c, matrix.build(c)))
EOF
```

**Where the exclusion binds, it removes one walk of two.** D06 and D07 leave 401
opens standing, T1 still walking the tree. On the real workspace the residue is
larger and lands elsewhere: excluding `.venv` in the root tsconfig removed 17% of
the opens and left 17,290 opens into `.venv` behind, because the traversal that
produced them is neither T1 nor T2 — it is defect 1.

## E — the tree is walked whatever the package tsconfig says

| case | config | `opendir` | `into_tree` |
|---|---|---:|---:|
| E01-no-pkg-tsconfig | package tsconfig deleted | 808 | 802 |
| E02-files-list | `files: ["src/index.ts"]` instead of `include` | 808 | 802 |
| E03-no-composite | `include: ["src"]`, no `composite` | 809 | 802 |
| E04-no-references | root `references: []` | 809 | 802 |
| E05-noise-at-root | tree at `<root>/.venv`, not `app/.venv` | 809 | 802 |
| E06-noise-root-nm | `node_modules` at `<root>` | 7 | 0 |

Deleting the package tsconfig entirely leaves 802 opens into the tree — the one
open it removes is T3's walk of `src`, the same open `exclude: ["src"]` removes
in C08. Replacing `include` with `files` does the same. Neither `composite` nor
project `references` matters. **The tree is walked because T1 and T2 walk
everything below their roots, not because some tsconfig asked for it.**

## F and G — what scales with workspace size

| case | members | `opendir` | `into_tree` |
|---|---:|---:|---:|
| F01-packages | 1 | 809 | 802 |
| F02-packages | 2 | 814 | 802 |
| F05-packages | 5 | 829 | 802 |
| F10-packages | 10 | 854 | 802 |
| F25-packages | 25 | 929 | 802 |
| F50-packages | 50 | 1,054 | 802 |
| G01-packages-nm | 1 | 7 | 0 |
| G10-packages-nm | 10 | 52 | 0 |
| G50-packages-nm | 50 | 252 | 0 |

Each additional member costs a flat 5 opens, with or without a noise tree
present: (1,054−809)/49 = 5, and (252−7)/49 = 5. The cost of a tree does not
scale with member count — 802 at one member and at fifty. **Within this
subsystem, workspace size is not the variable; what is on disk under the
workspace root is.** Members declared through a root `package.json`, which is the
shape the real workspace has, are not measured here at all.

## What these 46 cases rule out

| hypothesis | measurement |
|---|---|
| a vestigial package tsconfig triggers the walk | deleting it changes 809 to 808 (E01) |
| `exclude` is unimplemented | it is implemented and correct; `exclude: ["src"]` binds (C08) |
| the package-level `exclude` spelling was wrong | all five spellings are equal to no `exclude` at all (D01–D05) |

## The case definitions

`configs/<case-id>/` holds `case.json` — byte-identical to its entry in
`../../harness/matrix.py` — and the four configuration files that case emits:
`deno.json`, `tsconfig.json`, `app__deno.json`, `app__tsconfig.json`
(`app0__*` where the case has several packages). The noise trees are not stored:
they are 401 empty directories, regenerated by `matrix.py`.

| prefix | cases | what it isolates |
|---|---:|---|
| A | 10 | the noise tree's **name** and **position**, config held constant |
| B | 4 | `node_modules` in four positions, including nested inside another |
| C | 8 | configurations that explicitly ask for the tree that is normally skipped, and an `exclude` aimed at a directory that *is* reached |
| D | 9 | nine spellings of one exclusion, five in the package tsconfig and four at the root |
| E | 6 | config shape: no package tsconfig, `files`, no `composite`, no `references`, tree at root, `node_modules` at root |
| F | 6 | member count 1 → 50 with the noise tree held fixed |
| G | 3 | the same scaling with `node_modules` as the tree, so per-member overhead is measured without tree cost |

The comparisons that carry the result:

```
A01-sibling           vs  A05-vendor           identical tree, different name:      809 vs 408
D01-pkg-plain         vs  D06-root-plain       identical exclusion, different file: 809 vs 408
D06-root-plain        vs  D09-root-bare        same file, anchored vs unanchored:   408 vs 809
C06-no-exclude-at-all vs  C08-exclude-src      package exclude that does bind:      809 vs 808
B01-nm-sibling        vs  C02-include-nm-only  hardcoded skip vs explicit include:    7 vs 407
```

`evidence/matrix-46-configs.txt` is the sweep; `wall_ms` in it is dominated by
fixed language server startup and is not a signal.

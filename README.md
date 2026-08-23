# Why `deno lsp` takes a hundred seconds to answer the first request

One go-to-definition in a 53-project monorepo cost `deno lsp` **51,315 directory
opens**, 103 seconds inside `refresh_compiler_options_resolver` and 59 seconds
inside `refresh_config_tree`. Enumerating every file in that workspace takes
**221 ms**. The gap between those two figures is work nothing asked for.

There are **six defects**. Five have patches, built from a clean `v2.9.5`
checkout and measured on the real workspace. The sixth has no fix — only an
instrument, an environment-variable gate that *skips* the work rather than
removing the redundancy, showing that about 20 seconds of `op_script_names` is
apparently redundant.

With all six applied the first `documentSymbol` after opening a file goes from
**120.5 s to 18.6 s**, a factor of 6.5, and the `did_change_configuration` span
from **75.1 s to 1.5 s**, a factor of 50.

## Read the result this way

**The patched binary reaches *acceptable*, not *solved*.** Eighteen seconds to
the first document symbol is a number a person can work through. It is not a
number anyone should be satisfied with, and nothing here claims the remaining
time is irreducible — only that it was not what this study chased.

**There are likely more problems beneath the surface.** Six defects came out of
pulling on one thread — a single slow go-to-definition — and each one was found
while measuring the last. Nothing about the way the sixth was reached suggests
the thread ended; it suggests the measurement stopped.

**None of these are recommended production patches.** Every patch here is the
smallest change that isolates and demonstrates its defect, chosen so that the
measurement attributes cleanly, not so that it could be merged. Two are
explicitly not mergeable: the [export-key gate](defect-4-export-keys/README.md)
*skips* work rather than removing the redundancy, and
[defect 5's patch](defect-5-workspace-inert/README.md) changes a tested contract
— `cargo test -p deno_config --all-features` goes 168 → 167, and the failing test
is one that asserts the `deno.json`/`package.json` member union on purpose. The
hope is that this prompts a deeper investigation by the people who own the code,
not that these diffs get merged.

| | what it is | fix | size |
|---|---|---|---|
| **1** | [member-glob expansion](defect-1-member-globs/README.md) walks every directory under every matched workspace member | **M5**, bound the descent by the member glob | 78% of the directory opens |
| **2** | [tsconfig root-set collection](defect-2-root-set/README.md) walks every directory under every tsconfig base | **R1**, honour the version-control ignore set | 22% of the directory opens |
| **3** | [npm dependency resolutions](defect-3-dep-resolutions/README.md) built eagerly for all 73 resolver scopes, most never used | hold them in a `OnceLock`, build on first use | the arm carrying it takes `did_change_configuration` 41.5 s → 2.1 s |
| **4** | [`op_script_names`](defect-4-export-keys/README.md) costs 42 s, and skipping export-key enumeration removes 20 of them | **none — this one is unsolved** | 20 s of a 42 s op, and half the `documentSymbol` latency |
| **5** | [`deno.json`'s `workspace` field cannot bound membership](defect-5-workspace-inert/README.md): the member set is the union with `package.json`'s `workspaces`, and the field is inert in 11 of 13 measured shapes | **A!**, make the declaration authoritative and name every directory it drops — **a semantic change to a tested contract** | 17 of this repository's 69 config folders are members nobody declared; in a controlled sweep each member costs 5.0 ms of `did_change_configuration` and 1.32 MB |
| **6** | [one npm resolution graph per workspace member](defect-6-dependency-graph/README.md), each seeded with every specifier in the whole `deno.lock` and deep-cloned again on every request | share the per-request snapshot behind an `Arc`; the per-scope duplication at config load is untouched | **1,095 MB** resident before a file is open, and **213 MB more per request in flight** |

Defects 3 and 4 both bear on
[denoland/deno#36662](https://github.com/denoland/deno/issues/36662), *"deno lsp:
same npm package folder resolved 744x per graph build when node_modules exists"*.
Defect 6 is the same area — per-scope npm resolution — arrived at from the memory
side rather than the latency side.

## Defects 1 and 2 are one line, reached two ways

Both bottom out at `libs/config/glob/collector.rs:178`, the `fs_read_dir` inside
`FileCollector::collect_file_patterns`, reached by two callers that share nothing
else. Each needs its own fix, because the same mechanism is unsafe at one and
safe at the other, for a measured reason.

```
initialized
│
├─ refresh_config_tree                 77.8% of opens        DEFECT 1
│    ConfigData::load → WorkspaceDirectory::discover
│      handle_workspace_folder_with_members     discovery.rs:898
│        collect_member_config_folders ──────────┐
│                                                │
└─ refresh_compiler_options_resolver   21.9%     │          DEFECT 2
     LspCompilerOptionsResolver::from_inner      │  compiler_options.rs:87
       collect_specifiers                        │  cli/util/fs.rs:91
         FileCollector::collect_file_patterns ───┤
                                                 │
                                                 └─▶ sys.fs_read_dir
                                                       collector.rs:178
```

| | defect 1 — member-glob expansion | defect 2 — tsconfig root set |
|---|---|---|
| what it is walking for | a `package.json` under each member glob | every script and JSON file under each tsconfig base |
| honours | **nothing a user can write** | the tsconfig's `exclude`, and only that |
| prunes | `node_modules`, `.git`, one exact vendor path | `node_modules`, `.git`; `vendor_folder` is always `None` here |
| runs | once per `ConfigData::load`, i.e. per scope | once per distinct tsconfig `FilePatterns` |
| share of the traced run | 33,194 opens, 77.8% | 9,332 opens, 21.9% |
| **the fix** | **M5** — bound the descent by the member glob | **R1** — honour the version-control ignore set |
| where | `libs/config/glob/collector.rs:177` | `cli/lsp/compiler_options.rs:99`, `cli/util/fs.rs:135` |
| what it buys | 29,045 modelled opens → **54** per load | 29,258 modelled opens → **532** |
| why it is the right one | it cannot prune a directory a member could occupy | its false negatives are recoverable through the module graph |

Both fixes change the growth term rather than dividing a constant. Today's
member expansion is Θ(mass inside matched members); a glob-bounded one is
Θ(members). Today's root-set collection is Θ(untracked mass inside the tsconfig
bases); a version-control-bounded one is Θ(tracked files). Every other candidate
measured halves a quantity that keeps growing.

## The asymmetry, which is the substance of the defect-1/defect-2 result

Gitignore-by-default is the obvious single fix for both call sites. It is
**unsafe at defect 1 and safe at defect 2**, and the difference was measured, not
argued.

At defect 1, pruning by `.gitignore` loses workspace members. A repository whose
packages are generated into an ignored directory ceases to have any members at
all — measured, 2 of 2 lost. `GitIgnoreTree` has a defence for this, an override
for explicitly named include **paths**, and it cannot fire here: member expansion
reaches the collector *because* the members are globs, and a literal member is
never expanded.

At defect 2, the same pruning drops **seeds**, not reachability. A file an
included file imports enters the program through the module graph whether or not
it was a seed — verified on the real binary, not inherited from `tsc`: hover
reports the literal type and go-to-definition lands in the file with the seed
removed. And here a tsconfig's `include` is exactly where a user writes literal
paths, so the include-path override fires in the case that needs it — a member
whose tsconfig says `include: ["src"]` keeps its sources even inside an ignored
directory.

That is why there are two fixes and not one.

## Defect 5 is the same failure class, one level up

Defect 1 makes member expansion cheap. Defect 5 asks why there are so many
members to expand. On this repository deno's resolver returns **69 config
folders** where the `deno.json` `workspace` list alone would return 52, because
membership is the **union** of that list and `package.json`'s `workspaces` globs
and neither of the two `if` blocks that build the map reads the other's result.
Across thirteen adversarial workspace shapes the `workspace` field changes the
resolved member set in **two**; in the other eleven it is inert.

The recommendation is **A!** — skip the npm block when a `deno.json` declares a
workspace, and print every directory that skip drops. The bare skip without the
warning has a measured silent loss and is disqualified on it, which is the same
reason the gitignore mechanism was rejected at defect 1. And the recommendation
carries a cost the other five do not: it fails a `deno_config` test that asserts
the union on purpose. See
[the argument against it](defect-5-workspace-inert/README.md#the-argument-against-the-recommendation-which-is-not-small).

## Defect 6 is where the memory is

`deno lsp` builds a resolver scope for every member of the npm workspace — not
the members the open file needs, and not the paths `deno.enablePaths` names, a
scoping claim settled by an ablation in which enabling one member instead of six
changes nothing measurable. Each scope is seeded with **every** npm specifier in
the workspace's single `deno.lock` and materialises its own copy of the resulting
2,567-package resolution graph. `Inner::snapshot()` then deep-clones every one of
those graphs on **every** LSP request, from 35 call sites.

A heap profile puts **88% of live bytes at configuration load and 73% at the
probe's peak** on `NpmResolutionCell::snapshot`, and `/proc/<pid>/smaps` puts
2,729 MB of a 4,619 MB resident set in `[heap]`, which only `malloc` reaches.
That is why the memory is flat once reached: glibc arena high-water, not a leak.

The patch shares the per-request snapshot behind an `Arc` instead of copying it.
It deliberately attacks only the per-request half, because sharing one cell
across scopes — what the `todo` in the source is really asking for — would let
one scope observe another's `add_npm_reqs` and change what a specifier resolves
to.

## What the patches are worth, measured

Binaries built from a clean `v2.9.5` checkout with `--features lsp-tracing` by a
GitHub Actions workflow, patched mechanically by the scripts in this tree, driven
through the same probe against the same workspace in one session. "Four patches"
is M5 + R1 + the lazy dependency resolutions + the export-key gate; "six patches"
is those plus defect 5 and defect 6. Full table, provenance and caveats in
[`real-workspace/`](real-workspace/README.md#what-the-patches-are-worth).

| metric | baseline | four patches | six patches |
|---|---:|---:|---:|
| `documentSymbol` | 120,486 ms | 21,322 ms | **18,587 ms** |
| `lsp.did_change_configuration` | 75,072 ms | 2,856 ms | **1,504 ms** |
| `definition` | 32,226 ms | 381 ms | **131 ms** |
| `tsc.op.op_script_names` | 63,190 ms | 15,707 ms | 15,350 ms |
| peak RSS | 2,629 MB | 1,826 MB | 1,861 MB |

- **`documentSymbol` 120.5 s → 18.6 s = 6.5×.** The user-visible figure. It
  includes the export-key gate, which must not be merged; an earlier session
  measured the three fixes that were real fixes at the time, without the gate, at
  126.7 s → 38.7 s.
- **`did_change_configuration` 75.1 s → 1.5 s = 50×.** A config-load span, not a
  request. It is the biggest ratio here and the easiest to misquote: the
  operation a person waits on got 6.5× faster, not 50×.
- **`definition` 32.2 s → 0.13 s.** The first definition after `didOpen`, so in
  the baseline arm it waits on the same cold resolver `documentSymbol` did.
- **Directory opens −84.9%** on a separate run, 39,014 → 5,910 with M5+R1 alone.

Three things this session does **not** establish:

- **The probe is a single-shot `documentSymbol` and `definition` cycle.**
  Defect 6's predicted win is on *sustained* request load — its own prediction is
  that the RSS rise over 96 requests, eight at a time, falls from +1,701 MB to
  under +100 MB. This probe issues nothing resembling that load, so it neither
  confirms nor refutes the prediction. The peak-RSS row is 1,826 MB with four
  patches and 1,861 MB with six; that comparison carries no information about
  defect 6.
- **`did_change_configuration` fell between the four- and six-patch arms, and
  this run cannot say why.** Defect 6 named config-load memory and
  `did_change_configuration` staying *unchanged* as its falsifier. The span did
  move, 2,856 ms → 1,504 ms. But defect 5's patch is in the same arm and it
  changes workspace membership, which is exactly what config load is proportional
  to. The two are confounded here and neither is credited with the drop.
- **Which patch removed which second, among the first three.** They arrived
  together in the earlier session's one arm. Only the export-key gate is isolated
  by an arm, and only there.

Each figure belongs to a patch group. M5 and R1 move the directory opens; the
lazy dependency resolutions move `did_change_configuration`; the export-key gate
moves `op_script_names` and half of `documentSymbol`; defect 5 moves member count
and defect 6 moves per-request memory.

## Memory

The mechanism is [defect 6](defect-6-dependency-graph/README.md): per-scope npm
resolution graphs at configuration load, plus a deep clone of every one of them
per request in flight. That is measured — 1,095 MB before a file is open, 213 MB
per in-flight request on this workspace, 88% of live heap at configuration load.

**The magnitude that started this is still not reproduced.** Editor sessions
against the real workspace reached **8.2 GB with M5+R1 and 10.6 GB in 72 seconds
with all four**, against 6.1 MB of workspace TypeScript and 348 MB of
`node_modules` declaration files. The furthest any instrumented arm reached is
**4.6 GB**, with eight requests in flight. Anyone quoting a measured figure
should quote 4.6 GB. Details, and a single user's subjective impression of the
six-patch binary in an editor — which is not a measurement — are in
[`real-workspace/`](real-workspace/README.md#memory).

## How to read the numbers

**Opens are the measurement; milliseconds are not** — except in the patched-arm
table above, where every column is one session on one machine and the point is
the comparison between columns. Two runs of the same regime on the real workspace
agree on total opens to within 10 of 42,666 — 0.02% — and disagree on
`refresh_compiler_options_resolver` by a factor of six. Wall time tracks dentry
cache warmth and machine load; the open count tracks the code path.

**Per-directory cost is not a constant.** 1.544 ms cold on a Docker Desktop bind
mount, 0.216 ms warm, 0.24 ms implied by the traced run, 3.2 ms implied by the
untraced one. Every wall-clock figure derived from an open count in this
directory is a projection at 1.544 ms and is labelled as one.

**A projection is never reported as a measurement, and neither is an
impression.** Defect 6's patch table of what it "should be worth" is prediction;
the editor-session note in [`real-workspace/`](real-workspace/README.md#memory)
is one person's subjective report. Both are labelled where they appear.

## Reproducing any of it

```
./defect-1-member-globs/diagnosis/run.sh          capture and symbolise defect 1
./defect-2-root-set/diagnosis/run.sh              capture and symbolise defect 2
./defect-2-root-set/diagnosis/evidence/walk-attribution.sh    what each traversal costs
./defect-2-root-set/diagnosis/evidence/scale-control.sh       how it grows
./defect-2-root-set/diagnosis/evidence/gitignore-semantics.sh how the bound behaves

node defect-1-member-globs/arena/run.mjs          the mechanism comparison
node defect-2-root-set/arena/run.mjs              the mechanism comparison
node defect-2-root-set/graph/run.mjs              does the graph recover a dropped seed
node simulators/calibrate.mjs                     are the models faithful

DENO_BIN=... DIRLOG_SO=... MATRIX_BUILD_ROOT=... python3 harness/matrix.py

./defect-5-workspace-inert/verify/build.sh          build both resolvers, baseline and patched
python3 defect-5-workspace-inert/arena/run.py       the false-negative table
WORK=... ./defect-6-dependency-graph/verify/run.sh  apply, rustfmt, cargo check, type-check probe
OUT_DIR=... FSLOG_SO=... DENO_BIN=... ./defect-6-dependency-graph/repro/sweep-synth.sh

python3 defect-1-member-globs/apply-m5.py /path/to/deno              apply M5
python3 defect-2-root-set/apply-r1.py /path/to/deno                  apply R1
python3 defect-3-dep-resolutions/apply-lazy.py /path/to/deno         apply the lazy fix
python3 defect-4-export-keys/gate-export-keys.py /path/to/deno       the instrument, not a fix
python3 defect-5-workspace-inert/apply-authoritative.py /path/to/deno   apply A!
python3 defect-6-dependency-graph/apply-shared-snapshot.py /path/to/deno  share the snapshot
```

Each patch script targets a v2.9.5 checkout and exits non-zero if any anchor is
not found exactly once, rather than patching something else. Everything that
touches the real binary needs a `deno` built with `--features lsp-tracing`; see
[`bin/README.md`](bin/README.md). The arenas, the simulators and the calibrator's
fixtures need only `node`.

## Where things are

| path | what it holds |
|---|---|
| [`real-workspace/`](real-workspace/README.md) | what it costs today on the repository that prompted this, which span owns each open, what the patches were worth, and the memory picture |
| [`defect-1-member-globs/`](defect-1-member-globs/README.md) | the member-glob expansion: diagnosis, mechanism comparison, the M5 recommendation |
| [`defect-2-root-set/`](defect-2-root-set/README.md) | the tsconfig root-set collection: diagnosis, the 46-case configuration matrix, the module-graph test, the R1 recommendation |
| [`defect-3-dep-resolutions/`](defect-3-dep-resolutions/README.md) | eager per-scope npm dependency resolution, and the lazy fix |
| [`defect-4-export-keys/`](defect-4-export-keys/README.md) | the `op_script_names` measurement, and why its patch must not be merged |
| [`defect-5-workspace-inert/`](defect-5-workspace-inert/README.md) | the inert `workspace` field: thirteen shapes, the false-negative table, the three-arm cost sweep, and the tested contract the fix breaks |
| [`defect-6-dependency-graph/`](defect-6-dependency-graph/README.md) | per-scope npm resolution graphs: the `enablePaths` ablation, the heap profile, the member-count scaling law, and the shared-snapshot patch |
| [`simulators/`](simulators/README.md) | executable models of deno and `tsc`, and exactly how far their calibration reaches |
| [`harness/`](harness/README.md) | the `opendir` shim, the backtrace shim, the LSP drivers, the span reader |
| [`lib/`](lib/README.md) | the shared simulation library the models and arenas are built on |
| [`bin/`](bin/README.md) | the binaries the measurements were taken with, and how to rebuild them |

## What is not settled

- **The 10.6 GB.** The mechanism is defect 6; the magnitude is not reproduced by
  any instrumented arm, which reached 4.6 GB.
- **What removed which second, among the first three patches.** They were
  measured in one arm. Only the export-key gate is isolated.
- **Whether defect 6's patch does what it predicts.** It is in the six-patch
  binary, but the probe that binary was measured with is single-shot, and defect
  6's prediction is about sustained concurrent load. No arm has tested it.
- **What defect 5's patch is worth on the real workspace.** Its cost sweep is on
  synthetic workspaces, and in the six-patch arm it is confounded with defect 6.
- **Defects 3 and 4 have no arena and no model.** The mechanism comparison, the
  adversarial workspaces, the false-negative tables and the calibrated simulators
  cover defects 1, 2 and 5. Defect 3 is a code change argued from what the code
  does; defect 4 is one measurement; defect 6 rests on an ablation, a heap
  profile and a synthetic scaling sweep, with no simulator.
- **The patched binaries were measured for cost, not for correctness.** No
  arm was checked against another for the answers the language server gives.
  R1's effect on the collected file set is argued from the module-graph probes
  in [`defect-2-root-set/graph/`](defect-2-root-set/graph/README.md), which were
  run on a stock binary with `exclude` standing in for the patch. Defect 5's
  effect on the member set is argued from the resolver-level false-negative
  table, not from the language server.
- **The real workspace is private.** [`real-workspace/`](real-workspace/README.md)
  holds its captures; the method transfers, the repository does not, and the
  patched-arm figures cannot be regenerated elsewhere.
- **`deno.enablePaths`.** `walk_workspace` honours it, and defect 6 measures that
  honouring it changes nothing downstream. Whether either defective traversal in
  defects 1 and 2 is narrowed by it was never measured.
- **The models are models.** Both arenas choose a mechanism in simulation. What
  each simulator is and is not calibrated against is in
  [`simulators/README.md`](simulators/README.md), and it is not uniform: the
  46-case matrix pins defect 2's traversal exactly and cannot exercise defect 1's
  at all.

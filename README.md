# Why `deno lsp` takes a hundred seconds to answer the first request

One go-to-definition in a 53-project monorepo cost `deno lsp` **51,315 directory
opens**, 103 seconds inside `refresh_compiler_options_resolver` and 59 seconds
inside `refresh_config_tree`. Enumerating every file in that workspace takes
**221 ms**. The gap between those two figures is work nothing asked for.

There are **four defects**. Three have patches, built from a clean `v2.9.5`
checkout and measured on the real workspace. The fourth has no fix — only an
instrument, an environment-variable gate that *skips* the work rather than
removing the redundancy, showing that about 20 seconds of `op_script_names` is
apparently redundant.

With all four applied the first `documentSymbol` after opening a file goes from
**126.7 s to 20.0 s**, a factor of 6.3. **That figure includes the gate, which
must not be merged**; the three real patches alone give 126.7 s → 38.7 s, a
factor of 3.3. Directory opens fall **84.9%** on the two file-walk fixes alone.

**Memory is not fixed and is not explained.** With the patches applied the
language server reached **10.6 GB in 72 seconds** on that workspace, against 6.1
MB of TypeScript source. See
[the open problem](real-workspace/README.md#memory-is-not-fixed-it-got-worse-and-nothing-here-explains-it).

| | what it is | fix | size |
|---|---|---|---|
| **1** | [member-glob expansion](defect-1-member-globs/README.md) walks every directory under every matched workspace member | **M5**, bound the descent by the member glob | 78% of the directory opens |
| **2** | [tsconfig root-set collection](defect-2-root-set/README.md) walks every directory under every tsconfig base | **R1**, honour the version-control ignore set | 22% of the directory opens |
| **3** | [npm dependency resolutions](defect-3-dep-resolutions/README.md) built eagerly for all 73 resolver scopes, most never used | hold them in a `OnceLock`, build on first use | the arm carrying it takes `did_change_configuration` 41.5 s → 2.1 s |
| **4** | [`op_script_names`](defect-4-export-keys/README.md) costs 42 s, and skipping export-key enumeration removes 20 of them | **none — this one is unsolved** | 20 s of a 42 s op, and half the `documentSymbol` latency |

Defects 3 and 4 both bear on
[denoland/deno#36662](https://github.com/denoland/deno/issues/36662), *"deno lsp:
same npm package folder resolved 744x per graph build when node_modules exists"*.

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

## What the patches are worth, measured

Binaries built from a clean `v2.9.5` checkout with `--features lsp-tracing`,
patched mechanically by the scripts in this tree, driven through the same probe
against the same workspace in one session. Full table, provenance and caveats in
[`real-workspace/`](real-workspace/README.md#what-the-patches-are-worth).

| metric | baseline | M5+R1+lazy | all four |
|---|---:|---:|---:|
| `documentSymbol` | 126,734 ms | 38,650 ms | **19,989 ms** |
| `lsp.did_change_configuration` | 41,504 ms | 1,871 ms | 2,123 ms |
| `tsc.op.op_script_names` | 42,136 ms | 35,625 ms | 15,906 ms |
| `definition` | 1,429 ms | 347 ms | 328 ms |
| peak RSS | 2,943 MB | 2,316 MB | 2,298 MB |

- **`documentSymbol` 126.7 s → 20.0 s = 6.3×.** The user-visible figure, and it
  includes the export-key gate. Without it — the three patches that are real
  fixes — it is 126.7 s → 38.7 s, a factor of 3.3.
- **`did_change_configuration` 41.5 s → 2.1 s = 20×.** A config-load span, not a
  request. It is the biggest ratio here and the easiest to misquote: the
  operation a person waits on got 6.3× faster, not 20×.
- **Directory opens −84.9%** on a separate run, 39,014 → 5,910 with M5+R1 alone.

Each figure belongs to a patch group. M5 and R1 move the directory opens; the
lazy dependency resolutions move `did_change_configuration`; the export-key gate
moves `op_script_names` and half of `documentSymbol`. Only the last of those is
isolated by an arm — the other three patches arrived together and these runs
cannot divide their span between them.

## The one thing that got worse

The language server's memory. Not fixed, not explained, and stated at length in
[`real-workspace/`](real-workspace/README.md#memory-is-not-fixed-it-got-worse-and-nothing-here-explains-it):
**8.2 GB with M5+R1, 10.6 GB in 72 seconds with all four**, against 6.1 MB of
workspace TypeScript and 348 MB of `node_modules` declaration files. RSS is flat
once reached, so it is not a leak. The probe never reproduces it — every probe
arm peaks near 2.3 GB. The cause is unidentified.

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

python3 defect-1-member-globs/apply-m5.py /path/to/deno    apply M5
python3 defect-2-root-set/apply-r1.py /path/to/deno        apply R1
python3 defect-3-dep-resolutions/apply-lazy.py /path/to/deno   apply the lazy fix
python3 defect-4-export-keys/gate-export-keys.py /path/to/deno  the instrument, not a fix
```

Each patch script targets a v2.9.5 checkout and exits non-zero if any anchor is
not found exactly once, rather than patching something else. Everything that
touches the real binary needs a `deno` built with `--features lsp-tracing`; see
[`bin/README.md`](bin/README.md). The arenas, the simulators and the calibrator's
fixtures need only `node`.

## Where things are

| path | what it holds |
|---|---|
| [`real-workspace/`](real-workspace/README.md) | what it costs today on the repository that prompted this, which span owns each open, what the patches were worth, and the memory problem |
| [`defect-1-member-globs/`](defect-1-member-globs/README.md) | the member-glob expansion: diagnosis, mechanism comparison, the M5 recommendation |
| [`defect-2-root-set/`](defect-2-root-set/README.md) | the tsconfig root-set collection: diagnosis, the 46-case configuration matrix, the module-graph test, the R1 recommendation |
| [`defect-3-dep-resolutions/`](defect-3-dep-resolutions/README.md) | eager per-scope npm dependency resolution, and the lazy fix |
| [`defect-4-export-keys/`](defect-4-export-keys/README.md) | the `op_script_names` measurement, and why its patch must not be merged |
| [`simulators/`](simulators/README.md) | executable models of deno and `tsc`, and exactly how far their calibration reaches |
| [`harness/`](harness/README.md) | the `opendir` shim, the backtrace shim, the LSP drivers, the span reader |
| [`lib/`](lib/README.md) | the shared simulation library the models and arenas are built on |
| [`bin/`](bin/README.md) | the binaries the measurements were taken with, and how to rebuild them |

## What is not settled

- **Memory.** The largest open question, above.
- **What removed which second, among the first three patches.** They were
  measured in one arm. Only the export-key gate is isolated.
- **Defects 3 and 4 have no arena and no model.** The mechanism comparison, the
  adversarial workspaces, the false-negative tables and the calibrated simulators
  cover defects 1 and 2 only. Defect 3 is a code change argued from what the code
  does; defect 4 is one measurement.
- **The patched binaries were measured for cost, not for correctness.** No
  arm was checked against another for the answers the language server gives.
  R1's effect on the collected file set is argued from the module-graph probes
  in [`defect-2-root-set/graph/`](defect-2-root-set/graph/README.md), which were
  run on a stock binary with `exclude` standing in for the patch.
- **The real workspace is private.** [`real-workspace/`](real-workspace/README.md)
  holds its captures; the method transfers, the repository does not, and the
  patched-arm figures cannot be regenerated elsewhere.
- **`deno.enablePaths`.** `walk_workspace` honours it. Whether either defective
  traversal is narrowed by it was never measured.
- **The models are models.** Both arenas choose a mechanism in simulation. What
  each simulator is and is not calibrated against is in
  [`simulators/README.md`](simulators/README.md), and it is not uniform: the
  46-case matrix pins defect 2's traversal exactly and cannot exercise defect 1's
  at all.

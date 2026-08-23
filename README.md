# Why `deno lsp` takes a hundred seconds to answer the first request

One go-to-definition in a 53-project monorepo cost `deno lsp` **51,315 directory
opens**, 103 seconds inside `refresh_compiler_options_resolver` and 59 seconds
inside `refresh_config_tree`. Enumerating every file in that workspace takes
**221 ms**. The gap between those two figures is directory enumeration that
nothing asked for.

There are **two independent defects**. Both bottom out at the same line —
`libs/config/glob/collector.rs:178`, the `fs_read_dir` inside
`FileCollector::collect_file_patterns` — reached by two callers that share
nothing else. Each needs its own fix, because the same mechanism is unsafe at
one and safe at the other, for a measured reason.

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

## The asymmetry, which is the substance of the result

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

## Verified on the real workspace

A build with defect 1's walk pruned, run against the 53-project workspace
against its own paired baseline: total `opendir` **39,014 → 14,341**, a 63%
reduction. The member-glob stacks collapse. The compiler-options stack is
**9,331** and does not move — that is defect 2, still to be fixed, showing up
exactly where the attribution says it should. It agrees with the 9,332 the stock
traced run charged to that span.

Two things to hold onto about that build. It prunes the member expansion with
`.use_gitignore()` on the member collector, which is the mechanism the arena
**rejects** on safety — it is the artifact that existed, not the recommendation.
And on the model it prunes *less* than M5 does (319 opens against 54 per load on
the `reported` preset, neither missing a member), so 63% reads as a lower bound
on what M5 is worth on this repository, not as M5's number.

That run's raw capture is not preserved (see "What is not settled" below).
Everything else in this directory is reproducible from what is here.

## How to read the numbers

**Opens are the measurement; milliseconds are not.** Two runs of the same regime
on the real workspace agree on total opens to within 10 of 42,666 — 0.02% — and
disagree on `refresh_compiler_options_resolver` by a factor of six. Wall time
tracks dentry-cache warmth and machine load; the open count tracks the code path.

**Per-directory cost is not a constant.** 1.544 ms cold on a Docker Desktop bind
mount, 0.216 ms warm, 0.24 ms implied by the traced run, 3.2 ms implied by the
untraced one. Every wall-clock figure in this directory is a projection at
1.544 ms and is labelled as one.

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

python3 defect-1-member-globs/apply-m5.py /path/to/deno   apply M5 to a v2.9.5 checkout
python3 defect-2-root-set/apply-r1.py /path/to/deno       apply R1 to a v2.9.5 checkout
```

Everything that touches the real binary needs a `deno` built with
`--features lsp-tracing`; see [`bin/README.md`](bin/README.md). The arenas, the
simulators and the calibrator's fixtures need only `node`.

## Where things are

| path | what it holds |
|---|---|
| [`real-workspace/`](real-workspace/README.md) | what it costs today on the repository that prompted this, and which span owns each open |
| [`defect-1-member-globs/`](defect-1-member-globs/README.md) | the member-glob expansion: diagnosis, mechanism comparison, the M5 recommendation |
| [`defect-2-root-set/`](defect-2-root-set/README.md) | the tsconfig root-set collection: diagnosis, the 46-case configuration matrix, the module-graph test, the R1 recommendation |
| [`simulators/`](simulators/README.md) | executable models of deno and `tsc`, and exactly how far their calibration reaches |
| [`harness/`](harness/README.md) | the `opendir` shim, the backtrace shim, the LSP drivers, the span reader |
| [`lib/`](lib/README.md) | the shared simulation library the models and arenas are built on |
| [`bin/`](bin/README.md) | the traced and patched `deno` binaries — not carried here; how to rebuild them |

## What is not settled

- **The patched-binary verification above has no preserved raw output.** The
  39,014 / 14,341 / 9,331 figures are reported from the run and cannot be
  re-derived from anything in this directory. Every other figure can. The run
  is also its own baseline: 39,014 is not comparable to the 51,315 and 42,666
  of earlier runs, because the repository changed between them.
- **The real workspace is private.** `real-workspace/evidence/` holds its
  captures; the method transfers, the repository does not.
- **`deno.enablePaths`.** `walk_workspace` honours it. Whether either defective
  traversal is narrowed by it was never measured.
- **The models are models.** Both arenas choose a mechanism in simulation. What
  each simulator is and is not calibrated against is in
  [`simulators/README.md`](simulators/README.md), and it is not uniform: the
  46-case matrix pins defect 2's traversal exactly and cannot exercise defect 1's
  at all.

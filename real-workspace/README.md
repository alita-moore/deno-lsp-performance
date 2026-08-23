# What it costs, on the repository that prompted this

A private 53-project monorepo on a Docker Desktop bind mount, `deno lsp` 2.9.5
built from tag `v2.9.5` with `--features lsp-tracing`, driven through
`initialize`, one `didOpen`, and requests for document symbols, a definition and
inlay hints. Directory opens come from the `LD_PRELOAD` shim in
[`../harness/`](../harness/README.md); times are the language server's own
tracing spans.

## The size of it

| | A: no `**/.venv` in root tsconfig | B: `**/.venv` present | B: same regime, traced |
|---|---:|---:|---:|
| `refresh_compiler_options_resolver` | 103,000 ms | 13,900 ms | 2,230 ms |
| `refresh_config_tree` | 59,000 ms | 37,700 ms | 12,300 ms + 6,320 ms |
| `walk_workspace` | 221 ms | 340 ms | — |
| total `opendir` | 51,315 | 42,656 | 42,666 |
| `opendir` into `.venv` | not separated | 17,290 | 8,645 on one stack |
| raw output | `evidence/real-workspace-walk-multiplicity.txt` | `evidence/real-workspace-after-fix.txt` | `evidence/real-workspace-capture.txt` |

`refresh_config_tree` is one figure in A and B and two in the traced run because
that run resolved the span twice — once under `initialized`, once under
`did_change_configuration` — and reported each separately.

**The shape of the change is the result, not either column.** Excluding `.venv`
in the root `tsconfig.json` removed most of the compiler-options cost and left
the config-tree cost standing. That is what the attribution below predicts: they
are different subsystems and tsconfig `exclude` reaches only one of them. Total
opens fell by 8,659 of 51,315 — 17% — while 17,290 opens into `.venv` survived
the exclusion.

**The three runs are not controlled repeats.** Same repository, different days,
different cache and load, and the repository itself changed: the root
`tsconfig.json` listed 53 project references at run 1 and 22 at run 3. Regime A
against regime B is a one-setting comparison only in the sense that the setting
is what was deliberately changed. The two regime-B runs, 10 opens apart, are the
only pair close to a repeat.

## Which span owns each open

Every `opendir` in the traced regime-B run attributed by symbolised call stack:

| span | opens | share |
|---|---:|---:|
| `refresh_config_tree`, under `initialized` | 16,590 | 38.9% |
| `refresh_config_tree`, under `did_change_configuration` | 16,604 | 38.9% |
| `refresh_compiler_options_resolver` | 9,332 | 21.9% |
| `walk_workspace` | 91 | 0.2% |
| run total | 42,666 | |

`refresh_config_tree` runs twice and owns 78% of the opens — defect 1. It is the
span the tsconfig `exclude` did not touch. `refresh_compiler_options_resolver` is
defect 2. The four rows sum to 42,617 of the run's 42,666: **49 opens are
unattributed**, and the shares are computed against the run total.

**`walk_workspace` is not the problem, and it is the first place everyone
looks.** It is 91 opens, because it stops after 1,000 file-system entries
(`cli/lsp/language_server.rs:1065`). It enumerates the whole workspace in 221 ms.

One arithmetic consistency, worth exactly what it says: regime B's 17,290 opens
into `.venv` is twice the 8,645 the traced capture puts on the single
config-tree stack, which is what two invocations of that span produce.

## Where the opens land

Regime A, by top-level subtree:

| subtree | opens | matched by a `workspaces` glob |
|---|---:|---|
| `ml-serving` | 27,850 | yes |
| `infra` | 10,853 | yes |
| `libs` | 9,847 | yes |
| `apps` | 2,345 | yes |
| `research` | 293 | no |
| `prod` | 39 | no |
| `domain` | 37 | yes |

The workspace's `package.json` declares
`"workspaces": ["apps/*", "infra/*", "libs/*", "domain/*", "dev/*", "ml-serving/*"]`.
99.3% of the opens fall inside a directory those globs match. That is consistent
with defect 1 being the traversal responsible, and only consistent — a path's
subtree does not say which span opened it. The attribution table does.

`ml-serving` is a Python service tree. It absorbs 54% of the opens and contains
no TypeScript the language server needs.

**The same directory is opened three times, modally.** Regime A opened 16,576
distinct directories 51,315 times: 13,861 of them exactly three times, 2,181 four
times. Which three consumers those are is not established here — the multiplicity
was measured before the stacks were captured, in the other regime.

## What one open costs

`../harness/opendirbench.py`, 3,000 directories per filesystem:

| filesystem | ms per directory, cold | ms per directory, warm |
|---|---:|---:|
| Docker Desktop bind mount | 1.544 | 0.216 |
| local ext4 | 0.578 | 0.165 |

The warm figures are `evidence/opendir-cost.txt`. The cold figures were taken
earlier and are not reproducible on demand, because the cache state that produced
them is not reproducible on demand.

Dividing a span by the opens it owns gives an upper bound on per-open cost, since
a span also does work that is not `opendir`:

| | span time | opens in that span | implied ms per open |
|---|---:|---:|---:|
| regime B, traced, `refresh_compiler_options_resolver` | 2,230 ms | 9,332 | 0.24 |
| regime A, all measured spans | 162,221 ms | 51,315 | 3.2 |

The warm traced run implies 0.24 ms against a warm benchmark of 0.216 ms. Regime
A implies an order more. **Per-directory cost is not a constant of the
filesystem**, and any conversion of an open count into seconds is a projection.

## Ruled out by measurement

| hypothesis | what rules it out |
|---|---|
| the workspace has too many files to enumerate | `walk_workspace` enumerates all of it in 221 ms |
| `walk_workspace` is the expensive traversal | 91 of 42,666 opens; it stops at 1,000 entries |
| tuning tsconfig `exclude` addresses the headline cost | it removed 17% of opens and left `refresh_config_tree` untouched |
| the tsc module-resolution ops are the cost | `op_resolve` is 367,653 calls in 1,355 ms; `op_load` 525,825 calls in 582 ms |
| the filesystem is simply slow | it is 2.7× slower than local disk per directory cold; the driver is the open count |

Ruling out the module-resolution ops does not rule out npm **workspace member**
discovery, which is a different piece of npm handling and is defect 1 — nor npm
**dependency resolution**, which is
[defect 6](../defect-6-dependency-graph/README.md) and is where the memory is.
Nor does it rule out the other tsc ops: `op_script_names` is 42,136 ms for one
call in the earlier probe session's baseline below and 63,190 ms in the later
one, and it is [defect 4](../defect-4-export-keys/README.md). `op_resolve` and
`op_load` are many cheap calls; `op_script_names` is one expensive one.

## What the patches are worth

Two probe sessions are reported here. The later one carries all six patches and
is the headline. The earlier one is kept because it is the only session that
isolates the export-key gate, and because its middle arm is the only arm anywhere
that excludes the gate.

**Do not compare across the two sessions.** They are separate sessions against
the same repository, and their baselines differ — `documentSymbol` is 126,734 ms
in the earlier and 120,486 ms in the later. Each session's columns are
comparable to each other and to nothing else.

In both, `documentSymbol` and `definition` are the driver's round-trip times for
the first request of each kind after `didOpen`; `lsp.did_change_configuration`
and `tsc.op.op_script_names` are from `deno/performance`; peak RSS is the
language server process's.

### The six-patch session

Three arms, from binaries built out of a clean `v2.9.5` checkout with
`--features lsp-tracing` by a GitHub Actions workflow — see
[`../bin/README.md`](../bin/README.md) — patched mechanically by the scripts in
this tree and driven through the same probe against the same workspace in **one
session**. "Four patches" is M5 + R1 + the lazy dependency resolutions + the
export-key gate; "six patches" is those plus
[defect 5](../defect-5-workspace-inert/README.md)'s authoritative-membership
patch and [defect 6](../defect-6-dependency-graph/README.md)'s shared snapshot.

| metric | baseline | four patches | six patches |
|---|---:|---:|---:|
| `documentSymbol` | 120,486 ms | 21,322 ms | **18,587 ms** |
| `lsp.did_change_configuration` | 75,072 ms | 2,856 ms | **1,504 ms** |
| `definition` | 32,226 ms | 381 ms | **131 ms** |
| `tsc.op.op_script_names` | 63,190 ms | 15,707 ms | 15,350 ms |
| peak RSS | 2,629 MB | 1,826 MB | 1,861 MB |

Stated precisely:

- **`documentSymbol` 120.5 s → 18.6 s, a factor of 6.5.** The user-visible one:
  it is what someone waits for after opening a file. Both patched arms carry the
  export-key gate, which is an instrument and not a merge candidate, and the
  six-patch arm also carries defect 5's patch, which changes a tested contract.
  Neither patched column is a picture of what a mergeable set of fixes gives.
- **`lsp.did_change_configuration` 75.1 s → 1.5 s, a factor of 50.** A config-load
  span, not a user request. It is the largest ratio in the table and the one most
  easily misquoted; "50× faster LSP" is not a claim this supports.
- **`definition` 32.2 s → 0.13 s.** It is the first definition after `didOpen`,
  so in the baseline arm it waits on the same cold configuration load and cold
  resolver that `documentSymbol` waits on.
- **Peak RSS 2,629 MB → 1,826 MB with four patches, 1,861 MB with six.** The two
  patched arms are 35 MB apart and the probe does not exercise the load defect 6
  addresses, so nothing should be read into their order.

What this session does **not** establish:

- **The probe is a single-shot `documentSymbol` and `definition` cycle.**
  Defect 6's predicted win is on *sustained* request load: its own prediction is
  that the RSS rise over 96 requests, issued eight at a time, falls from
  **+1,701 MB to under +100 MB**. This probe issues nothing resembling that load,
  so this session **neither confirms nor refutes** the prediction.
- **`did_change_configuration` fell between the four- and six-patch arms, and
  this session cannot attribute the fall.** Defect 6 named config-load RSS and
  `did_change_configuration` staying *unchanged* as its falsifier. The span did
  move, 2,856 ms → 1,504 ms. But defect 5's patch is in the same arm, and defect
  5 changes workspace membership, which is what config-load cost is proportional
  to — its own sweep fits 5.0 ms of `did_change_configuration` per member. The
  two are confounded in this arm. This run neither credits defect 5 with the drop
  nor falsifies defect 6; it cannot separate them, and an arm that varies one at
  a time was not run.
- **The probe's after-configuration-walk RSS readings are deliberately not
  tabulated.** That sample is taken at a fixed point in a run whose speed differs
  by arm, so the arms are not at the same stage of work when it is read, and the
  readings are not comparable across arms. Peak RSS is comparable, because it is
  a high-water mark over the whole run rather than a reading at a moment.

### The earlier session, which isolates the export-key gate

Three arms, from binaries built the same way, driven through the same probe
against the same workspace in one session of their own. The two patched columns
come from one binary: the export-key gate is inert unless
`DENO_LSP_SKIP_EXPORT_RESOLUTIONS` is set.

| metric | baseline | M5+R1+lazy | all four |
|---|---:|---:|---:|
| `documentSymbol` | 126,734 ms | 38,650 ms | **19,989 ms** |
| `lsp.did_change_configuration` | 41,504 ms | 1,871 ms | 2,123 ms |
| `tsc.op.op_script_names` | 42,136 ms | 35,625 ms | 15,906 ms |
| `definition` | 1,429 ms | 347 ms | 328 ms |
| peak RSS | 2,943 MB | 2,316 MB | 2,298 MB |

Stated precisely:

- **`documentSymbol` 126.7 s → 20.0 s, a factor of 6.3.** The figure that
  includes the export-key gate. The three patches that were real fixes alone are
  126.7 s → 38.7 s, a factor of 3.3, and that middle column is the only measured
  arm anywhere that contains no instrument and no contract change.
- **`lsp.did_change_configuration` 41.5 s → 2.1 s, a factor of 20.**
- **`definition` 1.43 s → 0.33 s.** Small in absolute terms because by the time
  it runs the resolver is warm — which is not what happened in the later
  session's baseline, and is one reason the two sessions are not comparable.

### Which patch moved what

| span | moved by |
|---|---|
| directory opens, and the config-tree and compiler-options walk time | M5 and R1 — [defect 1](../defect-1-member-globs/README.md), [defect 2](../defect-2-root-set/README.md) |
| `lsp.did_change_configuration` | the lazy dependency resolutions — [defect 3](../defect-3-dep-resolutions/README.md); in the six-patch session [defect 5](../defect-5-workspace-inert/README.md) is in the same arm and the two are not separated |
| `tsc.op.op_script_names`, and half of `documentSymbol` | the export-key gate — [defect 4](../defect-4-export-keys/README.md), which is an instrument and not a fix |
| memory held per request in flight | [defect 6](../defect-6-dependency-graph/README.md)'s shared snapshot — predicted from a heap profile, and exercised by neither session's probe |

**Only one row is isolated by an arm, and only in the earlier session**: the gate
is the sole difference between that session's two patched columns, so
`op_script_names` 35,625 → 15,906 and `documentSymbol` 38,650 → 19,989 are its
and nothing else's. M5, R1 and the lazy patch all sit under config load and
arrived in one arm; that arm collapses `did_change_configuration` from 41.5 s to
1.9 s, and these runs cannot say how the 39.6 s divides between the three.
Defects 5 and 6 arrived together in the six-patch arm and are likewise not
divided. The attribution above is by which code each patch changes, not by an arm
that varies one at a time.

### Directory opens, M5 and R1 only

A separate run, the `opendir` shim rather than the probe, baseline against
M5+R1 on the same workspace:

| | unit | baseline | M5+R1 |
|---|---|---:|---:|
| total `opendir` | opens | 39,014 | **5,910** |
| member-glob expansion, under `initialized` | ms | 16,197 | 74 |
| member-glob expansion, under `did_change_configuration` | ms | 12,288 | 26 |
| compiler-options `from_inner` | ms | 9,331 | 5,447 |

**−84.9% of directory opens.** The two member-glob stacks collapse — 16.2 s and
12.3 s to 74 ms and 26 ms — which is M5. The compiler-options stack falls by 42% rather than to nothing, which is
R1 doing what its false-negative analysis says it does: it bounds the walk by the
version-control ignore set, and tracked mass still gets walked.

This run is its own baseline. Its 39,014 is not comparable to the 51,315 and
42,666 above — different day, different cache state, and the repository itself
changed between them. Milliseconds from this run are not comparable to
milliseconds from either probe session; they are reported here only as the
per-stack shape of the reduction.

<a id="memory"></a>
<a id="memory-is-not-fixed-it-got-worse-and-nothing-here-explains-it"></a>

## Memory: the mechanism is defect 6, the magnitude is still unreproduced

Driving the patched language server against the real workspace in an editor:

| arm | resident memory |
|---|---|
| M5+R1 | **8.2 GB** |
| all four patches | **10.6 GB, reached in 72 seconds** |

Against a workspace whose entire TypeScript source is **6.1 MB across 5,781
files**, alongside **96,163 `.d.ts` files totalling 348 MB** in `node_modules`.
Ten gigabytes is roughly thirty times the declaration files on disk and three
orders of magnitude more than the source.

### The mechanism, which is now identified

[Defect 6](../defect-6-dependency-graph/README.md) is where the memory goes.
`deno lsp` builds a resolver scope for **every member of the npm workspace**,
seeds each one with **every** npm specifier in the workspace's single `deno.lock`,
and materialises a private copy of the resulting 2,567-package resolution graph
per scope. `Inner::snapshot()` then deep-clones every one of those graphs on
**every** LSP request, from 35 call sites. Measured there: **1,095 MB resident
before a single file is open**, **213 MB more for every request in flight** on
this workspace, 88% of live heap at configuration load and 73% at the probe's
peak on `NpmResolutionCell::snapshot`, and 2,729 MB of a 4,619 MB resident set in
`[heap]`, which only `malloc` reaches. That is also why RSS is flat once reached
rather than falling: it is glibc arena high-water, not a leak.

### What is still not explained

**The 8.2 GB and the 10.6 GB are not reproduced.** The furthest any instrumented
arm in defect 6 reached is **4.6 GB**, with eight requests in flight on this same
workspace. The mechanism has no bound in the number of concurrent requests and an
editor issues far more of them than any probe here does, but that is a mechanism,
not a measurement. **Anyone quoting a measured figure should quote 4.6 GB.**

The rest of what was known before still holds:

- **It is not a leak.** RSS is flat once it is reached, and defect 6 says why.
- **It got worse as patches were added**, between the only two arms that can be
  compared: 8.2 GB with two patches, 10.6 GB with four. Defect 6 does not explain
  that delta either. One explanation is consistent with it and **is not
  verified**: the patches remove the work that was throttling allocation, so the
  same high-water mark is reached sooner and further.
- **The probe never reproduces it.** Peak RSS across every arm of both probe
  sessions is 1.8–2.9 GB, and it *falls* with the patches applied. Whatever
  produces the 10.6 GB is not exercised by `initialize` + one `didOpen` + a
  handful of requests.
- **There is no baseline editor-session figure.** The 8.2 and 10.6 are patched
  arms; an unpatched editor session was not measured the same way, so "it got
  worse" is a statement about those two arms and about the absolute size, not a
  measured regression against stock deno.

### One user's impression of the six-patch binary, which is not a measurement

Running the six-patch binary in a real editor, a single user reports that the
language server settles at **roughly 3 GB resident after warmup**, against the
8–10 GB range above, and that the editor is noticeably more responsive.

**This is a subjective impression from one person and one session.** There is no
instrumented capture behind it, no controlled arm, no repeat, and no defined
sampling point — "after warmup" is a judgement, not a marker. It is recorded here
because it is the only observation of the six-patch binary under an editor's
request load, which is the load defect 6's per-request clone is predicted to
matter under, and it is consistent with that prediction. **It is not evidence for
it**, and it must not be quoted as a result.

It also cuts against the trend in the two measured editor arms above, where
memory rose as patches were added. Nothing here reconciles the two, and only one
of them is a measurement. Two mechanisms in the six-patch binary would each
predict a fall — defect 6 removes the per-request clone, and defect 5 reduces the
member count, which defect 6 measures configuration-time memory to be linear in —
but no arm here distinguishes them, or establishes that either is what the user
observed.

## Running it

```
PATH=<dir holding the traced deno>:$PATH \
  DIRLOG_OUT=/var/tmp/opendir.txt LD_PRELOAD=<dirlog.so> LSP_STDERR_LOG=/var/tmp/lsp.log \
  node ../harness/lsp-probe-paths.mjs <workspace-root> <file.ts> <enabled-path> ...

python3 ../harness/spans.py /var/tmp/lsp.log \
  refresh_compiler_options_resolver refresh_config_tree walk_workspace
cat /var/tmp/opendir.txt.* | cut -d' ' -f2- | sort | uniq -c | sort -rn
python3 ../harness/opendirbench.py <bind-mount-path> <local-disk-path>
```

## Evidence, and what it does not preserve

| file | what it holds |
|---|---|
| `evidence/real-workspace-walk-multiplicity.txt` | regime A: 51,315 opens over 16,576 distinct directories, the multiplicity histogram, the subtree totals |
| `evidence/real-workspace-after-fix.txt` | regime B: span totals and opens with `**/.venv`, `**/__pycache__` and `**/.pytest_cache` in the root tsconfig |
| `evidence/real-workspace-capture.txt` | the traced regime-B backtrace capture. Addresses only, paths stripped; symbolise with `../harness/symbolize.py` |
| `evidence/opendir-cost.txt` | ms per directory on the bind mount and on local disk, cache warm |

- **Regime A's span table has no preserved raw output.** Its numbers were read
  from that run's stderr with `spans.py`; the `opendir` log survives, the stderr
  log does not.
- **The traced run's span attribution is not preserved either.** The
  91 / 16,590 / 9,332 / 16,604 split and the 2,230 / 12,300 / 6,320 ms spans are
  quoted from that run. What is preserved is its capture: two deduplicated
  stacks totalling 8,646 opens, of which 8,645 are on one stack.
- **The real workspace is private** and none of the runs against it — the two
  baseline regimes, either probe session or the directory-opens run — can be
  regenerated elsewhere. Everything else in this directory tree can.
- **An earlier projection is withdrawn.** 51,315 opens × 1.544 ms ≈ 79 s of the
  103 s charged every open in the run to a single span that owns 22% of them.
  It is not repeated anywhere here.

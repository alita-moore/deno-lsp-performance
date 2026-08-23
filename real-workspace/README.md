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
discovery, which is a different piece of npm handling and is defect 1.

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
- **The real workspace is private** and these two runs cannot be regenerated
  elsewhere. Everything else in this directory tree can.
- **An earlier projection is withdrawn.** 51,315 opens × 1.544 ms ≈ 79 s of the
  103 s charged every open in the run to a single span that owns 22% of them.
  It is not repeated anywhere here.

# Harness

Everything measured in this directory tree is measured with these tools. There
are two shims — one that logs every `opendir` path, one that captures a
backtrace at every `opendir` — two LSP drivers, a span reader, a per-directory
cost benchmark, and the builder for the 46-case configuration matrix.

| file | what it does |
|---|---|
| `dirlog.c` | `LD_PRELOAD` shim interposing `opendir`, appending `<ms-since-start> <path>` to `$DIRLOG_OUT.<pid>`. Append-only and lock-free, so it is safe under a multithreaded language server. Every complete `opendir` count in this tree came from it. |
| `stacktrace.c` | `LD_PRELOAD` shim that captures a backtrace at every `opendir`, deduplicates stacks, records the executable's load base, and flushes as it goes. Every attribution of an open to a **line** came from it. |
| `symbolize.py` | Subtracts the load base, resolves return addresses through `addr2line`, ranks stacks by frequency. |
| `capture.sh` | Runs a language server under `stacktrace.c` against a sample or any repository, then symbolises. Driven by the `run.sh` in each defect's `diagnosis/`. |
| `lsp-driver.mjs` | Drives `deno lsp` over stdio: `initialize`, answers `workspace/configuration`, opens a document, requests `documentSymbol` / `definition` / `inlayHint`, then reads `deno/performance`. Writes the server's stderr — where the tracing spans go — to `$LSP_STDERR_LOG`. |
| `lsp-probe.mjs` | Entry point that enables Deno for a whole workspace root. |
| `lsp-probe-paths.mjs` | Entry point that enables Deno only for the paths given on the command line, which is how an editor configures a large repository, and how the real-workspace figures were taken. |
| `spans.py` | Sums `time.busy` per named span from a stderr log. |
| `opendirbench.py` | Walks a directory tree and reports milliseconds per directory. |
| `matrix.py` | Builds and measures the 46 configurations in `../defect-2-root-set/matrix/`. `CASES` is the matrix; `build()` emits a workspace; `measure()` runs the probe under `dirlog.so` and counts opens. |

## Requirements

A `deno` built from the tag under test with `--features lsp-tracing`. A stock
release binary accepts the tracing settings and emits nothing. See
[`../bin/README.md`](../bin/README.md).

```
cc -shared -fPIC -O2 -o dirlog.so dirlog.c -ldl
```

`matrix.py` requires three variables and fails if one is unset or names a file
that is not there:

| variable | meaning |
|---|---|
| `DENO_BIN` | the traced `deno` binary; symlinked into a shim directory placed first on `PATH` |
| `DIRLOG_SO` | the compiled `dirlog.so` |
| `MATRIX_BUILD_ROOT` | where the 46 workspaces are built. Put it on a local filesystem, not a bind mount — building them there costs more than measuring them |

```
export DENO_BIN=~/deno DIRLOG_SO=$PWD/dirlog.so MATRIX_BUILD_ROOT=/var/tmp/matrix
python3 matrix.py                         # all 46 cases
python3 matrix.py D                       # one group
python3 matrix.py A01 D06 D09             # named cases
```

Runs are pinned to three cores (`taskset -c 0-2`) so a probe cannot take the
whole machine. The `wall_ms` a probe reports is dominated by fixed language
server startup and is not a signal; the `opendir` counts and the spans are.

## Two things that will waste your time

**Tracing must be supplied at `initialize`.** `deno.tracing` sent in a
`workspace/configuration` response or in `didChangeConfiguration` is silently
ignored: the subscriber cannot be installed as a global default and is never
re-read (`cli/lsp/trace.rs`). It has to be in `initializationOptions`:

```json
{ "tracing": { "enable": true, "collector": "logging", "filter": "trace" } }
```

`collector: "logging"` writes spans to stderr, which is why the drivers capture
it.

**A probe that answers `workspace/configuration` with the wrong `enablePaths`
measures nothing.** If those paths do not exist in the workspace under test, Deno
disables itself and does no work at all — indistinguishable from a fix that
worked. `lsp-probe.mjs` sends `enable: true` with no `enablePaths` for exactly
that reason, and `lsp-probe-paths.mjs` refuses to run with an empty list.

## Why backtraces and not a profiler

`gdb` against a release `deno` yields `?? [PAC]` frames: `debug =
"line-tables-only"` with `lto = true`, `codegen-units = 1` and `opt-level = 'z'`
leaves too little for the unwinder, and ARM64 pointer authentication compounds
it. `backtrace()` from inside the process succeeds because `.eh_frame` is intact,
and `.symtab` plus `.debug_line` survive in the shipped binary, so offline
symbolisation is exact.

The tracing spans are the other half: purpose-built, free, and they name the
functions directly.

## Reading a capture

`stacktrace.c` writes:

```
EXEMAP <start>-<end> r-xp ... /path/to/deno     the executable's load base
TOTAL <n>                                       opendir calls matched
STACK <count> <example path>                    one deduplicated call stack
  0x...                                         return addresses, innermost first
```

Addresses are absolute. Subtract the `EXEMAP` start before symbolising — the
binary is position-independent, so the same code sits at a different address on
every run. `symbolize.py` does that. `example path` is the **first** path that
produced the stack, not a representative one, and two stacks can carry the same
logical call chain with different example paths because the return addresses
differ by inlining site.

## The stack shim's counts are a lower bound

`stacktrace.c` dumps its table when it discovers a new stack, and every 4,096
opens on an existing one. The language server is killed rather than shut down, so
no destructor runs and the last dump wins. A run whose largest stack crosses a
multiple of 4,096 late in the run records nearly everything; a small run can stop
counting early — one capture recorded 203 opens for a walk the complete path log
shows made 404.

Use `stacktrace.c` to establish **which line**, and `dirlog.c` to establish **how
many**. They are different tools and nothing in this tree mixes them.

For the same reason the shim must flush as it goes rather than at exit: the
language server is killed, so a destructor never runs and a flush-at-exit design
captures nothing at all.

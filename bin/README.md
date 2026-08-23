# The binaries

**This is the one place this directory is not self-contained.** Everything that
needs a `deno` binary — the two `diagnosis/run.sh` scripts, the evidence scripts,
`graph/run.mjs`, `harness/matrix.py` — expects one at `bin/deno`, and none is
carried here. Each is roughly 250 MB, which is two orders of magnitude larger
than everything else combined.

Two builds were used, both from deno tag **`v2.9.5`**:

| build | what it is | used for |
|---|---|---|
| `deno` | 2.9.5 with `--features lsp-tracing` | every measurement in this tree. A stock release binary accepts the tracing settings and emits nothing, so nothing here works without it |
| a patched variant | the same, plus `.use_gitignore()` on the member collector at `discovery.rs:797` | the real-workspace verification in [`../README.md`](../README.md), and the cross-check that fixing defect 1 moves defect 2 by nothing (3,006 opens against 3,006) |

## Rebuilding

Both were produced by the GitHub Actions workflow
`.github/workflows/build-collector-fix.yml` in the
`alita-moore/deno-lsp-node-modules-repro` repository, which checks out deno at
the tag, applies the patch under test, and builds with the tracing feature on.
The captures in this tree carry that workflow's paths in their symbolised frames
— `/home/runner/work/deno-lsp-node-modules-repro/…` — which is how a capture can
be matched back to the build that produced it.

Building by hand is the same thing:

```
git clone https://github.com/denoland/deno && cd deno && git checkout v2.9.5
cargo build --release --features lsp-tracing
```

The patched variant is that, plus `.use_gitignore()` added to the member
collector's builder chain at `libs/config/workspace/discovery.rs:797`.

## Pointing the scripts at one

Every script honours `DENO_BIN`:

```
DENO_BIN=/path/to/deno ./defect-1-member-globs/diagnosis/run.sh
DENO_BIN=/path/to/deno node defect-2-root-set/graph/run.mjs
```

Otherwise drop or symlink it here as `bin/deno`.

## Why the binary matters to symbolisation

`stacktrace.c` records return addresses and the executable's load base; the
binary is position-independent, so the same code appears at a different address
on every run. `symbolize.py` subtracts the base and resolves through
`addr2line`. **A capture can only be symbolised against the exact binary that
produced it** — `.symtab` and `.debug_line` survive in the shipped build, so
offline symbolisation is exact, but only for that build.

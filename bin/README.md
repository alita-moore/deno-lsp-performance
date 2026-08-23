# The binaries

**This is the one place this directory is not self-contained.** Everything that
needs a `deno` binary — the two `diagnosis/run.sh` scripts, the evidence scripts,
`graph/run.mjs`, `harness/matrix.py` — expects one at `bin/deno`, and none is
carried here. Each is roughly 250 MB, which is two orders of magnitude larger
than everything else combined.

Every build is from deno tag **`v2.9.5`**, checked out clean, patched by one of
the scripts in this tree, and compiled with `--features lsp-tracing`. A stock
release binary accepts the tracing settings and emits nothing, so nothing here
works without that feature.

| build | patches | used for |
|---|---|---|
| traced baseline | none | every stock measurement in this tree, and the `baseline` column of both patched-arm tables |
| member-gitignore | `.use_gitignore()` on the member collector at `discovery.rs:797` | the cross-check that fixing defect 1 moves defect 2 by nothing (3,006 opens against 3,006). This is **M2**, the mechanism the defect-1 arena rejects on safety; it is an artifact, not a recommendation |
| M5+R1 | `apply-m5.py`, `apply-r1.py` | the directory-opens run, 39,014 → 5,910 |
| four patches | `apply-m5.py`, `apply-r1.py`, `apply-lazy.py`, `gate-export-keys.py` | both patched columns of the earlier probe session, and the `four patches` column of the six-patch session |
| six patches | the four above, plus `apply-authoritative.py` and `apply-shared-snapshot.py` | the `six patches` column of the six-patch session |

The four-patch build produces two columns of the earlier session because the
export-key gate is inert unless `DENO_LSP_SKIP_EXPORT_RESOLUTIONS` is set in the
environment: unset, the binary is M5 + R1 + the lazy dependency resolutions; set,
it is that plus the skip. The gate **is** set in both patched columns of the
six-patch session. The numbers are in
[`../real-workspace/`](../real-workspace/README.md#what-the-patches-are-worth).

## Rebuilding

The builds were produced by a GitHub Actions workflow that checks out deno at the
tag, applies the patch scripts under test, and builds with the tracing feature
on. The captures in this tree carry that workflow's paths in their symbolised
frames, which is how a capture can be matched back to the build that produced it.

By hand it is the same thing:

```
git clone https://github.com/denoland/deno && cd deno && git checkout v2.9.5
python3 ../defect-1-member-globs/apply-m5.py .
python3 ../defect-2-root-set/apply-r1.py .
python3 ../defect-3-dep-resolutions/apply-lazy.py .
python3 ../defect-4-export-keys/gate-export-keys.py .
python3 ../defect-5-workspace-inert/apply-authoritative.py .
python3 ../defect-6-dependency-graph/apply-shared-snapshot.py .
cargo build --release --features lsp-tracing
```

Each script asserts its anchors and exits non-zero if one is not found exactly
once, so a build either carries the intended change or does not happen. Omit any
line to get the corresponding arm; omit all six for the traced baseline.

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

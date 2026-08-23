# Defect 4 — `op_script_names` spends 42 seconds, and about 20 of them are apparently redundant

**Nothing in this directory is a proposed fix.** What is here is a measurement
instrument and the number it produced. The number says a large part of one op's
cost is work whose result nothing appears to need; it does not say what the
redundancy is or how to remove it. That deserves its own investigation and its
own issue.

`tsc.op.op_script_names` costs **42,136 ms** on the 53-project workspace at
baseline — one call, and the language server cannot answer the first request
until it returns. It consumes the resolver's completed entry set
(`cli/lsp/tsc.rs:5589`), so it pays for whatever the resolver put there.

## The instrument

`cli/lsp/resolver.rs` enumerates the export keys of each dependency's
`package.json` while building dependency resolutions. `gate-export-keys.py` puts
that enumeration behind an environment variable so a run can be made with it and
without it:

```rust
if std::env::var_os("DENO_LSP_SKIP_EXPORT_RESOLUTIONS").is_some() {
  return;
}
let export_keys = dep_package_json
```

```
python3 gate-export-keys.py /path/to/deno    # a v2.9.5 checkout
DENO_LSP_SKIP_EXPORT_RESOLUTIONS=1 deno lsp
```

One anchor-exact edit. It exits non-zero if the anchor is not found exactly once.

## What it measured

Against the arm carrying M5, R1 and the lazy dependency resolutions, adding the
gate moved two figures and left the rest alone:

| metric | M5+R1+lazy | with the gate | change |
|---|---:|---:|---:|
| `documentSymbol` | 38,650 ms | 19,989 ms | −48% |
| `tsc.op.op_script_names` | 35,625 ms | 15,906 ms | −19,719 ms |
| `lsp.did_change_configuration` | 1,871 ms | 2,123 ms | +252 ms |
| `definition` | 347 ms | 328 ms | −19 ms |
| peak RSS | 2,316 MB | 2,298 MB | −18 MB |

The full table and how the run was made are in
[`../real-workspace/README.md`](../real-workspace/README.md).

**Roughly 20 seconds of `op_script_names`, and half of the user-visible
`documentSymbol` latency, sit behind one enumeration.** Export keys are
enumerated per dependency `package.json`, and a monorepo resolves the same
package folders over and over, so most of that enumeration is repeated work over
identical inputs.

## Why this must not be merged as it stands

**It skips the work; it does not remove the redundancy.** Export-key enumeration
is there to resolve `exports` subpaths. Turning it off changes what the resolver
can answer — the environment variable is a switch that degrades the language
server, and the run above did not check what it degraded. No completion,
diagnostic or go-to-definition result was compared between the gated and ungated
arms.

**An environment variable is not a design.** The real change would be to compute
the enumeration once per distinct package folder instead of once per dependency
edge, so the results are identical and the repetition is gone. Nothing here
attempts that, and nothing here measures what such a change would be worth — the
20 seconds is what *skipping* costs, which is an upper bound on what
*deduplicating* could save.

**The redundancy is inferred, not localised.** That skipping the enumeration
saves 20 seconds establishes the enumeration costs 20 seconds. That the 20
seconds is redundant rather than necessary is an inference from the shape of the
work — the same package folders, repeatedly — and no call was counted or
deduplicated to confirm it.

Read the number as evidence that this op deserves its own issue, and read the
patch as the thing that produced the number.

## The related report

[denoland/deno#36662](https://github.com/denoland/deno/issues/36662) — *"deno lsp:
same npm package folder resolved 744x per graph build when node_modules exists"* —
reports repeated resolution of the same npm package folder during graph building.
The measurement here is consistent with that: the cost that disappears when
per-dependency export-key enumeration is skipped is cost spent on package folders
the language server has already resolved. Whether it is the same repetition that
issue counted is not established here, and establishing it is the first thing a
follow-up should do.

## Layout

| path | what it is |
|---|---|
| `gate-export-keys.py` | the environment-variable gate, applied to a deno v2.9.5 checkout. A measurement instrument; not a fix |

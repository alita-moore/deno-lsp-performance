# What the extra members cost

A controlled sweep. One repository shape, three arms, six sizes. Only the
membership rule changes between arms; the directory tree on disk is identical
within a size.

| arm | root `deno.json` `workspace` | root `package.json` `workspaces` | members |
|---|---|---|---|
| `union` | two literal members | `["packages/*"]`, matching **N** | **N** — today's behaviour |
| `authoritative` | two literal members | absent | 2 — the fix, stood in for by configuration |
| `declared-all` | all **N** literally | absent | **N** — N members without the glob expansion |

`declared-all` is the control that separates the two costs. It has `union`'s
member count and `authoritative`'s traversal, so any quantity it tracks with
`union` is driven by **member count**, and any quantity it tracks with
`authoritative` is driven by the **npm glob expansion**.

Each member carries a `package.json` naming 60 dependencies present in a root
`node_modules`, a `deno.json`, and ten TypeScript files. Runs are pinned to three
cores; each row is the median of two probes through
[`../../harness/lsp-probe.mjs`](../../harness/README.md) under the `opendir`
shim, against a stock `v2.9.5` binary built with `--features lsp-tracing`.

| N | arm | members | `opendir` | `did_change_configuration` | `refresh_config_tree` | peak RSS |
|---:|---|---:|---:|---:|---:|---:|
| 8 | union | 8 | 28 | 21 ms | 8 ms | 284 MB |
| 8 | authoritative | 2 | 10 | 19 ms | 8 ms | 294 MB |
| 8 | declared-all | 8 | 10 | 19 ms | 6 ms | 294 MB |
| 16 | union | 16 | 52 | 39 ms | 12 ms | 306 MB |
| 16 | authoritative | 2 | 18 | 34 ms | 11 ms | 293 MB |
| 16 | declared-all | 16 | 18 | 39 ms | 11 ms | 295 MB |
| 32 | union | 32 | 100 | 84 ms | 24 ms | 297 MB |
| 32 | authoritative | 2 | 34 | 66 ms | 20 ms | 295 MB |
| 32 | declared-all | 32 | 34 | 82 ms | 21 ms | 305 MB |
| 64 | union | 64 | 196 | 202 ms | 54 ms | 328 MB |
| 64 | authoritative | 2 | 66 | 139 ms | 38 ms | 302 MB |
| 64 | declared-all | 64 | 66 | 200 ms | 51 ms | 332 MB |
| 128 | union | 128 | 388 | 506 ms | 147 ms | 413 MB |
| 128 | authoritative | 2 | 130 | 135 ms | 38 ms | 312 MB |
| 128 | declared-all | 128 | 130 | 575 ms | 161 ms | 418 MB |
| 192 | union | 192 | 580 | 956 ms | 269 ms | 537 MB |
| 192 | authoritative | 2 | 194 | **124 ms** | **36 ms** | **310 MB** |
| 192 | declared-all | 192 | 194 | 988 ms | 271 ms | 541 MB |

## Directory opens: exactly 3N + 4, and exactly one of those three is the defect

The fits are exact, not approximate — every point sits on the line.

| arm | `opendir` |
|---|---|
| `union` | **3N + 4** |
| `authoritative` | **N + 2** |
| `declared-all` | **N + 2** |

The path log says why. Every open the `union` arm makes beyond the other two is
the npm member-glob expansion — `packages`, then each of the N matched
directories — run three times in one session: twice during `initialized` and once
during `did_change_configuration`. The `authoritative` and `declared-all` arms
make **the same** N + 2 opens as each other, so the glob expansion is the entire
difference, and declaring members literally costs nothing to expand.

## Time and memory: 5.0 ms and 1.32 MB per member, and the glob is not in it

| arm | `did_change_configuration` | peak RSS |
|---|---|---|
| `union` | 5.00 ms × N − 65 | 1.32 MB × N + 264 |
| `declared-all` | 5.30 ms × N − 71 | 1.33 MB × N + 267 |

`declared-all` has no glob expansion at all and tracks `union` to within 6% on
time and 1% on memory. **Member count drives the configuration-tree cost;
the glob expansion drives the directory opens; they are separate.**

The two ends of the sweep, at N = 192: today's 956 ms and 537 MB against the
fix's 124 ms and 310 MB, a factor of **7.7 on `did_change_configuration`**, of
**7.5 on `refresh_config_tree`**, of **3.0 on directory opens**, and **−42% on
peak RSS** — while `declared-all` shows that a workspace which really does have
192 members pays 988 ms and 541 MB and the fix would not save it a thing. The
whole saving is not having members you did not declare.

## The cost is not linear below a threshold, and the threshold is not the fix's

At N = 8 through 64 the `authoritative` arm barely separates from the other two:
19 ms against 19, 34 against 39, 66 against 82. It separates at N = 128 and stays
flat afterwards — 135 ms, then 124 ms at N = 192, while the others keep climbing.

That is `walk_workspace`. `refresh_config_tree` loads a `ConfigData` for **every
`deno.json` and `package.json` the workspace file walk found**, not only for
members (`cli/lsp/config.rs:1985`), and only then for each member of each such
scope. Below the walk's limit it has already found every config file on disk, so
cutting the member set changes nothing. Above it, the member list is what
supplies the rest, and cutting it is the whole difference.

The limit is **hardcoded at 1,000 directory entries**
(`cli/lsp/language_server.rs:1071`). The warning deno prints when it is hit tells
the user to raise `deno.documentPreloadLimit`; that setting is read in exactly
one place, to decide whether to print the warning, and has no effect on the walk.
That is a separate defect and is not measured further here.

## What is not a signal here

`documentSymbol` ranges from 164 ms to 1,382 ms across these runs with no
relation to arm or size. In a synthetic corpus of ten-line modules it is
dominated by fixed TypeScript startup. Nothing in this directory should be read
as a claim about request latency.

None of these figures were taken with the patch applied. `authoritative` is a
configuration stand-in — root `package.json` without a `workspaces` field —
which reproduces the fix's **member set** exactly and its **traversal** not at
all. The patch keeps the expansion in order to name what it drops; the
`diagnosed` arm below measures what that costs.

## What keeping the warning costs

`diagnosed` is the recommended patch's cost profile, measured: N directories
under an npm glob, of which only the two declared members carry a
`package.json`, so the expansion walks all N and yields 2 members.
`diagnosed-base` is the same tree with the `workspaces` field removed.

| N | arm | members | `opendir` | `did_change_configuration` | peak RSS |
|---:|---|---:|---:|---:|---:|
| 128 | diagnosed | 2 | 388 | 64 ms | 300 MB |
| 128 | diagnosed-base | 2 | 130 | 86 ms | 297 MB |
| 192 | diagnosed | 2 | 580 | 57 ms | 301 MB |
| 192 | diagnosed-base | 2 | 194 | 87 ms | 299 MB |

Keeping the expansion costs **2N + 2 directory opens and nothing measurable in
time or memory**. The saving that matters — the per-member `ConfigData::load` —
survives it in full. And the retained walk is the one
[defect 1](../../defect-1-member-globs/README.md) bounds to Θ(members).

## Running it

```
export DENO_BIN=... DIRLOG_SO=... SWEEP_BUILD_ROOT=/var/tmp/defect5-sweep
python3 sweep.py                 # all three arms, all six sizes
python3 sweep.py union 128       # one arm, one size
python3 diagnosed.py             # the retained-walk arm
```

`sweep.log` and `results.json` are the runs the tables above are read from.

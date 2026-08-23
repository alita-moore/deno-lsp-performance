# Defect 6 — one npm resolution graph per workspace member, cloned again on every request

**The hypothesis was right, and it is where the memory went.** `deno lsp` builds
a resolver scope for **every member of the npm workspace**, not for the members
the open file needs and not for the paths `deno.enablePaths` names. Each scope is
seeded with **every npm specifier in the workspace's single `deno.lock`** and
materialises its own private copy of the resulting 2,567-package resolution
graph. Then, on **every LSP request**, `Inner::snapshot()` deep-clones that graph
**once per scope** before the request runs.

On the workspace that prompted this study — 73 npm members, a 2,567-package
`deno.lock` — that is **1,095 MB of resident memory before a single file is
open**, and **213 MB more for every request in flight**, permanently, because
the C allocator does not give it back.

Four numbers make the shape of it plain:

| | |
|---|---:|
| resident memory after configuration load, `enablePaths` = 6 members | **1,099 MB** |
| resident memory after configuration load, `enablePaths` = 1 member | **1,095 MB** |
| a synthetic workspace: 73 empty members, one line of TypeScript, no `node_modules`, and this workspace's `deno.lock` copied in | **1,113 MB** |
| the same synthetic workspace with the `deno.lock` deleted | **49 MB** |

The language server's configuration-time memory is a function of **member count ×
lockfile size** and of nothing else. It does not depend on `enablePaths`, on the
source tree, or on `node_modules` — the synthetic workspace has none of them and
lands within 2% of the real one.

## The ablation that settles the scoping question

Same binary, same target file, same session; only `deno.enablePaths` differs.
Raw output in [`evidence/enable-path-ablation.txt`](evidence/enable-path-ablation.txt).

| | A: one enabled path | B: the six the editor uses |
|---|---:|---:|
| distinct `deno.json` files the server resolved | **52** | **53** |
| workspace members it opened a file inside | **67** | **67** |
| `open()` calls | 38,525 | 39,038 |
| `opendir()` calls | 6,470 | 6,530 |
| distinct `node_modules` package directories touched | 382 | 384 |
| distinct npm packuments read | 2,016 | 2,016 |
| RSS after configuration load | **1,095 MB** | **1,099 MB** |
| peak RSS | 2,952 MB | 3,115 MB |
| `lsp.did_change_configuration` | 2,041 ms | 2,038 ms |

Enabling one member instead of six changes **nothing measurable**. With a single
member enabled the server still resolved 52 `deno.json` files scattered across
the whole repository and still opened files inside 67 of the 73 members.

**It resolves dependencies that only an unrelated member declares.** Six npm
packages were picked because each appears in the `dependencies` of exactly one
workspace member, and that member is not enabled. All six were resolved anyway,
with files opened inside their package directories:

```
@opentelemetry/sdk-node          3 distinct files opened
@aws-sdk/client-s3               2
@reduxjs/toolkit                 2
@playwright/test                 3
@fortawesome/react-fontawesome   1
@supabase/ssr                    3
```

`deno.enablePaths` narrows `walk_workspace` — that is real, and it is where the
setting is honoured (`cli/lsp/language_server.rs:1124`). It does not narrow what
happens next: one config file found inside an enabled path is enough to discover
the workspace root, and the workspace root expands to every member.

## Where the memory actually is

`harness/heaplog.c` interposes the C allocator, records every allocation of 32 KiB
or more exactly, interval-samples the rest at one sample per MiB, and removes
both again on `free`, so what it reports is **live bytes at the moment of the
dump**. Symbolised offline against the binary. Full output in
[`evidence/heap-profile.txt`](evidence/heap-profile.txt).

| dump | process RSS | live heap | on `NpmResolutionCell::snapshot` |
|---|---:|---:|---:|
| after configuration load | 1,119 MB | 363 MB | **321 MB, 88% of live**, 8 stacks, 272 large allocations |
| after one `didOpen`, `documentSymbol`, `definition` and diagnostics | 2,596 MB | 872 MB | **633 MB, 73% of live**, 17 stacks, 537 large allocations |

The single largest stack in the first dump is **167.4 MB in 68 allocations** —
one per resolver scope:

```
alloc::alloc::Global::alloc_impl_runtime
hashbrown::raw::RawTableInner::new_uninitialized
deno_resolver::npm::managed::resolution::NpmResolutionCell::snapshot
deno_npm_installer::resolution::NpmResolutionInstaller::add_package_reqs_inner
deno_npm_installer::NpmInstaller::add_package_reqs_raw
deno_npm_installer::NpmInstaller::add_package_reqs_no_cache
                                                   ← cli/lsp/resolver.rs:1631
```

In the second dump the largest stack is the same clone reached from somewhere
else entirely — **167.5 MB in 69 allocations, from a go-to-definition**:

```
deno_resolver::npm::managed::resolution::NpmResolutionCell::snapshot
deno::lsp::resolver::LspScopedResolver::snapshot          ← cli/lsp/resolver.rs:245
deno::lsp::language_server::Inner::snapshot               ← cli/lsp/language_server.rs:751
deno::lsp::language_server::Inner::goto_definition
```

**It is the C allocator.** `/proc/<pid>/smaps` at 4,619 MB RSS
([`evidence/smaps-at-peak.txt`](evidence/smaps-at-peak.txt)):

| mapping | virtual | resident |
|---|---:|---:|
| `[heap]` — the glibc main arena, reached only through `malloc` | 2,729 MB | **2,729 MB** |
| all anonymous mappings together | | 1,843 MB |
| — of which: a run of mappings just under 64 MB each, glibc's per-thread arena size | | most of it |
| — of which: the two largest single mappings, 128 MB apiece | 262 MB | 262 MB |
| the largest reservation in the process, `---p`, no access | 16,384 MB | **0 MB** |
| an `rwxp` mapping, a JIT code range | 256 MB | 3 MB |

**2,729 MB of the 4,619 is `[heap]` alone**, which is `malloc` and nothing else,
and the heap profiler independently attributes 872 MB of *live* C-allocator bytes
at a smaller peak. The largest reservation in the process holds no resident pages
at all. Nothing here supports the tsc isolate being where the memory is.

That is also why RSS is flat once reached rather than falling: glibc does not
return arena pages, so the process's resident size is the **high-water mark** of
what was ever simultaneously live, and the language server never gives it back.

## The two multiplicands, measured separately

Synthetic workspaces: N members, each one `package.json` and a one-line `.ts`
file, no `node_modules`, no other TypeScript. The only other input is a
`deno.lock` copied verbatim from the real workspace. Raw output in
[`evidence/member-scaling.txt`](evidence/member-scaling.txt).

| members | `deno.lock` | RSS after config | RSS after `didOpen` | 60 sequential `definition` requests |
|---:|---|---:|---:|---:|
| 1 | copied in | 78 MB | 321 MB | 354 ms |
| 8 | copied in | 178 MB | 454 MB | 1,415 ms |
| 24 | copied in | 410 MB | 742 MB | 4,500 ms |
| 73 | copied in | **1,113 MB** | 1,630 MB | **13,213 ms** |
| 1 | none | 44 MB | 291 MB | 62 ms |
| 73 | none | **49 MB** | 299 MB | **156 ms** |

- **Configuration memory is linear in member count**: least squares over the four
  lockfile arms gives **14.4 MB per member** on a 64 MB intercept, and predicts
  1,113 MB at 73 members against 1,113 MB measured.
- **Delete the lockfile and it collapses**, at the same 73 members: 1,113 MB →
  49 MB, and 13,213 ms → 156 ms. The member count is the multiplier; the
  lockfile is what gets multiplied.
- **Request latency is linear in member count too**: 5.9, 23.6, 75.0 and 220.2 ms
  per `definition`, a fit of **2.99 ms per member per request**, in a workspace
  whose entire content is one line of TypeScript.

## What one in-flight request costs

Sequential requests are free — the clone is made, used and dropped, and the next
request reuses the same arena. **Concurrent requests are not**, because each one
holds its own copy of every scope's graph at the same time, and the high-water
mark never comes back down. [`evidence/concurrency.txt`](evidence/concurrency.txt).

Every arm below runs its requests in batches of eight, so eight are in flight at
any moment. "Per in-flight request" is the whole rise divided by eight.

| workspace | RSS before the loop | RSS after it | per in-flight request |
|---|---:|---:|---:|
| synthetic, 1 member | 333 MB | 385 MB | 6.5 MB |
| synthetic, 24 members | 742 MB | 1,300 MB | 69.8 MB |
| synthetic, 73 members | 1,631 MB | 3,613 MB | **247.8 MB** |
| the real workspace, 73 members | 2,852 MB | 4,553 MB | **212.6 MB** |

On the real workspace, eight concurrent go-to-definition requests — the cheapest
request there is, on a file already open and already diagnosed — moved resident
memory from **2,852 MB to 4,602 MB in one batch of eight**. The following 88
requests did not move it further: the arenas were already big enough.

An editor does not issue one request at a time. Diagnostics for several
documents, semantic tokens, inlay hints, code lenses and completion all overlap.

## The lockfiles

- **`pnpm-lock.yaml` is never opened. Not once, in any arm.** `deno lsp` does not
  read it. Its 0.9 MB is irrelevant to this.
- **`deno.lock` is opened 3 times** at the workspace root and parsed once per
  workspace root — `ConfigTree::refresh` caches it in `ws_data_cache`
  (`cli/lsp/config.rs:1940`) precisely so that it is not re-read per scope. Two
  further lockfiles belonging to nested members were opened twice each.
- **Its contents are what is duplicated, not its parsing.** 262 npm specifiers
  and 2,567 npm packages become one `NpmResolutionSnapshot` per scope at
  configuration time, and one more per scope per in-flight request thereafter.
- **2,016 distinct npm packuments were read**, 198.5 MB of JSON on disk, over
  6,189 `open()` calls — roughly three reads of each. These are the registry
  metadata files in the global npm cache, read while the per-scope graphs are
  built.

## Ruled out by measurement

| hypothesis | what rules it out |
|---|---|
| the 348 MB of `node_modules` declaration files is what is in memory | 657 distinct `.d.ts` files are opened, 7.6 MB on disk, in every arm |
| `pnpm-lock.yaml` is read | zero `open()` calls on it, in every arm |
| `deno.lock` is re-read or re-parsed per scope | 3 `open()` calls at the workspace root; it is cached per workspace root at `config.rs:1940` |
| the memory is V8, and the tsc program is what is large | `[heap]`, which only `malloc` reaches, is 2,729 MB of the 4,619; the largest reservation in the process holds **0** resident pages |
| `deno.enablePaths` narrows the work | one enabled path and six produce the same 67 members, the same 2,016 packuments and RSS within 4 MB |
| it is a leak | RSS is flat once reached, and the live-heap profile at the peak accounts for 872 MB of it |
| it needs a real repository to reproduce | 73 empty members and a copied `deno.lock` reproduce the configuration-time figure to within 2% |

## Root cause, traced

Four lines, in order of when they fire. Line numbers are against `v2.9.5`.

**1. `cli/lsp/config.rs:2016` — a scope per member, regardless of what is enabled.**

```rust
for (member_scope, _) in data.member_dir.workspace.config_folders() {
  ...
  scopes.insert(member_scope.clone(), Arc::new(member_data));
}
```

`walk_workspace` honours `enablePaths` and yields only config files inside them.
`ConfigTree::refresh` then takes each of those, discovers the workspace it
belongs to, and inserts a scope for **every config folder of that workspace**.
One `deno.json` inside one enabled member is enough to pull in every other one.

**2. `cli/lsp/resolver.rs:629-649` — every scope is seeded with the whole lockfile.**

```rust
for resolver in std::iter::once(&unscoped).chain(by_scope.values()) {
  let npm_reqs = lockfile.lock().content.packages.specifiers.keys()
    .filter(|r| r.kind == PackageKind::Npm)
    .map(|r| r.req.clone()).collect::<Vec<_>>();
  resolver.add_npm_reqs(npm_reqs);
}
```

Not the scope's own dependencies — **every npm specifier in the workspace**. A
member that depends on nothing is given the same 262 requirements as the member
that depends on everything.

**3. `cli/lsp/resolver.rs:1086` and `:1157` — each scope resolves them into its own graph.**
`NpmResolutionInitializer::new(..., ResolveFromLockfile { lockfile })` followed by
`ensure_initialized()`, on a `NpmResolutionCell` that belongs to that scope's
`ResolverFactory` and is shared with nothing. This is the 68 allocations in the
first heap dump.

**4. `cli/lsp/resolver.rs:236-245` — and it is deep-cloned again on every request.**

```rust
fn snapshot(&self) -> Arc<Self> {
  // todo(dsherret): this is pretty terrible... we should improve this.
  let mut factory = ResolverFactory::new(self.config_data.as_ref());
  factory.services.npm_resolution.set_snapshot(self.npm_resolution.snapshot());
```

`LspResolver::snapshot()` (`resolver.rs:676`) calls that for **every** scope.
`Inner::snapshot()` (`language_server.rs:751`) calls `LspResolver::snapshot()`.
`Inner::snapshot()` is called from **35 sites** in `language_server.rs` — hover,
completion, definition, references, rename, folding ranges, semantic tokens,
inlay hints, code lenses, document symbols, workspace symbols, diagnostics. The
`todo` in the source is at the exact line the profiler names.

```
initialize / did_change_configuration
│
├─ walk_workspace                     honours enablePaths      language_server.rs:1124
│    └─ config files inside the enabled paths only
│
├─ ConfigTree::refresh                                          config.rs:2016
│    └─ for every config folder of the discovered workspace  ──▶  a scope each
│
└─ LspResolver::from_config                                     resolver.rs:629
     └─ per scope: every npm specifier in deno.lock  ──▶ NpmResolutionCell
          NpmResolutionInstaller::add_package_reqs_inner        resolver.rs:1631
            NpmResolutionCell::snapshot   68 × the whole graph   1,095 MB

every LSP request
│
└─ Inner::snapshot                                    language_server.rs:751
     └─ LspResolver::snapshot                              resolver.rs:676
          └─ per scope: LspScopedResolver::snapshot         resolver.rs:245
               NpmResolutionCell::snapshot  68 × the whole graph   213 MB, per request in flight
```

## What this explains, and what it does not

**Explained, and measured:**

- the 1,095–1,119 MB the language server holds before any file is open, on this
  workspace and reproduced to within 2% by a synthetic one;
- why `deno.enablePaths` does not help;
- why the memory is flat once reached — it is glibc arena high-water, not a leak;
- why request latency on a trivial file is hundreds of milliseconds;
- 73% of live heap at the probe's peak, and 88% at configuration load.

**Not explained.** The editor session in
[`../real-workspace/README.md`](../real-workspace/README.md#memory-is-not-fixed-it-got-worse-and-nothing-here-explains-it)
reached **8.2 GB and 10.6 GB**. The furthest anything here reached is **4.6 GB**,
with eight requests in flight on the real workspace. The mechanism has no bound
in the number of concurrent requests, and an editor generates far more of them
than this probe does, but **that is a mechanism, not a measurement, and no arm
here reproduces 10.6 GB.** Anyone quoting this should quote 4.6 GB.

Also unexplained: at configuration load, live heap is 363 MB against 1,119 MB
resident. The 321 MB of per-scope graphs is 88% of what is *live*, and 29% of
what is *resident*. The remainder is allocator high-water from the churn of
building those graphs — 198.5 MB of packument JSON is parsed and discarded in the
same phase — but no arm here separates fragmentation from transient live peaks.

## The patch: share the snapshot instead of copying it

```
python3 apply-shared-snapshot.py /path/to/deno    # a v2.9.5 checkout
```

Seven anchor-exact edits across three files, all validated before anything is
written. It attacks **only the per-request half** — item 4 of the trace — and it
is chosen because it is the one change in this area that **cannot alter what any
scope resolves**.

`NpmResolutionCell` holds `RwLock<NpmResolutionSnapshot>`. The patch makes it
hold `RwLock<Arc<NpmResolutionSnapshot>>` and adds `snapshot_rc()` /
`set_snapshot_rc()` beside the existing `snapshot()` / `set_snapshot()`, which
keep their signatures and their behaviour. `LspScopedResolver::snapshot` then
hands the request's fresh cell an `Arc` to the same snapshot instead of a deep
copy of it:

```rust
-      .set_snapshot(self.npm_resolution.snapshot());
+      .set_snapshot_rc(self.npm_resolution.snapshot_rc());
```

### Why it cannot change a resolution

The stored snapshot **was already immutable in place**. `set_snapshot` is the
only writer in the file and it *replaces* the value; nothing anywhere calls
`Arc::get_mut` or `Arc::make_mut` on it, and no method takes `&mut` to it. So an
`Arc` to that value observes exactly the bytes a clone of it would have
observed, for as long as it is held.

Each request still gets **its own cell**. A later `set_snapshot` on the live cell
swaps that cell's `Arc` and leaves the request's `Arc` pointing at the value it
was given — which is precisely the freeze the deep copy existed to provide. The
snapshot semantics are preserved exactly; only the copying is removed.

**The candidate that would have been worth more is rejected for this reason.**
Sharing one `NpmResolutionCell` across all scopes of a workspace root would
remove the configuration-time duplication too, and it is what the `todo` is
really asking for. It also means a scope observes another scope's
`add_npm_reqs`, so a specifier could resolve to a different version, or to
nothing, depending on when a background resolution landed — a spurious diagnostic
or a dead go-to-definition, which is worse than slow. It needs the restructuring
the `todo` describes, not an anchor-exact patch.

### Collateral

- **No signature changes.** `LspScopedResolver::snapshot()` still returns
  `Arc<Self>`, so all **35** `Inner::snapshot()` call sites in
  `language_server.rs` are untouched and unrecompiled in any meaningful sense.
- **`NpmResolutionCell::snapshot()` and `set_snapshot()` keep their signatures.**
  Their other call sites — `libs/npm_installer/initializer.rs:113` and
  `libs/npm_installer/resolution.rs:183` — are untouched, and both were compiled
  in the verification below.
- **No new `use` statements**, in any file. `std::sync::Arc` is named once,
  fully qualified, inside a new `pub type NpmResolutionSnapshotRc`.
- **No new trait bounds.** `#[derive(Default)]` on `NpmResolutionCell` still
  holds because `NpmResolutionSnapshot: Default`.
- **One new clippy allow**, copying verbatim the idiom the file already uses two
  lines above for `NpmResolutionCellRc`, because `libs/resolver/clippy.toml`
  disallows `std::sync::Arc` in favour of `deno_maybe_sync::MaybeArc`. `MaybeArc`
  is deliberately **not** used here: without the `sync` feature it is `Rc`, which
  would strip `Send`/`Sync` from `NpmResolutionCell` in a build configuration
  this study cannot compile. `Arc` never removes an auto trait.
- **One new re-export** in `libs/resolver/npm/managed/mod.rs`, beside the
  existing `NpmResolutionCellRc` one. Cosmetic — the CLI never names the alias.

### What was verified, and what was not

Full transcript in [`evidence/patch-verification.txt`](evidence/patch-verification.txt);
re-run it with [`verify/run.sh`](verify/run.sh).

| | |
|---|---|
| applies to a fresh `git clone --depth 1 --branch v2.9.5` | **yes**, 7/7 anchors at count 1 |
| re-applying | **fails and writes nothing** — all anchors are checked before the first write |
| `rustfmt --edition 2024` on both reformatted files | **parses, and rustfmt-clean** |
| `cargo check -p deno_npm_installer` — compiles the patched `deno_resolver` and both untouched `set_snapshot` callers | **clean, no errors, no warnings** |
| the exact expression the CLI edit produces, `destination.set_snapshot_rc(source.snapshot_rc())` on two `&NpmResolutionCellRc`, in a probe crate | **type-checks** |
| the same probe against an unpatched clone | **fails with two `E0599`s**, so the probe does exercise the new methods |
| `cargo check -p deno` — the CLI itself | **not done.** The machine had 4.4 GB of free disk; the CLI's graph pulls `v8`, `deno_core` and `swc`. `cargo check -p deno_resolver --features sync` also does not build, patched **or pristine**, on two pre-existing errors in `libs/resolver/rt.rs` that want `deno_unsync/tokio`; that is why the check is run through `deno_npm_installer` |
| behaviour | **not measured at all.** No binary was built. Nothing below is a measurement |

### What it should be worth

Predictions, to be checked against a built binary. Every one is derived from the
live-heap split at the probe's peak: of 871.8 MB live, **321.2 MB is on stacks
that pass through `LspScopedResolver::snapshot`** and 311.4 MB is on stacks that
do not.

| measurement | today | predicted |
|---|---:|---:|
| real workspace, RSS rise over 96 requests eight at a time | +1,701 MB | **under +100 MB** |
| real workspace, RSS after that loop | 4,553 MB | **≈2,900 MB** |
| synthetic 73 members, RSS rise over 32 requests eight at a time | +1,982 MB | **under +100 MB** |
| synthetic 73 members, peak RSS | 3,613 MB | **≈1,700 MB** |
| probe peak, live heap | 872 MB | **≈550 MB** |
| synthetic 73 members, 60 sequential `definition` | 13,213 ms | **600–2,400 ms** |
| real workspace, RSS after configuration load | 1,095 MB | **unchanged** |
| `lsp.did_change_configuration` | 2,038 ms | **unchanged** |

The latency row is the least certain: the per-request clone goes away, but
`LspResolver::snapshot` still constructs a `ResolverFactory` and a
`CliNpmResolver` per scope per request, and this study has never measured what
those cost on their own. **The two "unchanged" rows are the falsifier** — if
configuration-time RSS moves, the attribution above is wrong.

### What it does not fix

- **The 68 per-scope graphs built at configuration load.** 311.4 MB of live heap,
  and the whole 1,095 MB of configuration-time resident memory. Untouched.
- **Scope creation for members nothing enabled.** `config.rs:2016` is untouched.
- **The 2,016 packuments and 198.5 MB of registry JSON** read while those graphs
  are built. Untouched.
- **`op_script_names`**, which is [defect 4](../defect-4-export-keys/README.md).

## Reproducing it

```
cc -shared -fPIC -O2 -o fslog.so   harness/fslog.c   -ldl
cc -shared -fPIC -O2 -o heaplog.so harness/heaplog.c -ldl

OUT_DIR=/var/tmp/d6 FSLOG_SO=$PWD/fslog.so DENO_BIN=<traced deno> \
  ./repro/run-arm.sh six-enabled <workspace-root> \
    --enable ./path/a --enable ./path/b --open <workspace-root>/path/a/src/index.ts

OUT_DIR=/var/tmp/d6 FSLOG_SO=$PWD/fslog.so HEAPLOG_SO=$PWD/heaplog.so DENO_BIN=<traced deno> \
  ./repro/run-arm.sh heap <workspace-root> --enable ./path/a --open <file>

OUT_DIR=/var/tmp/d6 FSLOG_SO=$PWD/fslog.so DENO_BIN=<traced deno> \
  SYNTH_ROOT=/var/tmp/synth SYNTH_LOCK=<a deno.lock> SYNTH_COUNTS="1 8 24 73" \
  REQUEST_COUNT=60 ./repro/sweep-synth.sh

python3 harness/analyze.py /var/tmp/d6/six-enabled <workspace-root>
ATTRIBUTE=NpmResolutionCell::snapshot \
  python3 harness/heapsym.py '/var/tmp/d6/heap/heaplog.txt.peak' <traced deno> 8

python3 apply-shared-snapshot.py /path/to/deno
WORK=/var/tmp/defect6-verify ./verify/run.sh
```

`REQUEST_COUNT` and `REQUEST_CONCURRENCY` drive the request loop; `MAX_RSS_MB`
kills the server rather than the machine; `MARKERS` gives `analyze.py` a list of
package names to look for. Every arm is pinned to three cores. The synthetic sweep
needs no real repository and no `node_modules` — only a `deno.lock` to copy and a
populated global npm cache, and it reproduces the whole configuration-time
result.

## Layout

| path | what it is |
|---|---|
| `harness/probe6.mjs` | the driver: enable-path arms, phased RSS sampling, diagnostics waiting, request loops, `smaps` capture, heap-dump triggering |
| `harness/fslog.c` | `LD_PRELOAD` shim logging every `open`/`openat` and `opendir` with a millisecond stamp |
| `harness/heaplog.c` | `LD_PRELOAD` sampling heap profiler: exact for allocations ≥ 32 KiB, interval-sampled below that, live-set tracked through `free`, dumped on `SIGUSR1` |
| `harness/heapsym.py` | symbolises a heap dump against the binary and ranks stacks by live bytes |
| `harness/analyze.py` | classifies an `fslog` capture: lockfiles, packuments, `.d.ts`, per-member and per-package counts, marker packages |
| `harness/redact.py`, `harness/sanitize.sh` | what turned the captures into the evidence files: one rewrites absolute paths, the other replaces workspace member names with indices |
| `apply-shared-snapshot.py` | the patch, applied to a deno v2.9.5 checkout |
| `verify/run.sh`, `verify/probe/` | clone, apply, re-apply, rustfmt, `cargo check`, and the type-check probe with its negative control |
| `repro/run-arm.sh` | one arm |
| `repro/make-synth.sh`, `repro/sweep-synth.sh` | the synthetic workspaces and the member sweep |
| `evidence/` | the raw output every number above is read from |

## Against the finding

**The repeatability is 5%, and the `enablePaths` difference is smaller than
that.** Three arms on the real workspace share a configuration — six enabled
paths, the same target file — and differ only in what the probe did afterwards.
Their RSS after configuration load is 1,099, 1,119 and 1,068 MB, a spread of
51 MB. The one-enabled-path arm reports 1,095 MB. The scoping claim rests on a
4 MB difference sitting well inside that spread, which is exactly the point:
there is no difference to find. The 1,119 MB arm is the one running under the
heap profiler, which makes it 1.6× slower in wall time and is the only check made
that the profiler does not distort what it measures.

**The sampling estimator is coarse where it matters least.** Allocations under
32 KiB are estimated as `samples × 1 MiB`; the configuration dump rests on 155
samples and the peak dump on 364, so those halves carry roughly 8% and 5%
relative error. Every figure attributed to `NpmResolutionCell::snapshot` in the
first dump's largest stack is from **exactly recorded** large allocations, not
from sampling.

**68 is a count of allocations, not of scopes.** The number of resolver scopes is
not logged by `deno lsp` and was not measured directly. 68 and 69 are how many
live per-scope allocations the profiler found at the two dumps; 52 and 53 are how
many distinct `deno.json` files the server's own log says it resolved; 73 is the
number of directories the root `package.json`'s `workspaces` globs match. These
are three different quantities and this directory does not reconcile them.

**The synthetic workspace is not the real one.** It matches on configuration-time
RSS to within 2% (1,113 MB against 1,095) and on what an in-flight request costs
to within 17% (247.8 MB against 212.6), which is what licenses using it for the
scaling law. It has no `node_modules`, so it cannot say anything about
`op_script_names`, about `.d.ts` loading, or about anything downstream of tsc.

**Sequential requests cost nothing, and that is easy to misread.** The 213 MB
figure is per request *in flight*, not per request. A client that never overlaps
requests pays it once.

**The patch is verified to compile, not to behave.** No binary carrying it was
built and no arm was run against one. Every figure in "what it should be worth"
is a prediction derived from the live-heap split, and is labelled as one.

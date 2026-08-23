# Where this walk comes from

The line responsible, established by capturing a call stack at every `opendir`
and resolving it against the binary's debug information, then costed by a
complete `opendir` path log with the configuration varied one field at a time.

```
./run.sh                          # the bundled sample repository
./run.sh /path/to/repo            # any repository
./run.sh /path/to/repo src/x.ts   # a specific entry file

NOISE=2000 ./run.sh               # directories per untracked tree in the sample
ST_MATCH=/.venv ./run.sh          # only backtrace opens whose path contains this

./evidence/walk-attribution.sh [n]     what each traversal costs, differentially
./evidence/scale-control.sh            how it grows
./evidence/gitignore-semantics.sh      how the proposed bound behaves
```

Requires `gcc`, `addr2line`, `node`, `python3`, and a `deno` built with
`--features lsp-tracing` at `../../bin/deno` — see
[`../../bin/README.md`](../../bin/README.md). The tracer, the `opendir` shim and
the drivers are shared, in [`../../harness/`](../../harness/README.md).

## The chain

```
initialized                                       cli/lsp/language_server.rs:4265
  Inner::refresh_compiler_options_resolver
    LspCompilerOptionsResolver::from_inner         cli/lsp/compiler_options.rs:87
      collect_specifiers                           cli/util/fs.rs:91
        FileCollector::collect_file_patterns
          sys.fs_read_dir                          libs/config/glob/collector.rs:178
```

`collect_specifiers` and `collect_file_patterns` are inlined in the binary. What
the capture shows between `collector.rs:178` and `from_inner` is a single
`FilterMap::next` frame, which is those two collapsed. On the sample at
`NOISE=2000`, **18,386 of 19,378 captured opens (94.9%)** carry this stack; the
only other stack in the run is `refresh_workspace_files` with 992.

**`libs/config/glob/collector.rs:177-180`** — the read, and it is the same line
defect 1 bottoms out at:

```rust
while let Some(next_dir) = pending_dirs.pop_front() {
  let Ok(entries) = sys.fs_read_dir(&next_dir) else {   // 178
    continue;
  };
```

**`cli/lsp/compiler_options.rs:91-115`** — why it runs, once per distinct
`FilePatterns`:

```rust
let mut ts_config_roots_cache = HashMap::new();
let ts_config_roots = inner
  .ts_config_file_patterns()
  .filter_map(|(key, file_patterns)| {
    if let Some(roots) = previous_roots_cache.get(&file_patterns) { ... }
    let roots = collect_specifiers(
      CollectSpecifiersOptions {
        file_patterns: file_patterns.clone(),
        vendor_folder: None,
        include_ignored_specified: true,
      },
      is_lsp_root_file,
    )
```

The cache is keyed on **exact `FilePatterns` equality**, and no two tsconfigs in
a workspace share a base, so every one of them gets its own walk.

**`cli/util/fs.rs:135-139`** — what it declines to switch on:

```rust
let collected_files = FileCollector::new(predicate)
  .ignore_git_folder()
  .ignore_node_modules()
  .set_vendor_folder(vendor_folder)
  .collect_file_patterns(&CliSys::default(), &file_patterns);
```

No `.use_gitignore()`, and `vendor_folder` is `None` from this caller. The
builder method exists at `collector.rs:66` and `GitIgnoreTree` is already wired
into the walk; it is present and switched off.

**`libs/config/glob/mod.rs:85-119`** — why `include` does not bound the descent:

```rust
PathKind::Directory => {
  // for now ignore the include list unless there's a negated
  // glob for the directory
```

`include` is consulted for files and, through `split_by_base`, for where a walk
*starts*. For every directory below that start it is not consulted at all. Only
`exclude` prunes.

## The sample

A workspace shaped to reach this walk and only this walk:

- **No root `package.json`.** Members are explicit paths in `deno.json`, so
  `handle_workspace_folder_with_members` never runs and defect 1 cannot
  contribute a single open.
- **A root `tsconfig.json` with `references` and nothing else** — no `include`,
  no `files`, no `exclude`. Its `FilePatterns` base is the workspace root.
- **Member `tsconfig.json` with `include: ["src"]` and no `exclude`.**
- **Untracked mass inside the tsconfig bases**: `.venv` and `dist` beside `src`,
  reached by the root tsconfig; `.cache` inside `src`, reached by the root
  tsconfig and by the member's own. All three are in `.gitignore`.
- `dist` holds `.js` files, so it does not merely cost opens — its contents enter
  the root set, `is_lsp_root_file` accepting every script and JSON media type.

## The arms

Every figure in `evidence/walk-attribution.txt` is a complete count of `opendir`
calls, not a sample and not a backtrace. The arms differ in exactly one field of
one configuration file:

| arm | what changed |
|---|---|
| `as-built` | nothing — the sample as it ships |
| `root-exclude` | root `tsconfig.json` gains `exclude: ["**/.venv", "**/dist", "**/.cache"]` |
| `member-exclude` | each member `tsconfig.json` gains `exclude: ["**/.cache"]` |
| `all-excluded` | both of the above, all three names everywhere |
| `root-files-empty` | root `tsconfig.json` gains `"files": []` |
| `no-root-tsconfig` | root `tsconfig.json` deleted |
| `root-include-glob` | root `tsconfig.json` gains `include: ["packages/*/src"]` |
| `root-include-path` | root `tsconfig.json` gains `include: ["packages/alpha/src", "packages/beta/src"]` |

The last two name the same two directories and differ only in whether a wildcard
appears. **That is the control for the anchoring rule with the path held fixed**,
which the 46-case matrix's `C05` was confounded and could not provide.
`root-files-empty` and `no-root-tsconfig` agreeing to within 1 open is the
control on the claim that a root tsconfig carrying only `references` walks the
whole workspace: removing the walk and deleting the file cost the same.

The results are read in [`../README.md`](../README.md).

## Reading the gitignore semantics

`deno fmt` is used because it reaches the same `FileCollector` with
`use_gitignore` switched on, and the LSP path cannot be made to without
rebuilding the binary. Every file in each repository is deliberately
mis-formatted, so `1` means the collector reached it and `0` means it never did.
`.gitignore` names `dist/` and `cache/`; the `fmt` `include` is the variable.

## A note on method

**The stack capture's per-stack counts are a lower bound**, for the reason in
[`../../harness/README.md`](../../harness/README.md). An earlier capture of this
same sample at `NOISE=200` recorded 203 opens for a walk the path log shows made
404. The stack capture establishes **which line**; the path log establishes **how
many**. `walk-attribution.sh` and `scale-control.sh` therefore use no backtraces
at all — they vary one configuration field, count every `opendir`, and subtract.

`example path` in a capture is the **first** path that produced the stack, not a
representative one. Two stacks in `evidence/sample-stacktrace.txt` carry the same
logical call chain with different example paths, because the return addresses
differ by inlining site; both are `from_inner`.

## Files

| path | role |
|---|---|
| `run.sh` | capture and symbolise, against the sample or any repository |
| `sample/` | the workspace above; `sample/generate-noise.sh` materialises the untracked trees |
| `evidence/sample-stacktrace.txt` | the call stack at every `opendir`, symbolised. Produced by `NOISE=2000 ../run.sh` |
| `evidence/walk-attribution.sh`, `.txt` | what each traversal costs, one field at a time. Produced by `walk-attribution.sh 200` |
| `evidence/scale-control.sh`, `.txt` | the same walk at three sizes, with and without the version-control bound |
| `evidence/gitignore-semantics.sh`, `.txt` | how `FileCollector::use_gitignore` treats an explicitly included path, a glob, and a nested ignore rule |

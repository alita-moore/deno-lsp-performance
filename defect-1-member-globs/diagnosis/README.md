# Where this walk comes from

The line responsible, established by capturing a call stack at every `opendir`
and resolving it against the binary's debug information. Nothing here is
inferred from reading source.

```
./run.sh                          # the bundled sample repository
./run.sh /path/to/repo            # any repository
./run.sh /path/to/repo src/x.ts   # a specific entry file

NOISE=2000 ./run.sh               # directories per vendor tree in the sample
ST_MATCH=/.venv ./run.sh          # only backtrace opens whose path contains this
TOP=5 ./run.sh                    # how many stacks to symbolise
```

Requires `gcc`, `addr2line`, `node`, `python3`, and a `deno` built with
`--features lsp-tracing` at `../../bin/deno` — see
[`../../bin/README.md`](../../bin/README.md). A stock release binary emits no
spans. The tracer and the driver are shared, in
[`../../harness/`](../../harness/README.md).

## The chain

```
initialized                                       cli/lsp/language_server.rs:4261
  Inner::refresh_config_tree                      cli/lsp/config.rs:2013
    ConfigData::load
      WorkspaceDirectory::discover
        discover_workspace_config_files_for_single_dir
          handle_workspace_folder_with_members    libs/config/workspace/discovery.rs:898
            resolve_workspace_for_config_folder   libs/config/glob/collector.rs:178
              sys.fs_read_dir
```

**`libs/config/glob/collector.rs:177-180`** — the read:

```rust
while let Some(next_dir) = pending_dirs.pop_front() {
  let Ok(entries) = sys.fs_read_dir(&next_dir) else {   // 178
    continue;
  };
```

**`libs/config/glob/collector.rs:195-209`** — what it declines to skip:

```rust
fn is_ignored_dir(&self, path: &Path) -> bool {
  path.file_name().map(|dir_name| {
    match dir_name.as_str() {
      "node_modules" => self.ignore_node_modules,
      ".git" => self.ignore_git_folder,
      _ => false,
    }
  }).unwrap_or(false) || self.is_vendor_folder(path)
}
```

`node_modules`, `.git`, and one exact vendor path. `.venv`, `dist`, `build`,
`.cache`, `target` and `coverage` are descended into.

**`libs/config/workspace/discovery.rs:889-903`** — why it runs at all:

```rust
if let Some(pkg_json) = root_config_folder.pkg_json()
  && let Some(members) = &pkg_json.workspaces
{
  let (pattern_members, path_members) = members.iter()
    .partition(|member| is_glob_pattern(member) || member.starts_with('!'));
  let pkg_json_paths = collect_member_config_folders(   // 898
    "npm", pattern_members, pkg_json.dir_path(), &["package.json"],
  )?;
```

It expands the glob members of `package.json`'s `workspaces` field, searching for
`package.json` files, once per `ConfigData::load` — once per scope. The
`FilePatterns` it builds carries `exclude: PathOrPatternSet::new(Vec::new())`, an
empty exclude by construction. The same collector is reached at
`discovery.rs:822` for glob members of a `deno.json` `workspace` field, there
searching for `deno.json`, `deno.jsonc` **and** `package.json`.

## Corroboration

On the sample, one stack accounts for **12,009 of 21,192** opens. On the real
workspace, one stack accounts for **all 8,645** `.venv` opens, the only other
stack in the entire run having a count of 1
(`../../real-workspace/evidence/real-workspace-capture.txt`).

The same chain appears in both, and in every repeat run. It is not sensitive to
timing, load, or which entry file is opened.

## The positional control

`evidence/position-control.sh` builds the sample twice with an identical vendor
tree, changing only where it sits. At the default `800` it materialises 800
packages, 1,601 directories.

| arm | `.venv` location | `opendir` into `.venv` |
|---|---|---|
| `inside-member` | `packages/alpha/.venv` | 2,587 |
| `at-root` | `.venv` | 1 |

Same tree, same size, same config, three orders of magnitude apart. `packages/*`
bounds the search to `packages/`, so a tree outside it is never reached — and
every directory the glob does match is then descended in full.

The aggregate 2,587 is not one quantity. Re-running with the stacks kept apart
(`ST_MATCH="/.venv"`, symbolising rather than summing `TOTAL` lines) splits it
into 1,601 from the member-glob expansion under `initialized`, 985 from
`refresh_workspace_files`, and 1 from a second expansion under
`did_change_configuration`.

## Removing the symptom without a patch

Deleting the `workspaces` field from `package.json` avoids the cost entirely,
because the expansion never runs. So does declaring members as explicit paths.
Both give up npm workspace resolution or glob members respectively.

## Files

| path | role |
|---|---|
| `run.sh` | capture and symbolise, against the sample or any repository |
| `sample/` | a minimal repository reproducing the behaviour |
| `sample/generate-noise.sh` | materialises the vendor trees inside matched members; position is the variable |
| `evidence/sample-stacktrace.txt` | full symbolised run against `sample/`: every `opendir`, grouped by call stack |
| `evidence/position-control.sh`, `.txt` | the two arms above |

Read the per-stack counts as a lower bound and the reason why in
[`../../harness/README.md`](../../harness/README.md); the exact costs in this
tree come from complete `opendir` path logs, never from the stack capture.

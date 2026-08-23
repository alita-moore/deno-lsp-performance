# The two resolvers

The false-negative table is not a stand-in. It is produced by running deno's own
workspace resolver twice — once from a clean `v2.9.5` checkout, once from the
same checkout with `apply-authoritative.py` applied — over the same directory
trees, and diffing the member sets.

`members.rs` is a `deno_config` example that installs a logger, calls
`WorkspaceDirectory::discover` at the paths given on the command line, and prints

```
LOG WARN <every warning the resolver emitted>
ROOT <the resolved workspace root>
MEMBER <one line per config folder in the resolved workspace>
ERROR <the discovery error, if discovery failed>
```

`config_folders()` is the same accessor `refresh_config_tree` iterates when it
decides how many `ConfigData::load` calls to make (`cli/lsp/config.rs:2016`) and
the same one `deno task --recursive` iterates (`cli/tools/task.rs:1274`), so the
member set it prints is the member set the language server pays for.

`build.sh` clones the tag, drops the example into both trees, patches one of
them, and builds both. It prints the two paths the arena wants:

```
./build.sh
export MEMBERS_BASELINE=... MEMBERS_PATCHED=...
python3 ../arena/run.py
```

This builds **only the `deno_config` crate and its dependencies**, which takes
about thirty seconds, not the deno CLI. That is the whole reason the arena can
measure the real patch rather than a configuration stand-in.

## What this cannot reach

The language server itself. Building the CLI needs far more disk than was
available here, so **no patched `deno lsp` binary was produced and none of the
cost figures in [`../cost/`](../cost/README.md) were taken with the patch
applied** — they are taken with a stock traced binary and a configuration
stand-in, and they are labelled as such. Whether the new warning reaches an
editor, and through which channel, is unmeasured.

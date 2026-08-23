# The `workspace` field does not bound membership

`resolve_workspace_for_config_folder` builds one map, `final_members`, and fills
it from two places in sequence.

```
libs/config/workspace/discovery.rs

693   let mut final_members = BTreeMap::new();

811   if let Some(deno_json) = root_config_folder.deno_json()
        && let Some(workspace_config) = deno_json.to_workspace_config()?
      {                                            the "workspace" field
876     let previous_member = final_members.insert(...)
878     if previous_member.is_some() { return Err(Duplicate) }
      }

889   if let Some(pkg_json) = root_config_folder.pkg_json()
        && let Some(members) = &pkg_json.workspaces
      {                                            the "workspaces" field
961     // don't surface errors about duplicate members for
962     // package.json workspace members
963     final_members.insert(new_rc(member_dir_url), member_config_folder);
      }
```

Two sequential `if` blocks over one map. Neither reads the other's result.
The first rejects a repeat as `Duplicate`; the second inserts over whatever is
there, with a comment saying the duplicate check is suppressed on purpose. So
the resolved membership is the **union** of the two lists, and where the npm
globs already cover a directory, naming it in `deno.json` changes nothing.

## Measured, on the shipped binary

`deno task --recursive` walks `workspace.config_folders()`
(`cli/tools/task.rs:1274`) — the same accessor the language server iterates to
decide how many `ConfigData::load` calls to make (`cli/lsp/config.rs:2016`) — and
prints one heading per member. That makes it a membership oracle needing no
instrumentation at all.

`run.py` builds thirteen workspaces and reads each three times: with both fields
as written, with the `workspaces` field removed, and with the `workspace` field
removed. The last column is the question — is the resolved set the same as the
one `package.json` produces on its own?

| case | both, as written | `deno.json` alone | `package.json` alone | `deno.json` inert |
|---|---|---|---|---|
| W1 npm-only member | p00 p01 p02 | p00 | p00 p01 p02 | **yes** |
| W2 drift | p00 p01 p02 | p00 p01 | p00 p01 p02 | **yes** |
| W3 empty `workspace` array | p00 p01 | *(none)* | p00 p01 | **yes** |
| W4 nested workspace | p00 p01 | p00 | p00 p01 | **yes** |
| W5 member outside every npm glob | e0 p00 | e0 | p00 | no |
| W6 npm literal member | p00 p02 | p00 | p00 p02 | **yes** |
| W7 deno-only dir inside an npm glob | p00 | p00 | p00 | **yes** |
| W7b deno-only dir named literally by npm | **error** | p00 | **error** | **yes** |
| W8 no `workspace` field | p00 p01 | *(none)* | p00 p01 | **yes** |
| W9 npm negation | p00 p01 p02 | p00 p02 | p00 p01 | no |
| W10 `workspace` is itself a glob | p00 p01 q00 | p00 p01 | p00 p01 q00 | **yes** |
| W11 declared member has only a `package.json` | p00 p02 | p00 p02 | p00 p02 | **yes** |
| W12 declared glob covers a `package.json`-only dir | p00 p02 | p00 p02 | p00 p02 | **yes** |

**Eleven of thirteen.** In eleven shapes the answer with the `workspace` field is
character-for-character the answer without it. Only two shapes give the field any
effect at all, and both are cases where the npm side *cannot* reach a directory:
W5, where the declared member lies outside every glob's prefix, and W9, where
`package.json` negates a directory `deno.json` names — and there the union
overrides the negation, which is its own surprise.

Two rows are worth reading twice.

**W3.** `"workspace": []` is a declaration of a workspace with no members. The
resolver produces two members anyway.

**W7b.** A directory named literally by `package.json`'s `workspaces` that has a
`deno.json` and no `package.json` makes the whole workspace fail to resolve:
*"Could not find package.json for workspace member."* Naming it in `deno.json`
does not help, because the npm block runs regardless and it is the one that
errors. This is the only shape in the table where today's behaviour is not merely
redundant but broken.

The premise this investigation started from said that a glob-matched directory
without a `package.json` also errors. It does not — W7 measures it, and the
directory is simply absent, because the glob expansion collects `package.json`
files and finds none there. The error is reachable only through a **literal**
npm member. That correction came from the measurement.

## On the repository that prompted this

Its root `deno.json` names 41 entries, four of which are globs; its root
`package.json` names six globs. Resolved with deno's own resolver:

| | config folders |
|---|---:|
| today | **69** |
| what the `deno.json` list alone would give | **52** |
| supplied only by the npm globs | **17** |
| supplied only by the `deno.json` list | **14** |
| supplied identically by both | **38** |

So for **38 of the 52 members the `deno.json` list is inert**, the npm globs add
**17 members nobody declared**, and the list is doing real work for only the 14
that sit below a glob's reach — the nested function directories, which the npm
globs cannot match. The repository is not a case of total subsumption; it is a
case of 73% subsumption, and the 17 undeclared members are what the language
server pays for.

## Running it

```
DENO_BIN=/path/to/deno python3 run.py
```

Any `v2.9.5` binary. Nothing here needs the tracing feature.

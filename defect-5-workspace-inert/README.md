# Defect 5 — `deno.json`'s `workspace` field cannot bound membership

A root `deno.json` that names its workspace members does not thereby limit them.
Membership is the **union** of the `deno.json` `workspace` list and the
`package.json` `workspaces` list, and where the npm globs already cover a
directory, naming it in `deno.json` changes nothing at all. Measured across
thirteen workspace shapes, **the `workspace` field is inert in eleven of them**:
the resolved member set is identical to the set `package.json` produces on its
own.

On the repository that prompted this study — 41 `deno.json` entries, six npm
globs — deno's own resolver returns **69 config folders**. The `deno.json` list
alone would return 52. **17 members nobody declared**, each of which costs a
`ConfigData::load`, and **38 of the 52 declared members are contributed
identically by the npm globs**, so for those the declaration is doing no work.

The mechanism is two sequential `if` blocks writing one map,
`libs/config/workspace/discovery.rs`:

```
693   let mut final_members = BTreeMap::new();
811   if let Some(deno_json) = ... to_workspace_config()?      the "workspace" field
876     let previous_member = final_members.insert(...)
878     if previous_member.is_some() { return Err(Duplicate) }
889   if let Some(pkg_json) = ... && let Some(members) = &pkg_json.workspaces
961     // don't surface errors about duplicate members for
962     // package.json workspace members
963     final_members.insert(new_rc(member_dir_url), member_config_folder)
```

Neither block reads the other's result. The first rejects a repeated member; the
second overwrites, with a comment saying the check is suppressed on purpose.
There is no precedence to appeal to because there is no precedence.

Full source reading, the thirteen shapes, and the repository decomposition:
[`diagnosis/`](diagnosis/README.md).

## What it costs

A controlled sweep — same tree on disk, only the membership rule changing —
through the same LSP probe the rest of this report uses.
[`cost/`](cost/README.md) has all eighteen rows; the two ends of it:

| N directories under the glob | members | `opendir` | `did_change_configuration` | peak RSS |
|---:|---:|---:|---:|---:|
| 192, today | 192 | 580 | 956 ms | 537 MB |
| 192, with the `deno.json` list authoritative | 2 | 194 | **124 ms** | **310 MB** |

Three laws come out of it, all fitted exactly:

- **Directory opens are 3N + 4 today and N + 2 without the npm block.** The npm
  member-glob expansion runs three times per session and opens the glob's parent
  plus each matched directory each time.
- **Each member costs 5.0 ms of `did_change_configuration` and 1.32 MB of RSS.**
  A third arm that declares all N members literally — N members, no glob
  expansion — tracks today's numbers to within 6% and 1%, which is what
  separates the two costs: **member count buys the time and the memory, the glob
  expansion buys the directory opens.**
- **Below a threshold the member set costs nothing**, because
  `refresh_config_tree` already loads a `ConfigData` for every `deno.json` and
  `package.json` the workspace file walk found, member or not
  (`cli/lsp/config.rs:1985`). That walk stops at 1,000 directory entries
  (`cli/lsp/language_server.rs:1071`), and the arms only separate past it.
  A small repository is not affected by this defect at all.

## The candidates

| | rule | member loss | is the loss said out loud? |
|---|---|---|---|
| **U** — today | union of both lists | none | — |
| **A** | when `deno.json` declares a `workspace`, skip the npm block | the undeclared members | **no — one measured silent case** |
| **A!** | **A, and name every dropped directory** | the same | **yes, every one** |
| **X** | filter the npm block by the declaration | A's, **plus members the user declared** | partly |
| **O** | a new opt-in field | none | — (nothing changes until asked) |

## The false-negative analysis

Deno's resolver was built twice — clean `v2.9.5` and `v2.9.5` with the patch —
and run over thirteen adversarial workspaces from every directory in each. This
is the real code, not a configuration stand-in; the thirty-second build that
makes that possible is in [`verify/`](verify/README.md), and the full table is in
[`arena/`](arena/README.md).

**A! has zero silent losses over 13 workspaces and 41 start directories.** Every
dropped directory is named, by two mechanisms that cover different situations:
the patch prints one warning per resolution listing every directory it dropped,
and deno's *pre-existing* fallback — already gated on the root `deno.json` having
a `workspace` field — warns *"config file … is not a member of the workspace at
… Ignoring the parent workspace config"* whenever discovery starts inside one of
them, which is what the language server does for every scope. The functional
consequence, measured on the shipped binary, is a `TS2307` at the import site.

**A — the same skip without the warning — has a measured silent loss, and is
disqualified on it.** A member matched by the npm glob but not declared keeps its
`deno.json`, and its own `fmt` configuration stops applying to whole-workspace
commands run at the root, with nothing printed:

| `deno fmt --check` at the root | the dropped member's file reported | warnings |
|---|---|---|
| today | yes, under its own `lineWidth` | 0 |
| A | **no** | **0** |

That is the same failure class that got the gitignore mechanism rejected at
[defect 1](defect-1-member-globs/README.md), and it is why the recommendation
carries the warning rather than merely the skip. The warning costs 2N + 2
directory opens — the npm globs still have to be expanded to know what is being
dropped — and that costs nothing measurable in time or memory
([`cost/`](cost/README.md#what-keeping-the-warning-costs)); it is also exactly
the traversal [defect 1's M5](defect-1-member-globs/README.md) bounds to
Θ(members).

Two shapes are worth naming individually. `"workspace": []` — a declared workspace
with no members — takes a two-member repository to zero. Every member is lost,
and every member is printed by name, but it is still a trap and it is stated
here rather than buried. And a directory named literally by `package.json`'s
`workspaces` that carries a `deno.json` and no `package.json` makes the whole
workspace fail to resolve today; under A! it resolves. That one is a repair.

**X is strictly dominated.** It loses everything A! loses, plus, in two of
thirteen shapes, a member the user declared by hand — one that lies outside every
npm glob, and one that `package.json` explicitly negates — and it keeps the hard
failure above.

## The argument against the recommendation, which is not small

**Deno's own test suite asserts the union deliberately.** With the patch applied,
`cargo test -p deno_config --all-features` goes from 168 passing to 167 passing
and one failing, and the one is
`test_multiple_workspaces_npm_package_referenced_in_package_json_workspace`: a
root `deno.json` naming `./member`, a root `package.json` naming `./package`, and
an assertion that **both** are members. That is not an oversight the patch
repairs; it is the behaviour someone wrote a test for. Any version of A or A! is
a semantic change to a tested contract, and it needs to be argued as one rather
than filed as a performance fix.

If that is unacceptable, **O is the fallback**: leave the union alone and add an
opt-in. It cannot lose anything. It also does nothing for any repository whose
author has not adopted it, which today is all of them. It was not implemented and
nothing here measures it.

## The patch

```
python3 apply-authoritative.py /path/to/deno    # a v2.9.5 checkout
```

Three anchor-exact edits, all in `libs/config/workspace/discovery.rs`, 24 lines
added and none removed: a flag set inside the `deno.json` block, a skip in the
`package.json` member loop that collects rather than inserts, and one warning
after it naming everything collected. Every anchor is asserted to occur exactly
once **before anything is written**, so the script either applies in full or
leaves the checkout untouched. It was dry-run against a fresh
`v2.9.5` clone, `cargo check -p deno_config --all-features` is clean, and the
resolver built from it is what produced the false-negative table.

`pkg_json.workspaces` is read in exactly one place in the whole repository, which
is why the edit is this contained.

## What is not settled

- **The cost figures here were taken without a patched language server.** The
  `deno_config` crate builds in half a minute; the CLI needs far more disk than
  was available at the time. A binary carrying this patch has since been built
  and measured — see the six-patch session in
  [`../real-workspace/README.md`](../real-workspace/README.md) — but its results
  are not reflected below, and that session cannot separate this defect's
  contribution from defect 6's. So every cost figure here still comes from a
  stock traced binary with a **configuration stand-in**
  for the fix — a root `package.json` with no `workspaces` field — which
  reproduces the member set exactly and the traversal not at all. The stand-in's
  fidelity for membership is not assumed: it is checked against the patched
  resolver in [`arena/`](arena/README.md).
- **Where the warning surfaces is unmeasured.** It reaches the language server's
  log stream — measured, on the shipped binary, for the pre-existing detachment
  warning. Whether an editor shows that stream to a user, and whether the new
  warning would be better as an LSP diagnostic attached to the `deno.json`, was
  not tested against any editor.
- **How often the warning fires is unmeasured.** The traced sessions show the npm
  glob expansion running three times per probe, so the warning is on that order
  per session rather than per file; that is a reading of the directory log, not a
  measurement of the patched binary.
- **The synthetic corpus is synthetic.** Ten-line modules and a fabricated
  `node_modules`. The per-member constants — 5.0 ms, 1.32 MB — are properties of
  that corpus and should not be carried to a real repository. What transfers is
  the shape: linear in members, and the glob expansion is a separate, smaller
  term.
- **`documentSymbol` moved by nothing measurable** in any arm, and in this corpus
  it could not: it is dominated by fixed TypeScript startup. Nothing here is a
  claim about request latency.
- **`deno.documentPreloadLimit` no longer does anything.** The workspace file
  walk's limit is hardcoded at 1,000 entries; the setting is read only to decide
  whether to print the warning that tells the user to raise it. That is a
  separate defect, found while establishing the threshold above, and it is not
  investigated here.

## Layout

| path | what it is |
|---|---|
| [`diagnosis/`](diagnosis/README.md) | the source reading, thirteen shapes measured on the shipped binary, and the repository decomposition |
| [`arena/`](arena/README.md) | baseline and patched resolvers over the same trees, the false-negative table, and the one silent case |
| [`cost/`](cost/README.md) | the three-arm sweep, the fitted laws, and what keeping the warning costs |
| [`verify/`](verify/README.md) | the `deno_config` example that prints a member set, and the script that builds both resolvers |
| `apply-authoritative.py` | the patch, applied to a deno v2.9.5 checkout |
| `build.py`, `cases.py`, `members.py` | the workspace generator, the thirteen shapes, and the `deno task --recursive` membership oracle |

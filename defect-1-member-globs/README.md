# Defect 1 — workspace member-glob expansion

`deno lsp` expands the glob members of a root `package.json`'s `workspaces`
field by walking every directory below each glob's literal prefix, looking for
`package.json` files. It descends a matched member **in full**, and it honours
**no user configuration at all** — not `deno.json` `exclude`, not tsconfig
`exclude`, not `.gitignore`.

On the traced real workspace this is `refresh_config_tree`: **33,194 of 42,666
opens, 77.8%**, spread over two invocations. It is the traversal a user cannot
mitigate.

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

Established by capturing a call stack at every `opendir` and symbolising it
against the binary's debug information — [`diagnosis/`](diagnosis/README.md), and
reproducible on a bundled sample.

## What decides whether a tree is walked: its position, and nothing else

`"workspaces": ["packages/*"]` bounds the search to `packages/`, so a vendor tree
outside that prefix is never reached. Every directory the glob *does* match is
then descended in full. The same tree, moved:

| `.venv` location | `opendir` into `.venv` |
|---|---|
| `packages/alpha/.venv` | 2,587 |
| `.venv` | 1 |

Three orders of magnitude, identical tree, identical configuration. That is why
the workspace that prompted this is affected: its members are
`["apps/*", "infra/*", "libs/*", "domain/*", "dev/*", "ml-serving/*"]` and its
virtualenvs sit at `ml-serving/<member>/.venv` (two of them) and
`libs/<member>/.venv` — inside a
matched member in every case.

## Two things a reader will assume, which are false

**TypeScript `include` and `exclude` do not participate.** They belong to defect
2's subsystem — `collect_specifiers`, under `refresh_compiler_options_resolver` —
which opened no `.venv` at all in the traced run. Every `exclude` spelling in the
[46-case matrix](../defect-2-root-set/matrix/README.md) moves this cost by
nothing, and it cannot: those workspaces have no root `package.json`, so this
expansion never runs in any of them.

**`walk_workspace` is not responsible.** It is capped at 1,000 entries
(`cli/lsp/language_server.rs:1065`) and made 91 of 42,666 opens.

## The fix: M5, bound the descent by the member glob

At `libs/config/glob/collector.rs:177`,
`is_pattern_matched(path, PathKind::Directory)` should test whether any include
pattern can still match **below** the directory, not whether the directory is
within the pattern's literal prefix. For `packages/*/package.json` at
`packages/alpha`, the only remaining segment is `package.json`, so no
subdirectory can match and the walk stops.

| | measured on the `reported` preset, per config load |
|---|---|
| deno today | 29,045 opens |
| M5 | **54** — the `packages` directory and each of its 53 members |
| gain | 99.9% of the available gain, for one function changed and no new inputs |

**It cannot produce a false negative.** A directory it prunes could not have
contained a member, because the bound is derived from the pattern that defines
what a member is. That is a property, not an empirical result; the nine
adversarial workspaces in [`arena/`](arena/README.md) are a check on the
implementation, not the argument.

**It changes the growth term.** Today's expansion is Θ(mass inside matched
members): the least-squares fit is 2.000 opens per directory added inside a
member, charged over two config loads. M5's fit is 0.000. With member count held
fixed, M5 is 108 charged opens at every mass measured while deno goes 7,210 →
210,730; scaling the whole repository instead, M5 is 426 against deno's 919,234,
because the floor is the member count and the member count is what grew.

Two things go with it and neither is a performance fix:

- **E2 — honour the workspace root `deno.json` `exclude`, with bare entries
  matched at any depth below the config that declares them.** Worth 0% once M5 is
  in on every realistic member glob. Worth adopting because it is the only safe
  lever for a glob M5 cannot bound (`**/pkg-*`: 1,210 opens → 8, no members
  missed), and because `exclude` currently parses, validates and does nothing.
- **M4 — memoise the expansion across `ConfigData::load` calls** (`config.rs:2013`),
  the last factor of two: 108 opens down to 54. Its size is a bound rather than a
  measurement — the traced second expansion is smaller than the first (8,192
  against 12,009 on the sample), so on measured evidence it is worth about 40%,
  not 50%, and only where a second load happens at all.

## The patch

`apply-m5.py` applies it to a deno checkout:

```
python3 apply-m5.py /path/to/deno    # a v2.9.5 checkout
```

Five anchor-exact edits: `can_match_under_dir` on `GlobPattern`,
`PathOrPattern`, `PathOrPatternSet` and `FilePatterns` in
`libs/config/glob/mod.rs`, and one at `collector.rs:177` folding it into
`should_ignore_dir` beside `is_ignored_dir`. It exits non-zero if any anchor is
not found exactly once rather than patching something else.

Nothing in this directory runs it, and no measurement here comes from a binary
built with it. It is the recommendation written down as code.

## Why not gitignore-by-default here

`.use_gitignore()` on the member collector is the cheapest implementation in the
study — one line at `discovery.rs:797` switching on machinery that already exists
— and it is 99.0% on `reported`. It is rejected because it **misses workspace
members**: in two of nine adversarial workspaces, and in one of them it misses
every member in the repository, which then ceases to exist.

`GitIgnoreTree` has a defence for exactly this — an override for explicitly
specified include **paths**, `GitIgnoreTree::new(sys, include_paths)` — and the
source says it deliberately does not extend to globs ("this does not apply to
globs because that is way too complicated to reason about"). Member expansion
reaches this walk **because** the members are globs; a literal member is never
expanded at all. The override can never fire on this path.

`.gitignore` says "do not commit this". It does not say "this is not a workspace
member", and at this call site those are not the same claim. The identical
mechanism at [defect 2](../defect-2-root-set/README.md) is safe, because there
the walk chooses seeds and a tsconfig's `include` is where users write literal
paths.

## Against the recommendation

**One member-glob shape defeats M5 entirely.** `packages/*` → 54 opens;
`apps/*/packages/*` → 7; `**/pkg-*` → **1,210, no gain at all**. A leading `**`
keeps every pattern alive at every depth and the bound has nothing to bite on.
That is precisely why E2 is in the recommendation.

**"Cannot miss a member" is a claim about the pattern language, not about
`deno_config`.** It holds if directory-level matching can be implemented as a
prefix-alive test over the same glob the file-level match uses. If
`PathOrPattern` cannot express that for some form — negations (`!member`) are the
obvious candidate, and the model rejects them loudly rather than supporting them
— the bound needs a conservative fallback, and a conservative fallback
reintroduces the walk.

**M5 is chosen against a model, and the model's coverage of this traversal is
thin.** The simulator is asserted trace-identical to the arena's base, and it is
calibrated against two real measurements: the sample (12,009 modelled opens
against 12,009 measured) and the positional control (exact in both arms). The 46
configuration cases that make the *other* simulator's calibration broad cannot
exercise this traversal at all. What is not model-dependent is the direction: the
walk provably visits directories no member can occupy.

**The floor is members + 1, and it is a property of the repository.** A workspace
with thousands of members has a proportionally higher floor and a smaller gain.
Every ratio here is against a 53-member workspace.

**The repository-side mitigation is real and it is not a patch.** Declaring
members as explicit paths instead of a glob costs **0** opens on a released deno
today. It is also a real loss of function: glob members exist so that adding a
package does not mean editing the root config.

## Layout

| path | what it is |
|---|---|
| [`diagnosis/`](diagnosis/README.md) | the stack capture, a runnable sample repository, and the positional control |
| [`arena/`](arena/README.md) | seven candidate mechanisms, four presets, three conditions, nine adversarial workspaces, and the scaling law |
| `apply-m5.py` | the patch, applied to a deno v2.9.5 checkout |

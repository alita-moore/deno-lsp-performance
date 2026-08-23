# What each candidate loses

This is the part of the study that decides the recommendation. Five candidates,
thirteen adversarial workspaces, and for the recommended one, **deno's own
resolver built twice** — clean `v2.9.5` and `v2.9.5` with the patch — run over
the same trees from every directory in them. Not a model, not a configuration
stand-in: the two binaries described in [`../verify/`](../verify/README.md).

## The candidates

| | rule | how it was measured |
|---|---|---|
| **U** | today: membership is the union of both lists | the baseline binary |
| **A** | when `deno.json` declares a `workspace`, skip the `package.json` block | configuration stand-in, plus `fmt-config.sh` |
| **A!** | **A, and name every directory the skip dropped** | the patched binary |
| **X** | keep the `package.json` block but filter it to directories the `deno.json` declaration also covers | derived from the two measured member sets |
| **O** | a new opt-in field; union unless the user asks for exclusivity | **not implemented, not measured** |

## The thirteen workspaces, and what A! loses

Each is built in the shape a user actually has — both fields present, as written
— and resolved from the root and from inside every member.

| case | today | A! | dropped | diagnosed? |
|---|---|---|---|---|
| W1 npm-only member | p00 p01 p02 | p00 | p01 p02 | named |
| W2 drift | p00 p01 p02 | p00 p01 | p02 | named |
| W3 empty `workspace` array | p00 p01 | *(none)* | **p00 p01 — every member** | named |
| W4 nested workspace | p00 p01 | p00 | p01 | named |
| W5 member outside every npm glob | e0 p00 | e0 | p00 | named |
| W6 npm literal member | p00 p02 | p00 | p02 | named |
| W7 deno-only dir inside an npm glob | p00 | p00 | — | — |
| W7b deno-only dir named literally by npm | **error** | p00 | — | **repairs a hard failure** |
| W8 no `workspace` field | p00 p01 | p00 p01 | — | patch does not fire |
| W9 npm negation | p00 p01 p02 | p00 p02 | p01 | named |
| W10 `workspace` is itself a glob | p00 p01 q00 | p00 p01 | q00 | named |
| W11 declared member has only a `package.json` | p00 p02 | p00 p02 | — | — |
| W12 declared glob covers a `package.json`-only dir | p00 p02 | p00 p02 | — | — |

**Silent losses: 0, over 13 workspaces and 41 start directories.** Every dropped
directory is named, and it is named twice by two different mechanisms:

- the patch emits one warning per resolution listing every directory it dropped,
  by URL, with the instruction to add it to the `workspace` field;
- when discovery *starts* inside a dropped directory — which is what the language
  server does for every scope, and what every CLI command does when run from
  inside a package — deno's pre-existing fallback discards the parent workspace
  and warns *"config file … is not a member of the workspace at … Ignoring the
  parent workspace config"*. That machinery already exists and is already gated
  on the root `deno.json` having a `workspace` field, so the patch turns it on
  for exactly the directories it drops.

The functional consequence of a drop was measured separately on the shipped
binary: a member importing a dropped member by package name fails with
`TS2307 Import "…" not a dependency and not in import map`. Loud, at the import
site, with a hint.

Three rows deserve their own reading.

**W3 is the sharpest.** `"workspace": []` takes the workspace from two members
to none. That is the same shape that disqualified the gitignore mechanism at
[defect 1](../../defect-1-member-globs/README.md) — 2 of 2 members lost. The
difference, and the only difference that matters, is that there the loss was
silent and here every lost member is printed by name. It is still a semantic
trap and it is stated in the recommendation.

**W7b is a repair, not a regression.** Today a directory named literally by
`package.json` that carries a `deno.json` and no `package.json` makes the entire
workspace fail to resolve. Under A! it resolves.

**W8 is the boundary.** The patch fires only when the root `deno.json` actually
declares a `workspace`. A repository with npm workspaces and no deno declaration
— by far the most common shape — is untouched, and the arena measures it as
byte-identical.

## Where A is silent and A! is not

A is A! without the warning, and the difference is measurable. `fmt-config.sh`
builds a workspace whose `packages/p01` sets `"fmt": { "lineWidth": 20 }` and is
matched by the npm glob but not named by `deno.json`, then runs
`deno fmt --check` from the root.

| | `packages/p01/mod.ts` reported unformatted | warnings printed |
|---|---|---|
| today | yes — p01's own `fmt` config applies | 0 |
| A | **no** — p01's config is not consulted | **0** |

The file's formatting silently changes meaning, from the root, with nothing said.
Starting from inside `p01` the detachment warning fires and the config is
honoured, so the silence is specific to whole-workspace commands run at the root
— which is what a formatting check in CI is.

That single measurement is why the recommendation is A! and not A. **A has a
silent loss and is disqualified on it.** The warning is not decoration; it is
what converts the one measured silent case into a diagnosed one.

## Why not the intersection

X keeps the `package.json` block and filters it. Derived from the same two member
sets, per workspace:

| case | A! | X | X's extra loss |
|---|---|---|---|
| W5 member outside every npm glob | e0 | *(none)* | **e0 — a member the user explicitly declared** |
| W9 npm negation | p00 p02 | p00 | **p02 — a member the user explicitly declared** |
| W7b deno-only dir named literally by npm | p00 | **error** | keeps the hard failure |
| all others | — | — | none |

X loses everything A! loses, **plus members the user named by hand**, and it
keeps W7b's failure. It is strictly dominated. (X is scored as not firing where
`deno.json` has no `workspace` field at all, the same rule the patch uses.)

## Why not the opt-in field

O — leave the union alone, add something like `"workspace": { "members": [...],
"npmWorkspaces": false }` — cannot lose anything, because nothing changes until
someone asks. It is also the only candidate that does nothing for a repository
whose author has not heard of it, which is every repository today, including the
one that prompted this. It is the safe answer and it is worth stating as the
fallback if the semantic change below is unacceptable. **It was not implemented
and nothing here measures it.**

## The cost of the union is real and A! is not free of it

A! keeps the npm glob expansion in order to know what to name. That is
2N + 2 directory opens it does not need for its own answer — measured, and
measured to cost nothing detectable in time or memory, in
[`../cost/`](../cost/README.md#what-keeping-the-warning-costs).

## Running it

```
../verify/build.sh
export MEMBERS_BASELINE=... MEMBERS_PATCHED=...
python3 run.py                       # the member-set diff, every start directory
DENO_BIN=/path/to/deno ./fmt-config.sh    # the silent case A leaves behind
```

`results.json` is the run the tables above are read from.

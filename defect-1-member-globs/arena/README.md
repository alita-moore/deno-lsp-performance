# Choosing the mechanism

```
node run.mjs                                  # four presets, three conditions, nine adversarial workspaces
node run.mjs --seed 2 --repeats 15 --warmup 5
node scale.mjs                                # how each mechanism scales
```

Not a benchmark, and not a proposal to replace deno's algorithm. This exists to
**choose which fix to write** for one measured defect, in simulation, across
scales and workspace shapes a real measurement cannot cheaply reach.
[`../diagnosis`](../diagnosis/README.md) established the causation on the real
binary; this decides the mechanism.

The traversal is `T0` in [`../../simulators/deno.mjs`](../../simulators/README.md),
calibrated against the diagnosis: 12,009 modelled opens against 12,009 measured
on the sample, and exact in both arms of the positional control. **T0 opens no
directory in any of the 46 configuration-matrix cases**, so the 46/46 agreement
those cases produce says nothing about this traversal. The sample and the
positional control are its only evidence.

## Controls

**Fidelity.** The local model runs with every mechanism disabled and is asserted
**trace-identical, file-identical and member-identical** to `denoResolve` from
`../../simulators/deno.mjs`, on every preset in every condition. The run aborts
otherwise.

**Index.** No candidate may change the set of files deno ends up indexing.
Asserted on every run: a member-expansion change that moved the index would not
be this change.

**Member set.** The base model's discovered member set is asserted equal to the
member list the generator wrote, and empty where no glob members are declared.

**Seed stability.** T0 opens, remaining opens, distinct directories, discovered
members and missed members are identical at seeds 1, 2 and 3 for every candidate,
preset and condition.

**Two loads, as an upper bound.** The traced run performs two
`refresh_config_tree` invocations, so T0 is also reported charged twice
(`T0_ub`). That is a bound, not a law: the traced second expansion is smaller
than the first — 8,192 against 12,009 on the sample, 1 against 1,601 on the
positional control — so on measured evidence M4 is worth 8,192/20,201 = 40.6%,
not 50%. Every other candidate's gain is a ratio between two figures charged the
same way and is unaffected.

**T1 is carried for context and nothing is banked on it.** The simulator's T1
over-counts trees outside the glob prefix — 1,601 modelled opens where real deno
makes 1 — because `walk_workspace`'s 1,000-entry cap is unmodelled. Every
conclusion here is a T0 conclusion; `proj_T0` is the column to read.

**Projections, not timings.** Wall-clock figures are opens × 1.544 ms, the
per-`opendir` cost measured on a Docker Desktop bind mount. The `us_median`
column runs on `memFS` and measures pattern matching rather than I/O; it runs
*against* the pruning mechanisms, which do more work per entry, and is reported
for that reason rather than as evidence.

**The presets** come from `../../lib/realistic.mjs` unmodified: a root
`package.json` with `workspaces: ["packages/*"]` and vendor trees **inside**
matched members. `small` carries zero in-member vendor mass and is the negative
control.

## The candidates

| | mechanism | call site | new input |
|---|---|---|---|
| **M1** | extend `is_ignored_dir` with what `walk_workspace` already skips: `vendor`, `coverage`, cargo `target` | `collector.rs:195` | none |
| **M2** | add `.use_gitignore()` to the member collector's builder chain | `discovery.rs:797` | none — the builder method exists at `collector.rs:66` and `GitIgnoreTree` is already wired into the walk |
| **M3** | bound descent by the glob's literal prefix | `collector.rs:177` | none |
| **M5** | bound descent by whether the glob can still match anything below | `collector.rs:177` | none |
| **M4** | memoise the expansion across `ConfigData::load` calls | `config.rs:2013` | none |
| **E1** | honour the root `deno.json` `exclude`, today's literal-path semantics | `discovery.rs:792` | none |
| **E2** | honour it with bare entries matched at any depth | `discovery.rs:792` | none |

M3 and M5 are the same idea at two strengths, measured separately because
assuming they were equivalent would have hidden the result.

## Condition A — nothing in any configuration mentions the vendor trees

`T0` is opens per load, `T0_ub` the doubly-charged figure. `gain_T0` is
`(deno − candidate) / (deno − floor)` over the doubly-charged figures, where the
floor is the best any candidate reaches — 54 opens on `reported`. It is a share
of the **available** gain, not of the whole cost, which is why `M5+M4` is 100.0%.
The arena for defect 2 measures its `gain` against zero instead; the columns are
not interchangeable.

```
  preset    candidate       T0   T0_ub  members  missed  gain_T0   proj_T0
  small     deno            21      42        5       0     0.0%      0.1s
  small     M5               6      12        5       0    83.3%      0.0s
  small     M5+M4            6       6        5       0   100.0%      0.0s
  medium    deno          2541    5082       20       0     0.0%      7.8s
  medium    M1            2541    5082       20       0     0.0%      7.8s
  medium    M2             101     202       20       0    96.4%      0.3s
  medium    M3            2541    5082       20       0     0.0%      7.8s
  medium    M5              21      42       20       0    99.6%      0.1s
  medium    M4            2541    2541       20       0    50.2%      3.9s
  medium    M5+M4           21      21       20       0   100.0%      0.0s
  large     deno         14821   29642       60       0     0.0%     45.8s
  large     M2             361     722       60       0    97.8%      1.1s
  large     M5              61     122       60       0    99.8%      0.2s
  large     M5+M4           61      61       60       0   100.0%      0.1s
  reported  deno         29045   58090       53       0     0.0%     89.7s
  reported  M1           29045   58090       53       0     0.0%     89.7s
  reported  M2             319     638       53       0    99.0%      1.0s
  reported  M3           29045   58090       53       0     0.0%     89.7s
  reported  M5              54     108       53       0    99.9%      0.2s
  reported  M4           29045   29045       53       0    50.0%     44.8s
  reported  M5+M4           54      54       53       0   100.0%      0.1s
  reported  E1           29045   58090       53       0     0.0%     89.7s
  reported  E2           29045   58090       53       0     0.0%     89.7s
```

**M1 is worth exactly nothing — 0.0% on every preset.** Giving the member
collector the name list `walk_workspace` already has prunes `vendor`, `coverage`
and `target`; the mass is `.venv`, `.cache` and every source directory of every
member. This is the candidate that looks most obviously right and measures flat.

**M3 is worth exactly nothing either, because deno already does it.** The walk
begins at the glob's literal prefix, which is why the positional control shows a
root-level `.venv` costing 1 open. Proposing the literal-prefix bound is
proposing the current behaviour.

**M5 reaches the floor.** 54 opens on `reported`: the `packages` directory and
each of its 53 members. It does not descend into `packages/pkg0/src`, because
after two segments the only remaining pattern segment is `package.json` and no
directory can match it.

**M4 is at most 50%** and orthogonal to everything: it removes the second of two
expansions. `M5+M4` is the only combination reaching 54 opens against 58,090.

**`small` is the negative control and it still moves.** With zero in-member
vendor mass deno still opens 21 directories per load against a floor of 6,
because it walks every member's `src/` and `__test__/` trees. The defect is not
"vendor trees are big"; it is that a matched member is descended in full.

E1 and E2 are 0.0% here because condition A's configuration says nothing to
honour. Condition X exercises them.

## The deciding criterion — false negatives

A mechanism that prunes aggressively is fast and wrong if it stops finding
legitimate workspace members. Nine adversarial workspaces, each built to separate
the mechanisms; `missed` counts real members the expansion no longer discovers.

```
  case                       real     deno    M1      M2      M5      M5+E2
                          members   opens  opens  opens   opens      opens
  vendor-members                3      608    608      7       4          4
  coverage-members              2      606    606      5       3          3
  vendor-named-member           3      608    604      7       4          4
  ignored-member                3      608    608      5       4          4
  dist-members                  2      606    606      1       3          3
  excluded-member               2      606    606      5       3          2
  no-literal-prefix             2     1210   1210      8    1210          8
  nested-glob                   2      610    610      9       7          7
  member-under-node-modules     1        3      3      3       2          2

  case                       deno    M1     M2     M5   M5+E2      what happened
  vendor-named-member           0     2      0      0       0      M1 prunes the members `vendor` and `coverage`
  ignored-member                0     0      1      0       0      M2 prunes a member inside an ignored directory
  dist-members                  0     0      2      0       0      M2 prunes every member; the workspace disappears
  excluded-member               0     0      0      0       1      E2 prunes the member the user excluded by name
  all other cases               0     0      0      0       0
                             (missed members)
```

**M1 misses 2 of 3 members** in `vendor-named-member`: a package legitimately
named `vendor` or `coverage` stops being a workspace member. M1 is worth 0.0% and
is unsafe. It fails on either ground alone.

**M2 misses members in two cases of nine**, and in `dist-members` it misses *all*
of them — a workspace whose packages are generated into an ignored directory
ceases to exist. `GitIgnoreTree`'s include-path override cannot save these,
because it deliberately does not extend to globs and member expansion reaches
this walk only through globs. `ignored-member` and `dist-members` are the two
cases it would have needed to cover.

**M5 misses nothing in any case, and cannot.** It prunes only where the member
glob provably cannot match, so a pruned directory could not have contained a
member. The nine cases are a check on the implementation, not the argument.

**E2 misses one member, where the user excluded the directory containing it.**
That is a different kind of miss: the user's own instruction, in the user's own
configuration file, meaning what `exclude` means everywhere else in deno.

**`member-under-node-modules` is a control on the base.** Declaring
`workspaces: ["node_modules/@scope/*"]` still finds the member, because the walk
starts at the literal prefix and the start directory is exempt from
`is_ignored_dir`. Deno is less broken here than one would guess, and every
candidate preserves it.

## Ranking

Points: 1 per function whose body changes; 0 for input already available at the
call site, 2 for a file the process does not read today; 0/1/2 for user-visible
behaviour change.

```
  id  mechanism                                                    fn  in  vis  total
  M1  extend is_ignored_dir with walk_workspace's names             1   0    2      3
  M2  add .use_gitignore() to the member collector                  1   0    2      3
  M3  bound descent by the glob's literal prefix                    1   0    0      1
  M5  bound descent by whether the glob can still match below       1   0    0      1
  E1  honour the root deno.json exclude, today's semantics          1   0    1      2
  E2  honour it with bare entries matched at any depth              1   0    2      3
  M4  memoise the expansion across ConfigData::load calls           1   0    0      1

  condition A, reported preset
  rank  candidate     invasive  gain_T0  gain/point  safe
  1     M5                   1    99.9%        99.9   yes
  2     M4                   1    50.0%        50.0   yes
  3     M5+M4                2   100.0%        50.0   yes
  4     M3+M5                2    99.9%        50.0   yes
  5     M5+E1                3    99.9%        33.3   yes
  6     M2                   3    99.0%        33.0    no
  7     M5+E2                4    99.9%        25.0    no
  8     M5+M2                4    99.9%        25.0    no
  9     M1+M2                6    99.0%        16.5    no
  10    M1+M2+M5+M4          8   100.0%        12.5    no
  11    M1                   3     0.0%         0.0    no
  12    M3                   1     0.0%         0.0   yes
  13    E1                   2     0.0%         0.0   yes
  14    E2                   3     0.0%         0.0    no
```

M2 is charged 0 for input, not 2: `use_gitignore()` is an existing builder method
and `GitIgnoreTree` is already threaded through the walk, so it is one line
enabling machinery that is present and switched off. That is the cheapest
*implementation* in the study, and it is why M2 ranks sixth rather than last
despite its false negatives.

`safe` is strict: no member missed in **any** of the nine cases. It marks E2
unsafe on the strength of `excluded-member`, which is a different failure from
M1's and M2's; the column deliberately does not distinguish them and the section
above does. Read it as "cannot surprise anyone", not as "correct".

## What the expansion should honour

Today: nothing. Not `deno.json` `exclude`, not tsconfig `exclude`, not
`.gitignore`. Condition X is the user having written
`exclude: [".venv", ".cache"]` in the root `deno.json` with the trees inside
members.

```
  condition X, reported     T0x2   gain_T0
  deno                     58090      0.0%
  E1  today's semantics    58090      0.0%
  E2  bare name, any depth   638     99.0%
  M5                         108     99.9%
  M5+E2                      108     99.9%

  no-literal-prefix case, workspaces ["**/pkg-*"], root exclude [".venv"]
  deno                      1210    2 members found, 0 missed
  M5                        1210    2 members found, 0 missed
  E1                         609    2 members found, 0 missed
  E2                           8    2 members found, 0 missed
  M5+E2                        8    2 members found, 0 missed
```

**"Nothing" is enough on every realistic member glob and not enough on one.**
Once M5 is in, honouring `exclude` adds nothing on the presets — 108 opens either
way. When the member glob has an unbounded head (`**/pkg-*`), M5 can prune
nothing at all, and user configuration is the only safe lever left: 1,210 opens
down to 8, no members missed.

**If `exclude` is honoured here it must be honoured with bare entries matched at
any depth.** E1, today's semantics, is worth 0.0% in condition X: a wildcard-free
entry is a literal path resolved against its own config's directory, so `.venv`
written at the root means `<root>/.venv` and matches nothing deeper. The user
wrote the thing, deno parsed it, and it did nothing. (`**` absorbs zero segments
as well as one, so `**/.venv` already works; it is the bare spelling that
surprises.)

**The VCS ignore set: no.** It removes members the user never asked to remove.

Precedence, then:

```
1. the glob bound             (M5)  free, cannot miss, needs no configuration
2. the root deno.json exclude (E2)  only what the user wrote, by name at any depth
3. the hardcoded collector list     node_modules, .git, vendor folder - unchanged
   the VCS ignore set               not consulted
```

## Scale

`scale.mjs`. In-member vendor mass alone, member count and source tree held
fixed:

```
  venv/member   dirs   in-member    deno      M1     M2      M4     M5   M5+M4
  0            10932        4611    7210    7210    638    3605    108      54
  30           17292       10971   19930   19930    638    9965    108      54
  120          36372       30051   58090   58090    638   29045    108      54
  480         112692      106371  210730  210730    638  105365    108      54
  projected at 480                325.4s  325.4s   1.0s  162.7s   0.2s    0.1s
```

The whole repository scaled together:

```
  at        dirs   in-member  members     deno       M2       M4     M5   M5+M4
  0.25x     3687        2106       13     3720      158     1860     28      14
  1x       36372       30051       53    58090      638    29045    108      54
  4x      488919      463644      212   919234     2546   459617    426     213
  projected at 4x                      1419.3s     3.9s   709.6s   0.7s    0.3s
```

The least-squares fits the run prints:

```
  opens = m * (in-member untracked directories) + b
  deno    m = 2.000    every directory below a matched member, once per config load
  M1      m = 2.000    unchanged: the names it prunes are not the mass
  M4      m = 1.000    one load instead of two, same walk (under the upper-bound charge)
  M2      m = 0.000    638, constant
  M5      m = 0.000    108, constant
  M5+M4   m = 0.000     54  = members + 1, exactly
```

**Today's expansion is Θ(mass inside matched members). A pattern-bounded one is
Θ(members) and independent of that mass.** M4 halves a growing quantity and
remains a growing quantity; only a bound changes the exponent. At 4× the
`reported` repository the projection is 1,419 seconds against 0.3, and the ratio
keeps widening because one side is constant.

## What it decided

M5, with E2 as semantics and M4 as an optional last factor of two. The argument,
and the case against it, is in [`../README.md`](../README.md). Two further
cautions belong to the arena itself:

**The adversarial cases are constructed, not observed.** `dist-members` and
`ignored-member` are workspaces someone could have, not workspaces someone was
measured to have. They carry the argument against M2, so that argument is about
risk rather than frequency. Someone who believes ignored directories never
contain members would read the same table and adopt M2 for its 99.0%.

**M2 and E2 are the same mechanism pointed at different inputs**, and the
recommendation prefers one and rejects the other on a judgement: that a user's
`exclude` is consent and a `.gitignore` entry is not. That judgement is arguable,
it is not measured, and it is the load-bearing opinion here.

**M4 introduces an invalidation surface the other mechanisms do not have.** A
memoised member set must be recomputed when a directory that could match appears.
This arena models memoisation within one request and does not test invalidation
at all.

**The `us_median` column points away from the recommendation.** A pattern-alive
test costs more per directory entry than no test, and under `memFS` that is the
only cost being measured. M5 wins by visiting 54 directories instead of 29,045;
on a filesystem where an open is free it would be a small regression. The
measured 1.544 ms per open on a bind mount is the entire reason it matters.

## Files

| path | role |
|---|---|
| `ablation.mjs` | the local model; trace-identical to `../../simulators/deno.mjs` with mechanisms off |
| `discovery.mjs` | the candidates, their call sites, their invasiveness, and the `.gitignore` matcher |
| `repo.mjs` | the conditions and the nine adversarial workspaces |
| `run.mjs` | the run, the controls and the tables |
| `scale.mjs` | the scaling law, over the generator's own spec objects |

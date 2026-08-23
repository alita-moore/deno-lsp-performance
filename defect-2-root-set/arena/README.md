# Choosing the mechanism

```
node run.mjs
node run.mjs --seed 2 --repeats 15 --warmup 5
```

Not a benchmark, and not a proposal to replace deno's algorithm. This exists to
**choose which fix to write**, in simulation, across scales and workspace shapes
a real measurement cannot cheaply reach. [`../diagnosis`](../diagnosis/README.md)
established the causation and the cost on the real binary; this decides the
mechanism. Raw output: `evidence/arena.txt`.

The traversal is `T2` (the root tsconfig) and `T3` (each member's) in
[`../../simulators/deno.mjs`](../../simulators/README.md). Both are the same call
site; the model separates them by which config drives them. **This is the
traversal the 46-case matrix calibrates** — 46/46 exact on total opens and
opens-into-tree, in a regime that structurally excludes defect 1's traversal. The
calibration that is thin for defect 1 is the strong one here. T0 and T1 belong to
other subsystems and are reported separately so nothing is smuggled between them.

## Controls

**Fidelity.** The local model runs with every mechanism disabled and is asserted
**trace-identical, file-identical and member-identical** to `denoResolve` from
`../../simulators/deno.mjs`, on every preset in every condition. The run aborts
otherwise.

**Ignore-matcher.** This arena needs a `.gitignore` matcher evaluable *relative
to an overriding include path*, which the sibling arena's does not expose.
`vcs.mjs` is asserted to agree with
`../../defect-1-member-globs/arena/discovery.mjs`'s `vcsIgnoreMatcher` on every
path in every preset, so the added generality cannot have changed the base
behaviour.

**Seed stability.** `T2+T3`, files dropped and files lost are identical at seeds
1, 2 and 3 for every candidate and preset.

**Recovery is modelled, and separately measured.** `recovery.mjs` follows
relative specifiers from the surviving root set, with the `.js` → `.ts` rewrite
and `index` lookup. Whether deno's real graph behaves that way is not assumed:
[`../graph/`](../graph/README.md) tests it on the binary and reports the same
outcome for the same four shapes.

**Projections, not timings.** Wall-clock figures are opens × 1.544 ms, the
per-`opendir` cost measured on a Docker Desktop bind mount, and are labelled
`proj`. Opens are the measurement.

**The presets** come from `../../lib/realistic.mjs` unmodified. `small` carries
no untracked mass except `node_modules` and is the negative control.

## The candidates

| | mechanism | call site | new input |
|---|---|---|---|
| **R1** | honour the version-control ignore set | `cli/util/fs.rs:135` | none — `use_gitignore()` exists at `collector.rs:66` |
| **R2** | pass the scope's real vendor folder instead of `None` | `cli/lsp/compiler_options.rs:102` | none |
| **R3** | bound descent by whether an include pattern can still match below | `libs/config/glob/collector.rs:177` | none |
| **R4** | share one traversal across overlapping `FilePatterns` bases | `cli/lsp/compiler_options.rs:91` | none |
| **X1** | the tsconfig `exclude`, today's literal-path semantics | already implemented | none |
| **X2** | the tsconfig `exclude`, bare entries at any depth below the config | `libs/config/glob/mod.rs` | none |

R3 is defect 1's M5 pointed at this call site. R4 is its M4 generalised: the cache
is keyed on exact `FilePatterns` equality today, and every member's base lies
under the root tsconfig's base.

R1's model follows `collector.rs:100-124` exactly, including the override:
`GitIgnoreTree::new(sys, include_paths)` takes only the `PathOrPattern::Path`
entries of the include set, so a wildcard-free `include` entry re-admits its
subtree and a glob does not. All four behaviours are measured on the real binary
in `../diagnosis/evidence/gitignore-semantics.txt` and the model reproduces them.

## The conditions

| | what the user's configuration says |
|---|---|
| **A** | as generated — root tsconfig carries `references` only, members exclude `node_modules` and `dist` |
| **N** | no `exclude` anywhere; the shape `../diagnosis/sample` uses |
| **X** | the user wrote `exclude: [".venv", ".cache", "dist"]` in the root tsconfig, as bare names |
| **I** | the user narrowed `include` to `["packages/*/src"]` in the root tsconfig |
| **F** | the repository-side mitigation: `"files": []` in the root tsconfig |

## Condition N — nothing in any tsconfig mentions the untracked trees

```
  preset    candidate        T2    T3   T2+T3    gain   roots  dropped    proj
  small     deno             22    10      32    0.0%      70        0    0.0s
  small     R1               22    10      32    0.0%      70        0    0.0s
  small     R4               22     0      22   31.3%      70        0    0.0s
  medium    deno           2542    60    2602    0.0%    1840        0    4.0s
  medium    R1              102    60     162   93.8%     540     1300    0.3s
  medium    R1+R4           102     0     102   96.1%     540     1300    0.2s
  large     deno          14822   240   15062    0.0%    6120        0   23.3s
  large     R1              362   240     602   96.0%    2520     3600    0.9s
  reported  deno          29046   212   29258    0.0%    9911        0   45.2s
  reported  R1              320   212     532   98.2%    2491     7420    0.8s
  reported  R2            29046   212   29258    0.0%    9911        0   45.2s
  reported  R3            29046   212   29258    0.0%    9911        0   45.2s
  reported  R4            29046     0   29046    0.7%    9911        0   44.8s
  reported  X1            29046   212   29258    0.0%    9911        0   45.2s
  reported  X2            29046   212   29258    0.0%    9911        0   45.2s
  reported  R1+R4           320     0     320   98.9%    2491     7420    0.5s
```

**R1 is 98.2% and nothing else clears 1%.**

**R2 is worth exactly nothing on every preset.** It prunes one exact path; the
mass is `.venv`, `.cache` and `dist`. This is the candidate that looks most
obviously right and measures flat — the same result M1 got at the other site, for
the same reason: a name list is not where the mass is.

**R3 is worth exactly nothing here**, because with no `include` the pattern *is*
the base and stays alive at every depth. The bound that carried defect 1 has
nothing to bite on in the default configuration. Condition I is where it works.

**R4 is 0.7% and removes T3 entirely.** Every member's tsconfig base is under the
root tsconfig's base, so the second traversal is re-reading directories the first
already read. On `small` that is 31.3%, because `small` has no untracked mass at
all and T3 is a third of a small total.

**`small` is the negative control and R1 is flat on it.** Its only untracked tree
is `node_modules`, which the collector already prunes. The defect is not "deno
walks", it is "deno walks untracked mass that is not called `node_modules`".

**Condition A is identical to condition N at `reported`** — 29,258 → 532 for R1.
The members' `exclude: ["node_modules", "dist"]` is already scoped to a walk that
starts at `src` and never approaches the untracked trees, which is the matrix's
D01–D05 result reproduced as a null.

## Condition X — the user wrote it down

```
  preset    candidate        T2    T3   T2+T3    gain   roots  dropped
  medium    deno           2542    60    2602    0.0%    1840        0
  medium    X1             2542    60    2602    0.0%    1840        0
  medium    X2              102    60     162   93.8%     540     1300
  medium    R1              102    60     162   93.8%     540     1300
```

**X1 — today's semantics — is worth 0.0% with the exclusion written down in the
user's own file.** `.venv` at the root resolves to `<root>/.venv`, which is not
where the trees are.

**X2 reaches exactly R1's figure**, because the three names the user wrote are
the three names `.gitignore` already carried. That coincidence is the point: the
user is retyping, in a config file, information version control already holds.

## Condition I — the user narrowed `include`

```
  preset    candidate        T2    T3   T2+T3    gain   roots
  reported  deno          29045   212   29257    0.0%    2438
  reported  R1              319   212     531   98.2%    2438
  reported  R3               54   212     266   99.1%    2438
  reported  X2            29045   212   29257    0.0%    2438
```

`include: ["packages/*/src"]` selects exactly the source directories, and deno
still walks every virtualenv beside them — 29,045 opens, one *less* than with no
`include` at all. Measured on the real binary too: 3,005 against 3,006.

**R3 takes T2 to 54 opens.** After `packages/pkgN` the only remaining pattern
segment is `src`, so no sibling directory can match and the walk stops. This is
the strongest single number in the arena and it is conditional on the user having
written an `include` glob.

`roots` is 2,438 for **every** candidate including the base: the narrowed
`include` has already excluded the `__test__` trees from the root set. The
condition changes what deno collects; the candidates do not.

## Condition F — the repository-side mitigation

`"files": []` in the root tsconfig takes T2 to **0** for every candidate:
`collect_specifiers` is handed an empty include set and walks nothing. Confirmed
on the real binary — 1,394 opens against `no-root-tsconfig`'s 1,395. A real
lever, available today, and not a patch: it asks every repository with a
solution-style root tsconfig to know that omitting `files` means "walk the entire
workspace".

## False negatives, and the ranking

The false-negative table and what it means are in [`../README.md`](../README.md).
The ranking, condition N, `reported`, `lost` summed over the six adversarial
workspaces; points are 1 per function whose body changes, 0 for input already
available at the call site, 0/1/2 for user-visible behaviour change:

```
  candidate     invasive    gain  gain/point  lost
  R1                   3   98.2%        32.7     1
  R1+R4                4   98.9%        24.7     1
  R1+R3+R4             5   98.9%        19.8     1
  R4                   1    0.7%         0.7     0
  R2                   2    0.0%         0.0     0
  R3                   1    0.0%         0.0     0
  X1                   0    0.0%         0.0     0
  X2                   3    0.0%         0.0     0
```

X1 is charged 0 points because it is already implemented; its 0.0% is the
finding.

## Scale

`reported`, untracked mass inside members varied, everything else fixed:

```
   venv/member     dirs     deno      R2      R3      R4      X2      R1   R1+R4
             0     7699     585     585     585     373     585     532     320
            30    14059    6945    6945    6945    6733    6945     532     320
           120    33139   26025   26025   26025   25813   26025     532     320
           480   109459  102345  102345  102345  102133  102345     532     320

  opens per package of .venv added per member
  deno  m = 212.0     R2  m = 212.0     R3  m = 212.0     R4  m = 212.0
  X2    m = 212.0     R1  m = 0.0       R1+R4  m = 0.0
```

**Today's root-set collection is Θ(untracked mass inside the tsconfig bases). The
version-control bound is Θ(tracked files), constant in that mass.** At 480 the
projection is 158 seconds against 0.5, and the ratio widens without limit because
one side does not move. R4 subtracts a constant from a linear quantity and
remains linear; R2 and R3 do not move it at all in this condition; X2 moves it
only in condition X, where it lands on R1's number.

The real binary shows the same law over the range it was measured at:
928 → 3,006 → 9,008 opens as the trees grow, against 420 → 998 → 1,000.

## Against the arena itself

**T2 and T3 are one call site and the model treats them as two traversals.** That
is faithful to how the walks are driven — one per distinct `FilePatterns` — but it
means R4's "share the traversal" is modelled as a shared directory-read cache
within one `from_inner`, which is the idea's upper bound rather than any specific
implementation. Invalidation is not modelled at all.

**The recovery model is a regex over source text.** It follows relative
`import`/`export … from` specifiers, not dynamic `import()`, `require`,
triple-slash references, bare specifiers or `paths` mappings. A file reached only
by one of those is counted as unrecovered when it would not be — which biases
`lost` **upward**, against the recommendation, which is the direction to prefer.

**The `roots` column counts scripts only.** `is_lsp_root_file` also accepts JSON
and JSONC and the simulator collects script extensions only, so the real root set
is larger than every figure here, and R1 would drop untracked JSON from it too.

**`member-no-include` is constructed, not observed.** It carries the entire case
against R1 and nobody has been measured to have that workspace. Someone who
believes it is common should read the same table and reject R1.

## Files

| path | role |
|---|---|
| `model.mjs` | the local ablation model; identical to `../../simulators/deno.mjs` with mechanisms off |
| `mechanisms.mjs` | the candidates, their call sites and their invasiveness |
| `vcs.mjs` | the `.gitignore` matcher, evaluable relative to an overriding include path |
| `recovery.mjs` | the import closure used to decide whether a dropped seed comes back |
| `repo.mjs` | the five conditions and the six adversarial workspaces |
| `run.mjs` | the run, the controls and the tables |
| `evidence/arena.txt` | captured output |

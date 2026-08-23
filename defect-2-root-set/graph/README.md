# Does deno's module graph recover a dropped seed?

```
node run.mjs
DENO_BIN=/path/to/deno SETTLE_MS=8000 node run.mjs
```

The whole recommendation turns on one property:

> the root-set collection chooses **seeds**, and a file an included file imports
> enters the program through the module graph whether or not it was a seed.

That property is `tsc`'s, verified against real `tsc --listFiles` in
[`../../simulators/`](../../simulators/README.md). Deno resolves modules with its
own resolver, so it cannot be inherited. This establishes it for deno, on the
real binary, by driving `deno lsp` over stdio and reading what it answers.

## Method

Each case is built twice as a real workspace on disk. The arms differ in one
field:

| arm | root `tsconfig.json` |
|---|---|
| `roots-all` | `exclude: []` — the untracked directory is in the root set |
| `roots-pruned` | `exclude: ["**/dist"]` — it is not |

`exclude` is the only lever on a released binary that removes a file from the
root set at this call site. It stands in for any pruning mechanism because they
all reach the file set through the same predicate — `is_pattern_matched` at
`collector.rs:143`, which gates `handle_entry` for the exclude set and the
gitignore set alike. **That equivalence is read from the source, not measured.**

Two probes, chosen so the answer is a fact the language server states rather than
a count:

- **`type`** — the importer does `import { marker } from "…"; export const probe
  = marker;` and the target exports `marker: "recovered"`. A hover on `probe`
  either reports the literal type or it does not, and go-to-definition on
  `marker` either lands in the target file or it does not. Published diagnostics
  are recorded either way.
- **`completion`** — the importer contains a bare identifier prefix `orphanMar`
  and the target exports `orphanMarker`. An auto-import completion is offered
  only if the target is in the program. Deno's completions come from the
  TypeScript language service's module-export enumeration, so this reads the
  program's contents directly.

## Result

```
  case                      probe       roots-all   roots-pruned  recovered
  orphan-in-ignored         completion  absent      absent        yes
  orphan-in-src             completion  offered     offered       yes
  imported-from-ignored     type        typed       typed         yes
  generated-js-imported     type        typed       typed         yes
  include-names-untracked   completion  offered     offered       yes
```

**The property holds.** A file an included file imports is typed and resolvable
with or without its seed, for a `.ts` target and a generated `.js` target alike,
with no diagnostics in either arm.

`orphan-in-src` is the control that makes the first row readable: an unimported
file the **member** tsconfig seeds **is** offered for auto-import; an unimported
file only the **root** tsconfig seeds is **not**, in either arm. The probe works,
and root-set membership from the root tsconfig made no observable difference to
it — worth stating, because that traversal is 1,606 of the reproduction's 2,008
opens. The most expensive half of this walk is also the half whose product was
hardest to observe.

`include-names-untracked` is the case where the user has explicitly asked for the
untracked directory. It survives both arms;
`../diagnosis/evidence/gitignore-semantics.sh` measures the same override against
the version-control bound specifically.

## Limits

- **Four probes in one workspace shape.** One member, one untracked directory,
  relative specifiers only. Nothing here covers bare specifiers, `paths`
  mappings, npm or JSR targets, or a target reached through several hops.
- **`roots-pruned` is `exclude`, not `.use_gitignore()`.** See above.
- **"Absent" is one service's answer.** `orphan-in-ignored` shows the file was
  not offered as an auto-import. It does not show the file is absent from every
  service, and no LSP request returns the root set for the run to enumerate.
- The session settles for a fixed 4 seconds after `initialized` before the
  document is opened. A workspace large enough to still be walking would be
  measured mid-flight; these are small on purpose.

## Files

| path | role |
|---|---|
| `client.mjs` | a minimal LSP client that returns request results, which the shared driver in `../../harness/` does not |
| `cases.mjs` | the five workspaces and the two arms, materialised on disk |
| `run.mjs` | builds, drives, probes, prints |
| `evidence/graph-recovery.txt` | captured output |

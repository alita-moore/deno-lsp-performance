# The simulation library

What the models in [`../simulators/`](../simulators/README.md) and both arenas
are built on. Nothing here knows about deno or TypeScript; the semantics live in
the models.

| file | what it is |
|---|---|
| `fs.mjs` | the filesystem port. `realFS()` reads a tree on disk, `memFS(nodes)` an in-memory one. Every model is a pure function over this, which is why the same code runs against the 46 materialised workspaces and against a generated 488,919-directory repository |
| `glob.mjs` | TypeScript's glob dialect as an NFA over path segments: `parsePattern`, `start`, `step`, `accepts`, `alive`, `namesLiterally`. `alive` is the predicate defect 1's M5 is built on — whether a pattern can still match anything below a directory. Deno's dialect disagrees about `**` and is modelled separately, inside `../simulators/deno.mjs` |
| `config.mjs` | finding a workspace root and reading its members |
| `corpus.mjs` | the set of files a strategy is allowed to see, and which directories cover them |
| `order.mjs` | the injected directory-ordering policy. Only the identity policy is used |
| `realistic.mjs` | the workspace generator and the four presets — `small`, `medium`, `large`, `reported`. It writes a real `.gitignore`, places vendor trees inside glob-matched members, and `small` carries none, as the negative control |
| `metrics.mjs` | comparison and table-formatting helpers shared by the two arenas |

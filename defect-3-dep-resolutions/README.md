# Defect 3 — npm dependency resolutions are built eagerly, once per scope

`deno lsp` builds a `ConfiguredDepResolutions` for **every** resolver scope while
it is loading configuration. On the workspace measured here that is **73 scopes,
so 73 constructions**, each one resolving that scope's `package.json`
dependencies through the npm resolver, and most are never read: the structure
exists to answer `resource_url_to_configured_dep_key` and `deps_by_resolution`,
which are asked about the scopes the user is actually working in.

(73 is the number of workspace members the resolver builds a scope for. It is not
the "53-project" figure used elsewhere in this tree, which is the number of
project references the root `tsconfig.json` listed in the earliest run — a
different quantity, on a repository that changed between runs.)

The construction is unconditional, in `LspResolver`'s per-scope setup in
`cli/lsp/resolver.rs`:

```rust
let configured_dep_resolutions = (|| {
  let npm_pkg_req_resolver = npm_pkg_req_resolver.as_ref()?;
  Some(Arc::new(ConfiguredDepResolutions::new(
    workspace_resolver.clone(),
    config_data.and_then(|d| d.maybe_pkg_json().map(|p| p.as_ref())),
    npm_pkg_req_resolver,
    &pkg_json_resolver,
  )))
})()
.unwrap_or_default();
```

Nothing about it is conditional on the scope being used, and nothing about it is
shared between scopes. It runs inside config load, which is why it lands on
`lsp.did_change_configuration` rather than on any request the user made.

## The fix: hold it in a `OnceLock` and build it on first use

`configured_dep_resolutions: Arc<ConfiguredDepResolutions>` becomes
`Arc<OnceLock<Arc<ConfiguredDepResolutions>>>`, the eager block becomes
`Arc::new(OnceLock::new())`, and the two read sites go through an accessor that
does the construction under `get_or_init`. Every scope that is asked for gets
exactly the structure it would have got before; a scope that is never asked for
is never built.

**This is a real fix, not a skip.** The work is deferred and memoised, not
removed: the same `ConfiguredDepResolutions::new` runs with the same arguments,
at the first call rather than at config load, and once rather than once per
load. The results are unchanged by construction. The only observable difference
is *when* the cost is paid and how many scopes pay it.

It is the single biggest win in this study. `lsp.did_change_configuration` on the
53-project workspace goes from **41,504 ms to 1,871 ms** in the arm carrying it —
see [`../real-workspace/README.md`](../real-workspace/README.md) for the full
table, and for the reason that arm cannot separate this patch's share from M5's
and R1's, which sit under the same span.

## The patch

```
python3 apply-lazy.py /path/to/deno    # a v2.9.5 checkout
```

Six anchor-exact edits, all in `cli/lsp/resolver.rs`: the field type, the eager
construction, the two use sites, the `get_or_init` accessor, and the
`std::sync::OnceLock` import. It exits non-zero if any anchor is not found
exactly once rather than patching something else. Binaries carrying it were built
and measured; see [`../bin/README.md`](../bin/README.md).

## Against the recommendation

**Deferral moves latency, it does not delete it.** A scope built on first use is
built while a request is waiting rather than while configuration is loading. On
the measured workspace that is a large net win because most scopes are never
touched, and it would be a smaller one — in the limit, a wash — on a workspace
where the user visits every member.

**`OnceLock` fixes the value for the resolver's lifetime.** The eager field was
rebuilt whenever the resolver was rebuilt, and the lazy one still is, because the
`OnceLock` lives in the same structure. What changes is that a scope's
resolutions can now first be computed at an arbitrary later moment; anything that
assumed the structure was complete at the end of config load no longer holds.
Nothing measured here depends on that assumption, and nothing here proves nothing
does.

**No arm isolates it.** It was measured in combination with M5 and R1, never
alone.

**This defect bears on an existing report.**
[denoland/deno#36662](https://github.com/denoland/deno/issues/36662) — *"deno lsp:
same npm package folder resolved 744x per graph build when node_modules exists"* —
is about redundant npm package-folder resolution during graph building. Eager
per-scope construction is one source of repeated npm resolution work with no
consumer; whether it is the source that issue observed is not established here.

## Layout

| path | what it is |
|---|---|
| `apply-lazy.py` | the patch, applied to a deno v2.9.5 checkout |

import json, pathlib, shutil


def write(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2) + "\n")


def node_modules(root, count):
    for i in range(count):
        d = root / "node_modules" / f"lib-{i:03d}"
        write(d / "package.json", {"name": f"lib-{i:03d}", "version": "1.0.0",
                                   "main": "index.js", "types": "index.d.ts"})
        (d / "index.js").write_text("module.exports = { v: 1 };\n")
        (d / "index.d.ts").write_text("export declare const v: number;\n")


def member(root, rel, name, deno=True, pkg=True, tasks=True, deps=(), sources=0):
    d = root / rel
    d.mkdir(parents=True, exist_ok=True)
    if deno:
        j = {"name": name, "version": "0.0.1", "exports": "./mod.ts"}
        if tasks:
            j["tasks"] = {"t": "echo " + name}
        write(d / "deno.json", j)
    if pkg:
        j = {"name": name, "version": "0.0.1"}
        if deps:
            j["dependencies"] = {p: "1.0.0" for p in deps}
        write(d / "package.json", j)
    (d / "mod.ts").write_text("export const v = 1;\n")
    for i in range(sources):
        (d / f"src{i:03d}.ts").write_text("export const x = 1;\n")
    return d


def build(root, deno_workspace, npm_workspaces, members, deps=0, sources=0):
    root = pathlib.Path(root)
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    rj = {}
    if deno_workspace is not None:
        rj["workspace"] = deno_workspace
    write(root / "deno.json", rj)
    pj = {"name": "root", "private": True, "version": "0.0.0"}
    if npm_workspaces is not None:
        pj["workspaces"] = npm_workspaces
    write(root / "package.json", pj)
    node_modules(root, deps)
    names = [f"lib-{i:03d}" for i in range(deps)]
    for spec in members:
        member(root, spec["rel"], spec["name"],
               deno=spec.get("deno", True), pkg=spec.get("pkg", True),
               deps=names, sources=sources)
    (root / "entry.ts").write_text("export const entry = 1;\n")
    return root

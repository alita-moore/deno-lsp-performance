import json, pathlib, sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build import build

CASES = [
    dict(id="W1", title="npm-only member, not named by deno.json",
         deno=["packages/p00"], npm=["packages/*"],
         members=[dict(rel="packages/p00", name="@w/p00"),
                  dict(rel="packages/p01", name="@w/p01"),
                  dict(rel="packages/p02", name="@w/p02", deno=False)]),
    dict(id="W2", title="drift: member added to package.json coverage, deno.json not updated",
         deno=["packages/p00", "packages/p01"], npm=["packages/*"],
         members=[dict(rel="packages/p00", name="@w/p00"),
                  dict(rel="packages/p01", name="@w/p01"),
                  dict(rel="packages/p02", name="@w/p02")]),
    dict(id="W3", title="deno.json declares an empty workspace array",
         deno=[], npm=["packages/*"],
         members=[dict(rel="packages/p00", name="@w/p00"),
                  dict(rel="packages/p01", name="@w/p01")]),
    dict(id="W4", title="nested workspace: a declared member declares its own",
         deno=["packages/p00"], npm=["packages/*"],
         members=[dict(rel="packages/p00", name="@w/p00"),
                  dict(rel="packages/p00/sub/s0", name="@w/s0"),
                  dict(rel="packages/p01", name="@w/p01")],
         nested={"packages/p00": ["sub/s0"]}),
    dict(id="W5", title="deno.json names a member outside every npm glob",
         deno=["extras/e0"], npm=["packages/*"],
         members=[dict(rel="packages/p00", name="@w/p00"),
                  dict(rel="extras/e0", name="@w/e0")]),
    dict(id="W6", title="npm literal (non-glob) member, not named by deno.json",
         deno=["packages/p00"], npm=["packages/p00", "packages/p02"],
         members=[dict(rel="packages/p00", name="@w/p00"),
                  dict(rel="packages/p02", name="@w/p02")]),
    dict(id="W7", title="deno-only member (no package.json) inside an npm glob",
         deno=["packages/p00"], npm=["packages/*"],
         members=[dict(rel="packages/p00", name="@w/p00"),
                  dict(rel="packages/p02", name="@w/p02", pkg=False)]),
    dict(id="W7b", title="deno-only member named literally by package.json",
         deno=["packages/p00"], npm=["packages/p00", "packages/p02"],
         members=[dict(rel="packages/p00", name="@w/p00"),
                  dict(rel="packages/p02", name="@w/p02", pkg=False)]),
    dict(id="W8", title="no workspace field in deno.json at all",
         deno=None, npm=["packages/*"],
         members=[dict(rel="packages/p00", name="@w/p00"),
                  dict(rel="packages/p01", name="@w/p01")]),
    dict(id="W9", title="npm negation excludes a directory deno.json names",
         deno=["packages/p00", "packages/p02"], npm=["packages/*", "!packages/p02"],
         members=[dict(rel="packages/p00", name="@w/p00"),
                  dict(rel="packages/p01", name="@w/p01"),
                  dict(rel="packages/p02", name="@w/p02")]),
    dict(id="W10", title="deno.json member list is itself a glob",
         deno=["packages/p0*"], npm=["packages/*"],
         members=[dict(rel="packages/p00", name="@w/p00"),
                  dict(rel="packages/p01", name="@w/p01"),
                  dict(rel="packages/q00", name="@w/q00")]),
    dict(id="W11", title="deno.json names a member that has only a package.json",
         deno=["packages/p00", "packages/p02"], npm=["packages/*"],
         members=[dict(rel="packages/p00", name="@w/p00"),
                  dict(rel="packages/p02", name="@w/p02", deno=False)]),
    dict(id="W12", title="deno.json glob covers a member that has only a package.json",
         deno=["packages/*"], npm=["packages/*"],
         members=[dict(rel="packages/p00", name="@w/p00"),
                  dict(rel="packages/p02", name="@w/p02", deno=False)]),
]


def apply_nested(root, nested):
    for rel, subs in (nested or {}).items():
        p = pathlib.Path(root) / rel / "deno.json"
        j = json.loads(p.read_text())
        j["workspace"] = subs
        p.write_text(json.dumps(j, indent=2) + "\n")


def arm(root, deno_ws, npm_ws):
    d = pathlib.Path(root) / "deno.json"
    j = json.loads(d.read_text())
    j.pop("workspace", None)
    if deno_ws is not None:
        j["workspace"] = deno_ws
    d.write_text(json.dumps(j, indent=2) + "\n")
    p = pathlib.Path(root) / "package.json"
    k = json.loads(p.read_text())
    k.pop("workspaces", None)
    if npm_ws is not None:
        k["workspaces"] = npm_ws
    p.write_text(json.dumps(k, indent=2) + "\n")


def make(out, case):
    root = build(pathlib.Path(out) / case["id"], case["deno"], case["npm"], case["members"])
    apply_nested(root, case.get("nested"))
    return root
